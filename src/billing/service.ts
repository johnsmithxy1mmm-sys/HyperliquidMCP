/**
 * Billing service: turns a request's credentials (API key header and/or
 * X-PAYMENT header) into an `authorize(toolName)` gate for premium tools.
 *
 * Order of checks: valid pro key -> unlimited; valid free key -> monthly quota;
 * otherwise x402 pay-per-call. On denial, throws PaymentRequiredError carrying
 * x402 requirements + upgrade guidance so the agent knows exactly what to do.
 */
import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { PaymentRequiredError } from "../core/errors.js";
import {
  getDb,
  getKey,
  incrementUsage,
  monthlyTotal,
  upsertKey,
  disableMissingBootstrapKeys,
  getFreeKeyGrant,
  countFreeKeyGrants,
  recordFreeKeyGrant,
} from "./db.js";
import { tierFor, TIERS, type TierName } from "./tiers.js";
import { buildPaymentRequirements, verifyPayment } from "./x402.js";
import { log } from "../logger.js";

export interface RequestAuth {
  apiKey?: string;
  xPayment?: string;
}

/** Ceiling on distinct self-serve fingerprints, so the grants table is bounded. */
const MAX_SELF_SERVE_KEYS = 5_000;

export class BillingService {
  private readonly db: Database.Database;
  /** x402 is only operable with a payout address; otherwise it must stay off. */
  private readonly x402Ready: boolean;

  constructor(private readonly config: Config) {
    this.db = getDb(config.dbPath);
    this.bootstrapKeysFromEnv();
    this.x402Ready = config.x402.enabled && Boolean(config.x402.payTo);
    if (config.x402.enabled && !this.x402Ready) {
      log.warn("x402 enabled but X402_PAY_TO is not set; x402 flow disabled (would pay to zero address)");
    }
  }

  /**
   * Sync env-provisioned keys (comma-separated raw keys) into SQLite.
   * The env is the source of truth for bootstrap keys: keys REMOVED from the
   * env are revoked (disabled) — otherwise a "revoked" key would keep working
   * forever from a previous startup's upsert.
   */
  private bootstrapKeysFromEnv(): void {
    const present: string[] = [];
    const provision = (raw: string | undefined, tier: TierName) => {
      for (const k of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
        const h = this.hash(k);
        upsertKey(this.db, h, tier, `${tier}-bootstrap`);
        present.push(h);
      }
    };
    provision(process.env.HYPERSIGNAL_PRO_KEYS, "pro");
    provision(process.env.HYPERSIGNAL_FREE_KEYS, "free");
    const revoked = disableMissingBootstrapKeys(this.db, present);
    if (revoked > 0) log.info("revoked bootstrap keys removed from env", { revoked });
  }

  private hash(rawKey: string): string {
    return createHash("sha256").update(rawKey).digest("hex");
  }

  private period(): string {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  /**
   * Issue a self-serve free key to a client fingerprint (a hashed IP).
   *
   * Without this, the payment-required error advertises a free tier that has no
   * self-serve path — the requester is told the door is open and handed no key.
   *
   * Abuse bounds: exactly one ACTIVE free key per fingerprint (re-issuing
   * revokes the old one and carries its monthly usage across, so re-requesting
   * is not a quota reset), plus a global ceiling on distinct fingerprints so
   * the table cannot be grown without limit.
   */
  issueFreeKey(fingerprint: string): { rawKey: string; monthlyPremiumCalls: number; reissued: boolean } {
    const prior = getFreeKeyGrant(this.db, fingerprint);
    if (!prior && countFreeKeyGrants(this.db) >= MAX_SELF_SERVE_KEYS) {
      throw new Error(
        `Self-serve free keys are exhausted (${MAX_SELF_SERVE_KEYS} issued). Contact the operator for a key.`,
      );
    }
    const rawKey = `hs_free_${randomBytes(24).toString("base64url")}`;
    const keyHash = this.hash(rawKey);
    upsertKey(this.db, keyHash, "free", "self-serve");
    recordFreeKeyGrant(this.db, fingerprint, keyHash);
    log.info("self-serve free key issued", { reissued: Boolean(prior), grants: (prior?.grants ?? 0) + 1 });
    return {
      rawKey,
      monthlyPremiumCalls: TIERS.free.monthlyPremiumCalls ?? 0,
      reissued: Boolean(prior),
    };
  }

  /** Premium calls already used this period by the key behind `fingerprint`. */
  freeKeyUsage(fingerprint: string): number | null {
    const grant = getFreeKeyGrant(this.db, fingerprint);
    return grant ? monthlyTotal(this.db, grant.keyHash, this.period()) : null;
  }

  /** Stable per-key owner id for per-subject resources (alerts). "anon" if no valid key. */
  subjectFor(auth: RequestAuth): string {
    if (!auth.apiKey) return "anon";
    const row = getKey(this.db, this.hash(auth.apiKey));
    return row && !row.disabled ? row.keyHash : "anon";
  }

  /** Build a per-request authorize() closure. */
  authorizerFor(auth: RequestAuth): (toolName: string) => Promise<void> {
    return async (toolName: string) => {
      const keyRow = auth.apiKey ? getKey(this.db, this.hash(auth.apiKey)) : undefined;
      const tier = tierFor(keyRow && !keyRow.disabled ? keyRow.tier : "anonymous");

      // Pro: unlimited (still counted for analytics).
      if (tier.monthlyPremiumCalls === null && keyRow) {
        incrementUsage(this.db, keyRow.keyHash, this.period(), toolName);
        return;
      }

      // Free key with remaining quota.
      if (keyRow && tier.monthlyPremiumCalls !== null && tier.monthlyPremiumCalls > 0) {
        const used = monthlyTotal(this.db, keyRow.keyHash, this.period());
        if (used < tier.monthlyPremiumCalls) {
          incrementUsage(this.db, keyRow.keyHash, this.period(), toolName);
          return;
        }
      }

      // Fall back to x402 pay-per-call.
      if (this.x402Ready) {
        const requirements = buildPaymentRequirements(this.config, toolName);
        const result = await verifyPayment(this.config, this.db, auth.xPayment, requirements);
        if (result.ok) {
          log.info("x402 payment accepted", { toolName, paymentId: result.paymentId });
          return;
        }
        throw new PaymentRequiredError(
          `Payment required for premium tool "${toolName}". ` +
            `Pay per call via x402 (${this.config.x402.pricePerCallUsdc} ${this.config.x402.asset} on ${this.config.x402.network}) ` +
            `or use a Pro key ($${TIERS.pro.priceUsdMonth}/mo unlimited).`,
          { toolName, reason: result.reason, x402: requirements, upgrade: TIERS.pro.description },
        );
      }

      // No key / quota and x402 disabled. The message MUST carry a usable next
      // step: advertising a free tier with no way to obtain it is a dead end,
      // and a dead end here is where every new user is lost.
      const outOfQuota = Boolean(keyRow);
      throw new PaymentRequiredError(
        outOfQuota
          ? `Premium tool "${toolName}": this key's ${TIERS.free.monthlyPremiumCalls} free premium calls for the ` +
            `month are used up. Pro is unlimited at $${TIERS.pro.priceUsdMonth}/mo.`
          : `Premium tool "${toolName}" needs an API key. Call hl_request_free_key to get one instantly — ` +
            `it is free and grants ${TIERS.free.monthlyPremiumCalls} premium calls/month. ` +
            `Then retry this call with the key in the X-API-Key header.`,
        { toolName, tiers: TIERS, nextStep: outOfQuota ? "upgrade_to_pro" : "call hl_request_free_key" },
      );
    };
  }
}

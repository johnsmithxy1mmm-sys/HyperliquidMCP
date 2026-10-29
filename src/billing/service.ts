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
import { PaymentRequiredError, ToolError } from "../core/errors.js";
import {
  getDb,
  getKey,
  grantProKey,
  extendProKey,
  recordProPurchase,
  incrementUsage,
  decrementUsage,
  monthlyTotal,
  upsertKey,
  disableMissingBootstrapKeys,
  getFreeKeyGrant,
  countFreeKeyGrants,
  recordFreeKeyGrant,
} from "./db.js";
import { tierFor, TIERS, PRICING_URL, PRO_TERM_DAYS, type TierName } from "./tiers.js";
import { buildPaymentRequirements, verifyPayment } from "./x402.js";
import { log } from "../logger.js";

export interface RequestAuth {
  apiKey?: string;
  xPayment?: string;
}

/** A Pro purchase worked out before payment; `commit` runs only after the payment has settled. */
export interface ProPurchasePlan {
  /** The new key's raw value: only for a new key (a renewal keeps its own). */
  rawKey?: string;
  renewed: boolean;
  /** The new end of the term, as it stands now (a renewal's final value comes from `commit`). */
  expiresAt: number;
  /** Records the purchase and applies a renewal; returns the key's final end. */
  commit(): number;
}

const DAY_MS = 86_400_000;

/** Ceiling on distinct self-serve fingerprints, so the grants table is bounded. */
const MAX_SELF_SERVE_KEYS = 5_000;

/** One re-issue per requester per hour, so a request loop cannot churn keys and rows. */
const FREE_KEY_REISSUE_COOLDOWN_MS = 60 * 60_000;

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
    // Both lists empty is far more likely a secret lost on redeploy than an
    // operator revoking every customer at once; keep the keys and say so.
    if (present.length === 0) {
      log.warn("HYPERSIGNAL_PRO_KEYS and HYPERSIGNAL_FREE_KEYS are both empty; bootstrap keys left as they were");
      return;
    }
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
  issueFreeKey(
    fingerprint: string,
    now = Date.now(),
  ): { rawKey: string; monthlyPremiumCalls: number; reissued: boolean } {
    const prior = getFreeKeyGrant(this.db, fingerprint);
    if (prior && now - prior.grantedAt < FREE_KEY_REISSUE_COOLDOWN_MS) {
      const minutes = Math.ceil((prior.grantedAt + FREE_KEY_REISSUE_COOLDOWN_MS - now) / 60_000);
      throw new ToolError(
        "free_key_cooldown",
        `A free key was issued to you less than an hour ago. Use that key, or retry in ${minutes} min.`,
      );
    }
    if (!prior && countFreeKeyGrants(this.db) >= MAX_SELF_SERVE_KEYS) {
      throw new Error(
        `Self-serve free keys are exhausted (${MAX_SELF_SERVE_KEYS} issued). Contact the operator for a key.`,
      );
    }
    const rawKey = `hs_free_${randomBytes(24).toString("base64url")}`;
    const keyHash = this.hash(rawKey);
    upsertKey(this.db, keyHash, "free", "self-serve");
    recordFreeKeyGrant(this.db, fingerprint, keyHash, now);
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

  /**
   * Build a per-request authorize() closure. It returns what it charged: a key's
   * usage is counted now and refunded if the tool fails; an x402 payment is
   * reserved now and settled only once the tool has delivered.
   */
  authorizerFor(
    auth: RequestAuth,
  ): (toolName: string, opts?: { priceUsdc?: number }) => Promise<{ refund: () => void; settle?: () => Promise<void> } | undefined> {
    return async (toolName: string, opts?: { priceUsdc?: number }) => {
      // A purchase is paid for over x402, whatever keys or quota the caller holds.
      if (opts?.priceUsdc !== undefined) return this.purchaseCharge(auth, toolName, opts.priceUsdc);

      const keyRow = auth.apiKey ? getKey(this.db, this.hash(auth.apiKey)) : undefined;
      const expiredAt = keyRow && !keyRow.disabled && keyRow.expiresAt !== null && keyRow.expiresAt <= Date.now() ? keyRow.expiresAt : undefined;
      const renewHint =
        expiredAt === undefined
          ? ""
          : ` Your Pro key expired on ${new Date(expiredAt).toISOString().slice(0, 10)}; renew it with hl_buy_pro ` +
            `($${TIERS.pro.priceUsdMonth} USDC for ${PRO_TERM_DAYS} more days).`;
      const tier = tierFor(keyRow && !keyRow.disabled && expiredAt === undefined ? keyRow.tier : "anonymous");
      const period = this.period();
      const charge = (keyHash: string) => {
        incrementUsage(this.db, keyHash, period, toolName);
        return { refund: () => decrementUsage(this.db, keyHash, period, toolName) };
      };

      // Pro: unlimited (still counted for analytics).
      if (tier.monthlyPremiumCalls === null && keyRow) {
        return charge(keyRow.keyHash);
      }

      // Free key with remaining quota.
      if (keyRow && tier.monthlyPremiumCalls !== null && tier.monthlyPremiumCalls > 0) {
        const used = monthlyTotal(this.db, keyRow.keyHash, period);
        if (used < tier.monthlyPremiumCalls) {
          return charge(keyRow.keyHash);
        }
      }

      // Fall back to x402 pay-per-call.
      if (this.x402Ready) {
        const requirements = buildPaymentRequirements(this.config, toolName);
        const result = await verifyPayment(this.config, this.db, auth.xPayment, requirements);
        if (result.ok && result.charge) {
          log.info("x402 payment verified and reserved", { toolName });
          const { charge: payment } = result;
          return { refund: () => payment.release(), settle: () => payment.settle() };
        }
        throw new PaymentRequiredError(
          `Payment required for premium tool "${toolName}". ` +
            `Pay per call via x402 (${this.config.x402.pricePerCallUsdc} ${this.config.x402.asset} on ${this.config.x402.network}) ` +
            `or use a Pro key ($${TIERS.pro.priceUsdMonth}/mo unlimited; how to get one: ${PRICING_URL}).` +
            renewHint,
          { toolName, reason: result.reason, x402: requirements, upgrade: TIERS.pro.description },
        );
      }

      // No key / quota and x402 disabled. The message MUST carry a usable next
      // step: advertising a free tier with no way to obtain it is a dead end,
      // and a dead end here is where every new user is lost.
      const outOfQuota = Boolean(keyRow) && expiredAt === undefined;
      throw new PaymentRequiredError(
        expiredAt !== undefined
          ? `Premium tool "${toolName}":${renewHint} How to pay: ${PRICING_URL}`
          : outOfQuota
          ? `Premium tool "${toolName}": this key's ${TIERS.free.monthlyPremiumCalls} free premium calls for the ` +
            `month are used up. Pro is unlimited at $${TIERS.pro.priceUsdMonth}/mo; how to get it: ${PRICING_URL}`
          : `Premium tool "${toolName}" needs an API key. Call hl_request_free_key to get one instantly — ` +
            `it is free and grants ${TIERS.free.monthlyPremiumCalls} premium calls/month. ` +
            `Then retry this call with the key in the X-API-Key header.`,
        {
          toolName,
          tiers: TIERS,
          nextStep: expiredAt !== undefined ? "renew_pro" : outOfQuota ? "upgrade_to_pro" : "call hl_request_free_key",
        },
      );
    };
  }

  /** The Pro price in USDC: the tier price unless the operator overrides it. */
  private proPriceUsdc(): number {
    return this.config.x402.proPriceUsdc ?? TIERS.pro.priceUsdMonth;
  }

  /** x402 charge for a purchase: reserved now, settled once the tool has delivered. */
  private async purchaseCharge(auth: RequestAuth, toolName: string, priceUsdc: number) {
    if (!this.x402Ready) {
      throw new ToolError(
        "purchases_unavailable",
        `Buying Pro here needs x402 payments, which this server does not have switched on. How to get Pro: ${PRICING_URL}`,
      );
    }
    const requirements = buildPaymentRequirements(this.config, toolName, priceUsdc);
    const result = await verifyPayment(this.config, this.db, auth.xPayment, requirements);
    if (result.ok && result.charge) {
      log.info("x402 payment verified and reserved", { toolName });
      const { charge: payment } = result;
      return { refund: () => payment.release(), settle: () => payment.settle() };
    }
    throw new PaymentRequiredError(
      `${toolName} costs ${priceUsdc} ${this.config.x402.asset} on ${this.config.x402.network}, paid over x402. ` +
        `Pay and retry with the X-PAYMENT header. How to pay: ${PRICING_URL}`,
      { toolName, reason: result.reason, x402: requirements },
    );
  }

  /** Refuse, before any payment, a key a purchase cannot apply to (it never runs out, or the operator owns it). */
  assertProPurchasable(subject: string): void {
    const row = subject === "anon" ? undefined : getKey(this.db, subject);
    if (!row) return;
    if (row.label?.endsWith("-bootstrap")) {
      throw new ToolError(
        row.tier === "pro" ? "already_unlimited" : "operator_key",
        row.tier === "pro"
          ? "This Pro key has no end date: there is nothing to buy."
          : `This key was issued by the operator and cannot be bought up. How to get Pro: ${PRICING_URL}`,
      );
    }
  }

  /**
   * Work out a Pro purchase for `subject` (a key hash, or "anon" for a new key).
   * A new key is stored now: its raw value leaves only in the result, which is
   * withheld if the payment does not settle, so an unsettled one stays unusable.
   * A renewal is applied by `commit`, after settlement: the old key is known to
   * the caller, so extending it earlier would hand out time for a failed payment.
   */
  planProPurchase(subject: string, now = Date.now()): ProPurchasePlan {
    const termMs = PRO_TERM_DAYS * DAY_MS;
    const amountAtomic = Math.round(this.proPriceUsdc() * 1_000_000);
    const row = subject === "anon" ? undefined : getKey(this.db, subject);
    if (!row) {
      const rawKey = `hs_pro_${randomBytes(24).toString("base64url")}`;
      const keyHash = this.hash(rawKey);
      const expiresAt = now + termMs;
      grantProKey(this.db, keyHash, expiresAt);
      return {
        rawKey,
        renewed: false,
        expiresAt,
        commit: () => {
          recordProPurchase(this.db, keyHash, PRO_TERM_DAYS, amountAtomic, false);
          return expiresAt;
        },
      };
    }
    return {
      renewed: true,
      expiresAt: Math.max(now, row.expiresAt ?? 0) + termMs,
      commit: () => {
        const end = extendProKey(this.db, row.keyHash, termMs);
        recordProPurchase(this.db, row.keyHash, PRO_TERM_DAYS, amountAtomic, true);
        return end;
      },
    };
  }
}

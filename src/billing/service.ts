/**
 * Billing service: turns a request's credentials (API key header and/or
 * X-PAYMENT header) into an `authorize(toolName)` gate for premium tools.
 *
 * Order of checks: valid pro key -> unlimited; valid free key -> monthly quota;
 * otherwise x402 pay-per-call. On denial, throws PaymentRequiredError carrying
 * x402 requirements + upgrade guidance so the agent knows exactly what to do.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { PaymentRequiredError } from "../core/errors.js";
import { getDb, getKey, incrementUsage, monthlyTotal, upsertKey } from "./db.js";
import { tierFor, TIERS, type TierName } from "./tiers.js";
import { buildPaymentRequirements, verifyPayment } from "./x402.js";
import { log } from "../logger.js";

export interface RequestAuth {
  apiKey?: string;
  xPayment?: string;
}

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

  /** Upsert operator-provisioned keys from env (comma-separated raw keys). */
  private bootstrapKeysFromEnv(): void {
    const provision = (raw: string | undefined, tier: TierName) => {
      for (const k of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
        upsertKey(this.db, this.hash(k), tier, `${tier}-bootstrap`);
      }
    };
    provision(process.env.HYPERSIGNAL_PRO_KEYS, "pro");
    provision(process.env.HYPERSIGNAL_FREE_KEYS, "free");
  }

  private hash(rawKey: string): string {
    return createHash("sha256").update(rawKey).digest("hex");
  }

  private period(): string {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
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

      // No key / quota and x402 disabled.
      throw new PaymentRequiredError(
        `Premium tool "${toolName}" requires a valid API key. ` +
          `Free keys get ${TIERS.free.monthlyPremiumCalls} premium calls/month; Pro is unlimited at $${TIERS.pro.priceUsdMonth}/mo.`,
        { toolName, tiers: TIERS },
      );
    };
  }
}

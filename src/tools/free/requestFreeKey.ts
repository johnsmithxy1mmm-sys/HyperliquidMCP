import { z } from "zod";
import { createHash } from "node:crypto";
import type { ToolDef } from "../registry.js";
import { ToolError } from "../../core/errors.js";
import { TIERS } from "../../billing/tiers.js";

/**
 * Self-serve free key.
 *
 * The premium gate used to advertise a free tier with no way to obtain one:
 * an agent hit "requires an API key", found no signup, and left. Every new
 * user was lost at exactly that step. This closes the loop — an agent can go
 * from discovery to a working premium call in one extra tool call, with no
 * human in the loop on either side.
 *
 * Free (and must stay free): a gate on the way to getting past the gate would
 * be the same dead end wearing a different label.
 */
export const requestFreeKey: ToolDef = {
  name: "hl_request_free_key",
  tier: "free",
  title: "Get a free API key",
  description:
    "Issue yourself a free API key, instantly and with no signup. The key grants " +
    `${TIERS.free.monthlyPremiumCalls} premium calls per month — enough to evaluate every premium tool. ` +
    "Send it as the X-API-Key header on later requests. Call this first if a premium tool says it needs a key. " +
    "One active key per requester: calling again replaces the previous key and keeps the same monthly usage, " +
    "so it is safe to call if you lost your key but is not a way to reset the quota.",
  inputSchema: {
    acknowledge: z
      .boolean()
      .default(true)
      .describe("Acknowledges that analytics are informational and not investment advice."),
  },
  outputSchema: {
    apiKey: z.string(),
    tier: z.string(),
    monthlyPremiumCalls: z.number(),
    usedThisMonth: z.number(),
    reissued: z.boolean(),
    header: z.string(),
    upgrade: z.string(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  run: async (_args, ctx) => {
    if (ctx.mode !== "http" || !ctx.billing) {
      throw new ToolError(
        "not_applicable",
        "Free keys are only meaningful on the remote HTTP server. In local stdio mode there is no metering — " +
          "set HL_STDIO_INCLUDE_PREMIUM=true to use premium tools locally without any key.",
      );
    }
    // Hash the IP: the fingerprint only ever needs to be comparable, never
    // readable, so the raw address is not stored.
    const fingerprint = createHash("sha256")
      .update(ctx.clientIp ?? "unknown")
      .digest("hex");

    let issued: { rawKey: string; monthlyPremiumCalls: number; reissued: boolean };
    try {
      issued = ctx.billing.issueFreeKey(fingerprint);
    } catch (err) {
      throw new ToolError("free_keys_exhausted", err instanceof Error ? err.message : String(err));
    }
    const usedThisMonth = ctx.billing.freeKeyUsage(fingerprint) ?? 0;

    return {
      summary:
        `${issued.reissued ? "Replaced your previous free key" : "Free API key issued"}: ${issued.rawKey}\n` +
        `Send it as the header  X-API-Key: ${issued.rawKey}\n` +
        `${issued.monthlyPremiumCalls} premium calls/month (${usedThisMonth} already used this month). ` +
        `Store it now — it is shown once and cannot be retrieved later.`,
      data: {
        apiKey: issued.rawKey,
        tier: "free",
        monthlyPremiumCalls: issued.monthlyPremiumCalls,
        usedThisMonth,
        reissued: issued.reissued,
        header: `X-API-Key: ${issued.rawKey}`,
        upgrade: `Unlimited premium: $${TIERS.pro.priceUsdMonth}/month (Pro), or pay-per-call via x402.`,
      },
    };
  },
};

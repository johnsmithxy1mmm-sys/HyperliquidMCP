import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { ToolError } from "../../core/errors.js";
import { PRICING_URL, PRO_TERM_DAYS, TIERS } from "../../billing/tiers.js";
import { log } from "../../logger.js";

const iso = (ms: number): string => new Date(ms).toISOString();

export const buyPro: ToolDef = {
  name: "hl_buy_pro",
  tier: "free",
  remoteOnly: true,
  title: "Buy Pro (x402)",
  description:
    `Buy ${PRO_TERM_DAYS} days of Pro (unlimited premium calls) for $${TIERS.pro.priceUsdMonth} in USDC, paid over x402 on Base. ` +
    "Without an X-API-Key it issues a new Pro key; with one it renews that key (a free key is upgraded in place), " +
    `adding ${PRO_TERM_DAYS} days to its current end. The first call answers with the payment requirements; pay and retry ` +
    "with the X-PAYMENT header. The payment is taken only once the key is ready. No automatic refunds. " +
    `How to pay: ${PRICING_URL}`,
  inputSchema: {},
  outputSchema: {
    tier: z.string(),
    renewed: z.boolean(),
    expiresAt: z.string(),
    daysAdded: z.number(),
    apiKey: z.string().optional(),
    header: z.string().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  payOnly: {
    priceUsdc: (ctx) => ctx.config.x402.proPriceUsdc ?? TIERS.pro.priceUsdMonth,
    precheck: (ctx) => ctx.billing?.assertProPurchasable(ctx.subject),
  },
  run: async (_args, ctx) => {
    if (ctx.mode !== "http" || !ctx.billing) {
      throw new ToolError("not_applicable", "Pro is bought on the remote HTTP server; local stdio has no metering.");
    }
    const plan = ctx.billing.planProPurchase(ctx.subject);
    const data = {
      tier: "pro",
      renewed: plan.renewed,
      expiresAt: iso(plan.expiresAt),
      daysAdded: PRO_TERM_DAYS,
      ...(plan.rawKey ? { apiKey: plan.rawKey, header: `X-API-Key: ${plan.rawKey}` } : {}),
    };
    return {
      summary: plan.rawKey
        ? `Pro key issued for ${PRO_TERM_DAYS} days. Send it as X-API-Key. Keep it: it is shown only once.`
        : `Pro extended by ${PRO_TERM_DAYS} days.`,
      data,
      onDelivered: () => {
        data.expiresAt = iso(plan.commit());
        log.info("pro purchase settled", { renewed: plan.renewed, days: PRO_TERM_DAYS });
      },
    };
  },
};

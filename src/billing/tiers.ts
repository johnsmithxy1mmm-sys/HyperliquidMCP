/**
 * Tier definitions and monthly premium-call limits. Prices are informational
 * (billing/collection happens out-of-band or via x402); the server only meters.
 */

export type TierName = "anonymous" | "free" | "pro";

/** Where a buyer finds out how to pay: every message that quotes a price points here. */
export const PRICING_URL = "https://github.com/johnsmithxy1mmm-sys/HyperliquidMCP#pricing";

const PRO_PRICE_USD_MONTH = 29;

/** One Pro purchase buys this many days, added to the key's current end. */
export const PRO_TERM_DAYS = 30;

export interface TierConfig {
  name: TierName;
  /** Monthly premium-call allowance; null = unlimited. */
  monthlyPremiumCalls: number | null;
  priceUsdMonth: number;
  description: string;
}

export const TIERS: Record<TierName, TierConfig> = {
  anonymous: {
    name: "anonymous",
    monthlyPremiumCalls: 0,
    priceUsdMonth: 0,
    description: "No API key: free-tier market data only. Premium requires a key or x402 payment.",
  },
  free: {
    name: "free",
    monthlyPremiumCalls: 100,
    priceUsdMonth: 0,
    description: "Free demo key: 100 premium calls/month.",
  },
  pro: {
    name: "pro",
    monthlyPremiumCalls: null,
    priceUsdMonth: PRO_PRICE_USD_MONTH,
    description: `Pro: unlimited analytics for $${PRO_PRICE_USD_MONTH}/month. How to get it: ${PRICING_URL}`,
  },
};

export function tierFor(name: string | undefined | null): TierConfig {
  if (name && name in TIERS) return TIERS[name as TierName];
  return TIERS.anonymous;
}

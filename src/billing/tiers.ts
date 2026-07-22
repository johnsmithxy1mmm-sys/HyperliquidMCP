/**
 * Tier definitions and monthly premium-call limits. Prices are informational
 * (billing/collection happens out-of-band or via x402); the server only meters.
 */

export type TierName = "anonymous" | "free" | "pro";

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
    priceUsdMonth: 19,
    description: "Pro: unlimited analytics for $19/month.",
  },
};

export function tierFor(name: string | undefined | null): TierConfig {
  if (name && name in TIERS) return TIERS[name as TierName];
  return TIERS.anonymous;
}

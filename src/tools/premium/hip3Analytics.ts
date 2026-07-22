import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { getMarketRows } from "../../hl/markets.js";
import { round, paginate } from "../../core/format.js";
import { ANALYTICS_DISCLAIMER } from "../../hl/whales.js";

/**
 * HIP-3 markets are builder-deployed perps (RWA / equity-style), identified by a
 * "dex:coin" naming convention. Reports their volume/OI/funding and, when a
 * spot reference price is supplied, the basis vs that external reference.
 */
export const hip3Analytics: ToolDef = {
  name: "hl_hip3_analytics",
  tier: "premium",
  title: "HIP-3 market analytics",
  description:
    "Analytics for HIP-3 (builder-deployed) perp markets such as RWA/equity perps: volume, open interest, funding, " +
    "and spread. Optionally pass `spotRefs` (coin→external spot price) to compute basis vs an external reference. " +
    ANALYTICS_DISCLAIMER,
  inputSchema: {
    dex: z.string().optional().describe("Filter by builder-dex prefix (the part before ':' in the market name)."),
    spotRefs: z
      .record(z.number())
      .optional()
      .describe("Optional map of coin symbol -> external spot price for basis calculation."),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(200).default(50),
  },
  outputSchema: {
    hip3MarketCount: z.number(),
    markets: z.array(z.record(z.any())),
    nextOffset: z.number().nullable(),
    disclaimer: z.string(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  run: async (args, ctx) => {
    const dexFilter = (args.dex as string | undefined)?.toLowerCase();
    const spotRefs = (args.spotRefs as Record<string, number> | undefined) ?? {};

    const rows = await getMarketRows(ctx.hl);
    let hip3 = rows.filter((r) => r.isHip3);
    if (dexFilter) hip3 = hip3.filter((r) => r.coin.toLowerCase().startsWith(`${dexFilter}:`));

    const markets = hip3.map((r) => {
      const dex = r.coin.includes(":") ? r.coin.split(":")[0] : null;
      const ref = spotRefs[r.coin] ?? spotRefs[r.coin.split(":").pop() ?? r.coin];
      const basisPct = ref && ref > 0 ? round(((r.markPx - ref) / ref) * 100, 4) : null;
      return {
        coin: r.coin,
        dex,
        markPx: r.markPx,
        oraclePx: r.oraclePx,
        fundingAprPct: round(r.fundingApr * 100, 2),
        openInterestUsd: round(r.openInterest * r.markPx, 0),
        dayNtlVlm: round(r.dayNtlVlm, 0),
        change24hPct: round(r.change24hPct * 100, 2),
        maxLeverage: r.maxLeverage,
        externalSpotRef: ref ?? null,
        basisPct,
      };
    });
    markets.sort((a, b) => b.dayNtlVlm - a.dayNtlVlm);
    const page = paginate(markets, args.offset as number, args.limit as number);

    return {
      summary:
        hip3.length === 0
          ? "No HIP-3 markets detected in the current universe."
          : `${hip3.length} HIP-3 markets. Top by volume: ${page.items.slice(0, 3).map((m) => m.coin).join(", ")}.`,
      data: {
        hip3MarketCount: hip3.length,
        markets: page.items,
        nextOffset: page.nextOffset,
        disclaimer: ANALYTICS_DISCLAIMER,
      },
    };
  },
};

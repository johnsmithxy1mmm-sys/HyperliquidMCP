import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { resolveCohort } from "../../hl/cohort.js";
import { fetchCohortAccounts, ANALYTICS_DISCLAIMER } from "../../hl/whales.js";
import { resolveMarket } from "../../hl/markets.js";
import { round } from "../../core/format.js";

/**
 * Estimates liquidation clusters for a coin from the cohort's open positions:
 * bins each position's liquidation price (from clearinghouseState) by distance
 * from mark and sums notional at risk, surfacing the nearest cascade levels.
 * Coverage is limited to the provided cohort — it is an estimate, not the
 * exchange-wide liquidation book.
 */
export const liquidationMap: ToolDef = {
  name: "hl_liquidation_map",
  tier: "premium",
  title: "Liquidation cluster map",
  description:
    "Estimated liquidation clusters for a coin from a whale cohort's open positions: distribution of liquidation " +
    "prices and notional-at-risk bucketed by % distance from mark, plus nearest downside/upside cascade levels. " +
    "Estimate over the cohort only (not exchange-wide). " +
    ANALYTICS_DISCLAIMER,
  inputSchema: {
    coin: z.string().describe("Perp coin symbol."),
    cohort: z.array(z.string()).optional(),
    topN: z.number().int().min(1).max(200).default(100),
    bucketPct: z.number().min(0.5).max(20).default(2).describe("Bucket width as % of mark price."),
    maxDistancePct: z.number().min(1).max(90).default(30).describe("Ignore liq prices beyond this % from mark."),
  },
  outputSchema: {
    coin: z.string(),
    markPx: z.number(),
    walletsQueried: z.number(),
    positionsConsidered: z.number(),
    totalNotionalAtRiskUsd: z.number(),
    nearestDownsideCluster: z.record(z.any()).nullable(),
    nearestUpsideCluster: z.record(z.any()).nullable(),
    buckets: z.array(z.record(z.any())),
    disclaimer: z.string(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  run: async (args, ctx) => {
    const coinArg = String(args.coin);
    const topN = (args.topN as number) ?? 100;
    const bucketPct = (args.bucketPct as number) ?? 2;
    const maxDistancePct = (args.maxDistancePct as number) ?? 30;

    const market = await resolveMarket(ctx.hl, coinArg);
    const mark = market.markPx;
    const cohort = await resolveCohort(ctx, args.cohort as string[] | undefined, topN);
    const accounts = await fetchCohortAccounts(ctx, cohort.addresses);

    interface Bin {
      lowPct: number;
      highPct: number;
      side: "downside" | "upside";
      notionalUsd: number;
      positions: number;
      pxLow: number;
      pxHigh: number;
    }
    const bins = new Map<string, Bin>();
    let considered = 0;
    let totalNotional = 0;

    for (const { account } of accounts) {
      for (const p of account.positions) {
        if (p.coin !== market.coin || p.liquidationPx === null || p.liquidationPx <= 0) continue;
        const distPct = ((p.liquidationPx - mark) / mark) * 100;
        if (Math.abs(distPct) > maxDistancePct) continue;
        considered += 1;
        const notional = Math.abs(p.positionValueUsd);
        totalNotional += notional;
        const side: "downside" | "upside" = distPct < 0 ? "downside" : "upside";
        const bucketIndex = Math.floor(Math.abs(distPct) / bucketPct);
        const lowPct = bucketIndex * bucketPct;
        const highPct = lowPct + bucketPct;
        const key = `${side}:${bucketIndex}`;
        const bin =
          bins.get(key) ??
          ({
            lowPct,
            highPct,
            side,
            notionalUsd: 0,
            positions: 0,
            pxLow: side === "downside" ? mark * (1 - highPct / 100) : mark * (1 + lowPct / 100),
            pxHigh: side === "downside" ? mark * (1 - lowPct / 100) : mark * (1 + highPct / 100),
          } satisfies Bin);
        bin.notionalUsd += notional;
        bin.positions += 1;
        bins.set(key, bin);
      }
    }

    const buckets = [...bins.values()]
      .map((b) => ({
        side: b.side,
        distanceFromMarkPct: `${b.lowPct}-${b.highPct}%`,
        priceRange: [round(b.pxLow, 6), round(b.pxHigh, 6)] as [number, number],
        notionalUsd: round(b.notionalUsd, 2),
        positions: b.positions,
      }))
      .sort((a, b) => b.notionalUsd - a.notionalUsd);

    const downside = buckets.filter((b) => b.side === "downside").sort((a, b) => b.priceRange[1] - a.priceRange[1]);
    const upside = buckets.filter((b) => b.side === "upside").sort((a, b) => a.priceRange[0] - b.priceRange[0]);

    return {
      summary:
        `${market.coin} liq map (mark $${round(mark, 6)}, ${considered} positions from ${accounts.length} wallets): ` +
        `$${round(totalNotional, 0)} at risk within ±${maxDistancePct}%.`,
      data: {
        coin: market.coin,
        markPx: round(mark, 6),
        walletsQueried: accounts.length,
        positionsConsidered: considered,
        totalNotionalAtRiskUsd: round(totalNotional, 2),
        nearestDownsideCluster: downside[0] ?? null,
        nearestUpsideCluster: upside[0] ?? null,
        buckets,
        disclaimer: ANALYTICS_DISCLAIMER,
      },
    };
  },
};

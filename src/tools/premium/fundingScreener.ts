import { z } from "zod";
import type { ToolDef } from "../registry.js";
import type { HyperliquidClient } from "../../core/hlClient.js";
import { getMarketRows } from "../../hl/markets.js";
import { round, paginate } from "../../core/format.js";
import { ANALYTICS_DISCLAIMER } from "../../hl/whales.js";

/**
 * Screens all perp markets by annualized funding. Surfaces the biggest
 * absolute funding (carry candidates) and, when available, cross-venue
 * predicted-funding spreads for delta-neutral / basis strategies.
 */
export const fundingScreener: ToolDef = {
  name: "hl_funding_screener",
  tier: "premium",
  title: "Funding rate screener",
  description:
    "Screen every Hyperliquid perp by annualized funding: top markets by absolute funding (carry candidates), " +
    "sign (longs-pay vs shorts-pay), and — when predictedFundings is available — cross-venue funding spreads for " +
    "delta-neutral strategies. Filter by min |APR| and OI/volume. " +
    ANALYTICS_DISCLAIMER,
  inputSchema: {
    minAbsApr: z.number().min(0).default(0.05).describe("Minimum |annualized funding| as a fraction (0.05 = 5% APR)."),
    minOpenInterestUsd: z.number().min(0).default(0).describe("Filter out thin markets below this OI (USD)."),
    side: z.enum(["all", "longs_pay", "shorts_pay"]).default("all"),
    includeVenueSpreads: z.boolean().default(true).describe("Include cross-venue predicted funding spreads if available."),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(200).default(30),
  },
  outputSchema: {
    scannedMarkets: z.number(),
    matched: z.number(),
    results: z.array(z.record(z.any())),
    venueSpreads: z.array(z.record(z.any())),
    nextOffset: z.number().nullable(),
    disclaimer: z.string(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  run: async (args, ctx) => {
    const minAbsApr = (args.minAbsApr as number) ?? 0.05;
    const minOi = (args.minOpenInterestUsd as number) ?? 0;
    const side = (args.side as "all" | "longs_pay" | "shorts_pay") ?? "all";
    const includeVenueSpreads = args.includeVenueSpreads !== false;

    const rows = await getMarketRows(ctx.hl);
    let matched = rows
      .filter((r) => !r.isDelisted)
      .filter((r) => Math.abs(r.fundingApr) >= minAbsApr)
      .filter((r) => r.openInterest * r.markPx >= minOi)
      .filter((r) => {
        if (side === "longs_pay") return r.fundingHourly > 0;
        if (side === "shorts_pay") return r.fundingHourly < 0;
        return true;
      })
      .map((r) => ({
        coin: r.coin,
        fundingHourly: round(r.fundingHourly, 8),
        fundingApr: round(r.fundingApr, 4),
        fundingAprPct: round(r.fundingApr * 100, 2),
        whoPays: r.fundingHourly >= 0 ? "longs_pay_shorts" : "shorts_pay_longs",
        openInterestUsd: round(r.openInterest * r.markPx, 0),
        dayNtlVlm: round(r.dayNtlVlm, 0),
      }));

    matched.sort((a, b) => Math.abs(b.fundingApr) - Math.abs(a.fundingApr));
    const page = paginate(matched, args.offset as number, args.limit as number);

    let venueSpreads: Array<Record<string, unknown>> = [];
    if (includeVenueSpreads) {
      venueSpreads = await computeVenueSpreads(ctx.hl);
    }

    const top = page.items[0];
    return {
      summary:
        `${matched.length}/${rows.length} markets with |funding| ≥ ${round(minAbsApr * 100, 2)}% APR` +
        (top ? `. Extreme: ${top.coin} ${top.fundingAprPct}% APR (${top.whoPays}).` : "."),
      data: {
        scannedMarkets: rows.length,
        matched: matched.length,
        results: page.items,
        venueSpreads,
        nextOffset: page.nextOffset,
        disclaimer: ANALYTICS_DISCLAIMER,
      },
    };
  },
};

async function computeVenueSpreads(hl: HyperliquidClient): Promise<Array<Record<string, unknown>>> {
  try {
    const pf = await hl.predictedFundings();
    const out: Array<Record<string, unknown>> = [];
    for (const [coin, venues] of pf) {
      const rates = venues
        .map(([venue, data]) => {
          if (!data) return null;
          const raw = Number(data.fundingRate);
          if (!Number.isFinite(raw)) return null;
          // Normalize to an HOURLY rate: venues report per their own funding
          // interval (Hyperliquid 1h; most CEX perps 8h). Comparing raw rates
          // across intervals would overstate 8h venues by up to 8x.
          const hours = data.fundingIntervalHours ?? (venue === "HlPerp" ? 1 : 8);
          return { venue, hourly: raw / Math.max(1, hours) };
        })
        .filter((x): x is { venue: string; hourly: number } => x !== null);
      if (rates.length < 2) continue;
      rates.sort((a, b) => b.hourly - a.hourly);
      const hi = rates[0];
      const lo = rates[rates.length - 1];
      const spreadApr = (hi.hourly - lo.hourly) * 24 * 365;
      out.push({
        coin,
        maxVenue: hi.venue,
        minVenue: lo.venue,
        spreadAprPct: round(spreadApr * 100, 2),
        venues: rates.map((r) => ({ venue: r.venue, aprPct: round(r.hourly * 24 * 365 * 100, 2) })),
      });
    }
    out.sort((a, b) => Math.abs(Number(b.spreadAprPct)) - Math.abs(Number(a.spreadAprPct)));
    return out.slice(0, 20);
  } catch {
    return [];
  }
}

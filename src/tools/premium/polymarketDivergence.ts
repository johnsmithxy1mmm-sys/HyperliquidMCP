import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { resolveMarket } from "../../hl/markets.js";
import { num, round } from "../../core/format.js";
import { ANALYTICS_DISCLAIMER } from "../../hl/whales.js";
import { PolymarketClient } from "../../polymarket/client.js";
import { annualizedVol, impliedProbForMode } from "../../polymarket/pricing.js";
import { parseThresholdMarket, yearsToExpiry } from "../../polymarket/parse.js";

const INTERVAL_PERIODS: Record<string, number> = {
  "1h": 24 * 365,
  "4h": 6 * 365,
  "1d": 365,
};

/**
 * Hyperliquid ↔ Polymarket divergence: for each Polymarket price-threshold
 * market on the coin, compute the probability implied by Hyperliquid (current
 * price + realized volatility) and compare it to the market's odds. A large gap
 * is a cross-market edge signal — the intersection of a perp DEX and a
 * prediction market that no other MCP offers.
 */
export const polymarketDivergence: ToolDef = {
  name: "hl_polymarket_divergence",
  tier: "premium",
  title: "Polymarket ↔ Hyperliquid divergence",
  description:
    "Compare Polymarket price-threshold odds for a coin (e.g. 'BTC above $100k by date') against the probability " +
    "implied by Hyperliquid's price + realized volatility. Surfaces cross-market mispricings ranked by edge. " +
    "Optionally use perp funding as drift. Estimate under lognormal dynamics. " +
    ANALYTICS_DISCLAIMER,
  inputSchema: {
    coin: z.string().describe("Perp coin symbol, e.g. 'BTC'."),
    volInterval: z.enum(["1h", "4h", "1d"]).default("1d"),
    volWindowDays: z.number().int().min(2).max(365).default(30).describe("Lookback for realized volatility."),
    useFundingDrift: z.boolean().default(false).describe("Use annualized funding as the drift term."),
    minEdge: z.number().min(0).max(1).default(0.05).describe("Min |Polymarket − HL| probability gap to report."),
    limit: z.number().int().min(1).max(100).default(20),
  },
  outputSchema: {
    coin: z.string(),
    spot: z.number(),
    annualizedVol: z.number(),
    driftUsed: z.number(),
    marketsScanned: z.number(),
    divergences: z.array(z.record(z.any())),
    note: z.string(),
    disclaimer: z.string(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  run: async (args, ctx) => {
    const market = await resolveMarket(ctx.hl, String(args.coin));
    const interval = (args.volInterval as string) ?? "1d";
    const volWindowDays = (args.volWindowDays as number) ?? 30;
    const minEdge = (args.minEdge as number) ?? 0.05;

    // Realized volatility from Hyperliquid candles. endTime bucketed to 60s so
    // repeated scans reuse the candle cache instead of refetching.
    const endTime = Math.floor(Date.now() / 60_000) * 60_000;
    const startTime = endTime - volWindowDays * 86_400_000;
    const candles = await ctx.hl.candles(market.coin, interval, startTime, endTime);
    const closes = candles.sort((a, b) => a.t - b.t).map((c) => num(c.c));
    const sigma = annualizedVol(closes, INTERVAL_PERIODS[interval] ?? 365);
    const drift = args.useFundingDrift === true ? market.fundingApr : 0;
    const S = market.markPx;

    const client = new PolymarketClient(ctx.config);
    const pmMarkets = await client.activeMarkets();

    const now = Date.now();
    const divergences = pmMarkets
      .map((pm) => {
        const parsed = parseThresholdMarket(pm.question);
        if (!parsed || parsed.coin !== market.coin || pm.yesProb === null) return null;
        const tYears = yearsToExpiry(pm.endDate, now);
        if (tYears <= 0) return null;
        const hlProb = impliedProbForMode(parsed.mode, S, parsed.thresholdUsd, tYears, sigma, drift);
        const edge = pm.yesProb - hlProb;
        return {
          question: pm.question,
          slug: pm.slug,
          endDate: pm.endDate,
          thresholdUsd: parsed.thresholdUsd,
          mode: parsed.mode,
          polymarketYesProb: round(pm.yesProb, 4),
          hlImpliedProb: round(hlProb, 4),
          edge: round(edge, 4),
          signal:
            edge > 0
              ? "polymarket_yes_rich_vs_hl (fade Yes / HL model less bullish)"
              : "polymarket_yes_cheap_vs_hl (Yes underpriced vs HL model)",
          liquidityUsd: round(pm.liquidityUsd, 0),
        };
      })
      .filter((d): d is NonNullable<typeof d> => d !== null && Math.abs(d.edge) >= minEdge)
      .sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge))
      .slice(0, args.limit as number);

    const note =
      pmMarkets.length === 0
        ? "No Polymarket markets returned (endpoint unreachable or empty). Divergence needs live Polymarket data."
        : "Lognormal estimate from HL price + realized vol; 'touch' uses a one-touch barrier. Not a guarantee.";

    const top = divergences[0];
    return {
      summary:
        `${market.coin}: scanned ${pmMarkets.length} Polymarket markets, ` +
        `${divergences.length} divergence(s) ≥ ${round(minEdge * 100, 0)}pp (vol ${round(sigma * 100, 1)}%).` +
        (top ? ` Top: "${top.question.slice(0, 60)}" edge ${round(top.edge * 100, 1)}pp.` : ""),
      data: {
        coin: market.coin,
        spot: S,
        annualizedVol: round(sigma, 4),
        driftUsed: round(drift, 4),
        marketsScanned: pmMarkets.length,
        divergences,
        note,
        disclaimer: ANALYTICS_DISCLAIMER,
      },
    };
  },
};

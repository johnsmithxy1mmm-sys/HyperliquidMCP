import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { resolveMarket } from "../../hl/markets.js";
import { num, round } from "../../core/format.js";
import { ANALYTICS_DISCLAIMER } from "../../hl/whales.js";
import { PolymarketClient } from "../../polymarket/client.js";
import { annualizedVol, impliedProbForMode } from "../../polymarket/pricing.js";
import { parseThresholdMarket, yearsToExpiry, isPlausibleThreshold } from "../../polymarket/parse.js";
import { findLadderViolations, dedupeLadderEntries, type LadderEntry } from "../../polymarket/coherence.js";

const INTERVAL_PERIODS: Record<string, number> = {
  "1h": 24 * 365,
  "4h": 6 * 365,
  "1d": 365,
};

/**
 * Realized vol is one number estimated from one lookback window; treating it
 * as exact overstates the model's precision badly (a ±20% relative vol change
 * moved a mid-ladder touch estimate by 25pp in testing against a live ladder).
 * Every probability therefore ships with the range it spans across this band.
 */
const VOL_BAND = 0.2;

/**
 * A diffusion model cannot represent jump risk: at extreme thresholds it
 * asserts ~0% while the market prices a real 1-2% tail. There the MARKET is
 * the better-informed side, and the "edge" is a model artifact — rows in that
 * regime carry an explicit caveat instead of a confident number.
 */
const JUMP_BLIND_MODEL_MAX = 0.005;
const JUMP_BLIND_MARKET_MIN = 0.01;

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
    "implied by Hyperliquid's price + realized volatility. Surfaces cross-market mispricings ranked by edge, " +
    "checks the market's own price ladder for logically impossible orderings (P(further threshold) > P(nearer)), " +
    "collapses duplicate contract listings, and reports each estimate's sensitivity to the volatility input. " +
    "Rows where a diffusion model is out of its depth (extreme tails the market prices but a no-jump model cannot) " +
    "are flagged, not asserted. Optionally use perp funding as drift. Estimate under lognormal dynamics. " +
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
    volBand: z.record(z.any()),
    driftUsed: z.number(),
    marketsScanned: z.number(),
    skippedImplausible: z.number(),
    duplicatesCollapsed: z.number(),
    ladderViolations: z.array(z.record(z.any())),
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
    // Copy: `candles` is the cached array (shared by reference across requests).
    const closes = [...candles].sort((a, b) => a.t - b.t).map((c) => num(c.c));
    const sigma = annualizedVol(closes, INTERVAL_PERIODS[interval] ?? 365);
    const sigmaLo = sigma * (1 - VOL_BAND);
    const sigmaHi = sigma * (1 + VOL_BAND);
    const drift = args.useFundingDrift === true ? market.fundingApr : 0;
    const S = market.markPx;

    const client = new PolymarketClient(ctx.config);
    const pmMarkets = await client.activeMarkets();

    const now = Date.now();
    let skipped = 0;

    // Parse first; price later. Coherence and dedupe need the whole parsed set,
    // and both must run on the MARKET's numbers before any modelling touches them.
    const parsedRows = pmMarkets
      .map((pm) => {
        const parsed = parseThresholdMarket(pm.question);
        if (!parsed || parsed.coin !== market.coin || pm.yesProb === null) return null;
        // Last line of defence against a misparse: a threshold orders of
        // magnitude from spot is not a price. These produce P of exactly 0 or 1
        // and would otherwise top the ranking, since it sorts by |edge|.
        if (!isPlausibleThreshold(parsed.thresholdUsd, S)) {
          skipped++;
          return null;
        }
        const tYears = yearsToExpiry(pm.endDate, now);
        // NaN fails every comparison, so test for a positive number explicitly.
        if (!(tYears > 0)) return null;
        return {
          question: pm.question,
          slug: pm.slug,
          endDate: pm.endDate,
          thresholdUsd: parsed.thresholdUsd,
          mode: parsed.mode,
          yesProb: pm.yesProb,
          liquidityUsd: pm.liquidityUsd,
          tYears,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    // Same economic contract listed more than once: price the liquid copy only.
    const { unique, dropped } = dedupeLadderEntries(parsedRows);

    // Internal consistency of the market's OWN prices, before comparing models.
    const violations = findLadderViolations(unique as LadderEntry[]);

    const divergences = unique
      .map((r) => {
        const hlProb = impliedProbForMode(r.mode, S, r.thresholdUsd, r.tYears, sigma, drift);
        const pLo = impliedProbForMode(r.mode, S, r.thresholdUsd, r.tYears, sigmaLo, drift);
        const pHi = impliedProbForMode(r.mode, S, r.thresholdUsd, r.tYears, sigmaHi, drift);
        const range: [number, number] = [
          round(Math.min(hlProb, pLo, pHi), 4),
          round(Math.max(hlProb, pLo, pHi), 4),
        ];
        const edge = r.yesProb - hlProb;
        const jumpRiskCaveat = hlProb < JUMP_BLIND_MODEL_MAX && r.yesProb >= JUMP_BLIND_MARKET_MIN;
        return {
          question: r.question,
          slug: r.slug,
          endDate: r.endDate,
          thresholdUsd: r.thresholdUsd,
          mode: r.mode,
          polymarketYesProb: round(r.yesProb, 4),
          hlImpliedProb: round(hlProb, 4),
          hlImpliedProbRange: range,
          edge: round(edge, 4),
          signal:
            edge > 0
              ? "polymarket_yes_rich_vs_hl (fade Yes / HL model less bullish)"
              : "polymarket_yes_cheap_vs_hl (Yes underpriced vs HL model)",
          liquidityUsd: round(r.liquidityUsd, 0),
          ...(jumpRiskCaveat
            ? {
                jumpRiskCaveat:
                  "Extreme tail: a no-jump diffusion model asserts ~0% here while real capital prices the " +
                  "outcome — the market is likely the better-informed side. Do not treat this edge as tradeable.",
              }
            : {}),
        };
      })
      .filter((d) => Math.abs(d.edge) >= minEdge)
      .sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge))
      .slice(0, args.limit as number);

    const note =
      pmMarkets.length === 0
        ? "No Polymarket markets returned (endpoint unreachable or empty). Divergence needs live Polymarket data."
        : "Lognormal estimate from HL price + realized vol; 'touch' uses a one-touch barrier. Not a guarantee. " +
          "hlImpliedProbRange spans a ±20% relative volatility band — treat it, not the point estimate, as the " +
          "model's real precision. Question text is parsed heuristically; markets whose threshold is implausible " +
          "versus spot, that name more than one asset, or that are not USD price thresholds (dominance, market " +
          "cap, supply) are skipped rather than priced. ladderViolations lists logically impossible orderings in " +
          "the market's own prices (further threshold priced above a nearer one on the same deadline).";

    const top = divergences[0];
    return {
      summary:
        `${market.coin}: scanned ${pmMarkets.length} Polymarket markets, ` +
        `${divergences.length} divergence(s) ≥ ${round(minEdge * 100, 0)}pp (vol ${round(sigma * 100, 1)}%)` +
        (skipped > 0 ? `, ${skipped} skipped as implausible` : "") +
        (dropped > 0 ? `, ${dropped} duplicate listing(s) collapsed` : "") +
        (violations.length > 0
          ? `. ⚠ ${violations.length} impossible ordering(s) in the market's own price ladder`
          : "") +
        "." +
        (top ? ` Top: "${top.question.slice(0, 60)}" edge ${round(top.edge * 100, 1)}pp.` : ""),
      data: {
        coin: market.coin,
        spot: S,
        annualizedVol: round(sigma, 4),
        volBand: { relative: VOL_BAND, sigmaLow: round(sigmaLo, 4), sigmaHigh: round(sigmaHi, 4) },
        driftUsed: round(drift, 4),
        marketsScanned: pmMarkets.length,
        skippedImplausible: skipped,
        duplicatesCollapsed: dropped,
        ladderViolations: violations.map((v) => ({
          nearer: v.nearer,
          further: v.further,
          gapPp: round(v.gap * 100, 2),
          explanation: v.explanation,
        })),
        divergences,
        note,
        disclaimer: ANALYTICS_DISCLAIMER,
      },
    };
  },
};

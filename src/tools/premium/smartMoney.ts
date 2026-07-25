import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { resolveCohort } from "../../hl/cohort.js";
import { fetchCohortAccounts, ANALYTICS_DISCLAIMER } from "../../hl/whales.js";
import { analyzeCohort } from "../../smartmoney/analyze.js";
import { scoreTrader } from "../../smartmoney/score.js";
import { detectCoordination, type WalletVector } from "../../smartmoney/coordination.js";
import { calibrate } from "../../smartmoney/calibration.js";
import { round, paginate } from "../../core/format.js";
import { SCORE_HORIZON_DAYS } from "../../store/scoreStore.js";

export const smartMoneyScore: ToolDef = {
  name: "hl_smart_money_score",
  tier: "premium",
  title: "Smart-money screener & labels",
  description:
    "Rank a cohort of wallets by a composite screening score over their PAST results (risk-adjusted performance, " +
    "winrate, reward/risk, capital size, activity) and tag each with behavioral labels (whale, sharp, scalper, " +
    "market_maker_like, high_conviction, underwater, …). " +
    "IMPORTANT: this is a descriptive screener, NOT a validated predictor — the component weights are chosen by " +
    "judgement and have not been shown to predict future returns. Check `calibration` in the response for the " +
    "current out-of-sample evidence, and hl_score_calibration for detail. Use it to shortlist wallets to inspect, " +
    "not as a forecast. Cohort resolves from `cohort` arg, the auto-refreshed leaderboard cohort, or HL_WHALE_ADDRESSES. " +
    ANALYTICS_DISCLAIMER,
  inputSchema: {
    cohort: z.array(z.string()).optional().describe("0x wallet addresses to score; else HL_WHALE_ADDRESSES."),
    topN: z.number().int().min(1).max(100).default(50),
    lookbackDays: z.number().int().min(1).max(365).default(30),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(100).default(25),
  },
  outputSchema: {
    source: z.string(),
    cohortAgeSeconds: z.number().nullable(),
    analyzed: z.number(),
    ranked: z.array(z.record(z.any())),
    nextOffset: z.number().nullable(),
    calibration: z.record(z.any()),
    disclaimer: z.string(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  run: async (args, ctx) => {
    const topN = (args.topN as number) ?? 50;
    const lookbackDays = (args.lookbackDays as number) ?? 30;
    const cohort = await resolveCohort(ctx, args.cohort as string[] | undefined, topN);
    const profiles = await analyzeCohort(ctx, cohort.addresses, lookbackDays);

    const ranked = profiles
      .map((p) => {
        const s = scoreTrader(p);
        return {
          address: p.address,
          score: s.score,
          labels: s.labels,
          accountValue: p.accountValue,
          winratePct: p.winratePct,
          avgR: p.avgR,
          realizedPnl: p.realizedPnl,
          pnlSharpe: p.pnlSharpe,
          avgHoldMinutes: p.avgHoldMinutes,
          closedTrades: p.closedTrades,
          components: s.components,
        };
      })
      .sort((a, b) => b.score - a.score);

    // Record observations so the score can eventually be validated against
    // forward results. Deduped per wallet/day inside the store.
    //
    // ONLY for server-chosen cohorts. A caller-supplied `cohort` must never
    // enter the sample: the calibration figure is published, so accepting
    // arbitrary addresses would let anyone steer the headline statistic by
    // submitting wallets they have already picked, and would let one caller
    // grow the table (and its 30-day resolution workload) without bound.
    if (cohort.source !== "arg") {
      for (const r of ranked) {
        ctx.store.scores.record({
          address: r.address,
          score: r.score,
          accountValue: r.accountValue,
          horizonDays: SCORE_HORIZON_DAYS,
        });
      }
    }
    const calibration = calibrate(ctx.store.scores.outcomes());
    const counts = ctx.store.scores.counts();

    const page = paginate(ranked, args.offset as number, args.limit as number);
    const top = ranked[0];
    return {
      summary:
        `Screened ${profiles.length}/${cohort.addresses.length} wallets (source=${cohort.source}).` +
        (top ? ` Top: ${top.address.slice(0, 10)}… score ${top.score} [${top.labels.join(",")}].` : "") +
        ` Score validation: ${calibration.verdict} (${counts.resolved} resolved of ${counts.total} observations).`,
      data: {
        source: cohort.source,
        cohortAgeSeconds: cohort.ageSeconds ?? null,
        analyzed: profiles.length,
        ranked: page.items,
        nextOffset: page.nextOffset,
        calibration: {
          verdict: calibration.verdict,
          spearman: calibration.spearman,
          pValue: calibration.pValue,
          resolvedObservations: counts.resolved,
          pendingObservations: counts.pending,
          horizonDays: SCORE_HORIZON_DAYS,
          note:
            calibration.verdict === "insufficient_data"
              ? "Not yet validated: the score is a descriptive screener over past results, not a proven predictor."
              : "Spearman rank correlation between score and realized forward PnL over the horizon.",
        },
        disclaimer: ANALYTICS_DISCLAIMER,
      },
    };
  },
};

export const coordinationScan: ToolDef = {
  name: "hl_coordination_scan",
  tier: "premium",
  title: "Wallet coordination scan",
  description:
    "Find wallets in a cohort that hold near-identical directional exposure right now (high cosine similarity of " +
    "their position vectors) — likely the same entity, a copy-bot, or a coordinated group. Returns clusters and the " +
    "strongest pairs. Cohort = `cohort` arg or HL_WHALE_ADDRESSES. " +
    ANALYTICS_DISCLAIMER,
  inputSchema: {
    cohort: z.array(z.string()).optional(),
    topN: z.number().int().min(2).max(150).default(80),
    threshold: z.number().min(0.5).max(1).default(0.9).describe("Cosine similarity to link two wallets."),
  },
  outputSchema: {
    source: z.string(),
    walletsQueried: z.number(),
    clusters: z.array(z.array(z.string())),
    pairs: z.array(z.record(z.any())),
    disclaimer: z.string(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  run: async (args, ctx) => {
    const topN = (args.topN as number) ?? 80;
    const threshold = (args.threshold as number) ?? 0.9;
    const cohort = await resolveCohort(ctx, args.cohort as string[] | undefined, topN);
    const accounts = await fetchCohortAccounts(ctx, cohort.addresses);

    const wallets: WalletVector[] = accounts
      .map(({ address, account }) => {
        const gross = account.positions.reduce((a, p) => a + Math.abs(p.positionValueUsd), 0);
        const vec = new Map<string, number>();
        if (gross > 0) {
          for (const p of account.positions) {
            if (p.szi === 0) continue;
            vec.set(p.coin, (p.szi > 0 ? 1 : -1) * (Math.abs(p.positionValueUsd) / gross));
          }
        }
        return { address, vec };
      })
      .filter((w) => w.vec.size > 0);

    const { pairs, clusters } = detectCoordination(wallets, threshold);
    return {
      summary:
        `${clusters.length} coordinated cluster(s) among ${wallets.length} active wallets ` +
        `(≥${round(threshold * 100, 0)}% similarity); ${pairs.length} linked pair(s).`,
      data: {
        source: cohort.source,
        walletsQueried: accounts.length,
        clusters,
        pairs,
        disclaimer: ANALYTICS_DISCLAIMER,
      },
    };
  },
};

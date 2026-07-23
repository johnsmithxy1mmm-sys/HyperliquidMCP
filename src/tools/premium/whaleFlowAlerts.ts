import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { resolveCohort } from "../../hl/cohort.js";
import { fetchCohortAccounts, aggregateByCoin, ANALYTICS_DISCLAIMER } from "../../hl/whales.js";
import { round, shortHash } from "../../core/format.js";

/**
 * Detects large net-notional moves in the cohort's coin-level positioning since
 * the last observed snapshot within the lookback window. Requires prior
 * snapshots (built up as the tool is called over time); on a cold cache it
 * seeds the baseline and reports that no prior baseline existed.
 *
 * Coins the cohort has FULLY exited are detected too: prior snapshots whose
 * coin is absent from the current aggregate are compared against zero, so
 * "whale closed everything" fires an alert instead of vanishing silently.
 */
export const whaleFlowAlerts: ToolDef = {
  name: "hl_whale_flow_alerts",
  tier: "premium",
  title: "Whale flow alerts (recent large moves)",
  description:
    "Recent large changes in whale cohort positioning: which coins saw net long/short notional shift beyond a USD " +
    "threshold within a lookback window — 'who opened/closed what in the last hour'. Detects full exits. " +
    "Seeds a baseline on first call. " +
    ANALYTICS_DISCLAIMER,
  inputSchema: {
    cohort: z.array(z.string()).optional().describe("Explicit 0x wallet addresses; else HL_WHALE_ADDRESSES."),
    topN: z.number().int().min(1).max(200).default(50),
    thresholdUsd: z.number().min(0).default(250_000).describe("Min absolute net-notional change to alert on."),
    lookbackMinutes: z.number().int().min(5).max(1440).default(60).describe("Compare against a snapshot ~this old."),
  },
  outputSchema: {
    source: z.string(),
    walletsQueried: z.number(),
    lookbackMinutes: z.number(),
    baselineFound: z.boolean(),
    alerts: z.array(z.record(z.any())),
    disclaimer: z.string(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  run: async (args, ctx) => {
    const topN = (args.topN as number) ?? 50;
    const thresholdUsd = (args.thresholdUsd as number) ?? 250_000;
    const lookbackMinutes = (args.lookbackMinutes as number) ?? 60;
    const lookbackMs = lookbackMinutes * 60_000;

    const cohort = await resolveCohort(ctx, args.cohort as string[] | undefined, topN);
    const accounts = await fetchCohortAccounts(ctx, cohort.addresses);
    const agg = aggregateByCoin(accounts);
    const cohortKey = shortHash(cohort.addresses.slice().sort().join(","));
    const now = Date.now();

    const alerts: Array<Record<string, unknown>> = [];
    let baselineFound = false;

    const evaluate = (coin: string, key: string, netNow: number, wallets: number, extra: Record<string, unknown>) => {
      const prior = ctx.snapshots.nearest("whaleFlow", key, lookbackMs, lookbackMs / 2);
      ctx.snapshots.record("whaleFlow", key, { netNtlUsd: netNow, ...extra }, now);
      if (!prior) return;
      baselineFound = true;
      const prevNet = Number((prior.value as { netNtlUsd: number }).netNtlUsd);
      const change = netNow - prevNet;
      if (Math.abs(change) >= thresholdUsd) {
        alerts.push({
          coin,
          changeUsd: round(change, 2),
          direction: change > 0 ? "net_long_increase" : "net_short_increase",
          netNtlUsdNow: round(netNow, 2),
          netNtlUsdPrev: round(prevNet, 2),
          wallets,
          fullyClosed: netNow === 0,
          ageMinutes: round((now - prior.at) / 60_000, 1),
        });
      }
    };

    // Coins the cohort currently holds.
    for (const c of agg.values()) {
      evaluate(c.coin, `${c.coin}:${cohortKey}`, c.netNtlUsd, c.wallets, {
        longNtlUsd: c.longNtlUsd,
        shortNtlUsd: c.shortNtlUsd,
      });
    }

    // Coins with prior snapshots that vanished from the aggregate = fully exited.
    const held = new Set([...agg.keys()]);
    const suffix = `:${cohortKey}`;
    for (const key of ctx.snapshots.keys("whaleFlow")) {
      if (!key.endsWith(suffix)) continue;
      const coin = key.slice(0, key.length - suffix.length);
      if (held.has(coin)) continue;
      evaluate(coin, key, 0, 0, { longNtlUsd: 0, shortNtlUsd: 0 });
    }

    alerts.sort((a, b) => Math.abs(Number(b.changeUsd)) - Math.abs(Number(a.changeUsd)));

    return {
      summary: baselineFound
        ? `${alerts.length} whale flow alert(s) ≥ $${thresholdUsd} over ~${lookbackMinutes}m.`
        : `Baseline seeded (no snapshot ~${lookbackMinutes}m old yet). Call again later to detect flow.`,
      data: {
        source: cohort.source,
        walletsQueried: accounts.length,
        lookbackMinutes,
        baselineFound,
        alerts,
        disclaimer: ANALYTICS_DISCLAIMER,
      },
    };
  },
};

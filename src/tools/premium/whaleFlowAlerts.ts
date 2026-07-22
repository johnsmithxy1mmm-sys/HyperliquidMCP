import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { resolveCohort } from "../../hl/cohort.js";
import { fetchCohortAccounts, aggregateByCoin, ANALYTICS_DISCLAIMER } from "../../hl/whales.js";
import { round } from "../../core/format.js";

/**
 * Detects large net-notional moves in the cohort's coin-level positioning since
 * the last observed snapshot within the lookback window. Requires prior
 * snapshots (built up as the tool is called over time); on a cold cache it
 * seeds the baseline and reports that no prior baseline existed.
 */
export const whaleFlowAlerts: ToolDef = {
  name: "hl_whale_flow_alerts",
  tier: "premium",
  title: "Whale flow alerts (recent large moves)",
  description:
    "Recent large changes in whale cohort positioning: which coins saw net long/short notional shift beyond a USD " +
    "threshold within a lookback window — 'who opened/closed what in the last hour'. Seeds a baseline on first call. " +
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
    const cohortKey = hash(cohort.addresses.slice().sort().join(","));
    const now = Date.now();

    const alerts: Array<Record<string, unknown>> = [];
    let baselineFound = false;
    for (const c of agg.values()) {
      const key = `${c.coin}:${cohortKey}`;
      const prior = ctx.snapshots.nearest("whaleFlow", key, lookbackMs, lookbackMs / 2);
      ctx.snapshots.record("whaleFlow", key, { netNtlUsd: c.netNtlUsd, longNtlUsd: c.longNtlUsd, shortNtlUsd: c.shortNtlUsd }, now);
      if (!prior) continue;
      baselineFound = true;
      const prev = prior.value as { netNtlUsd: number };
      const change = c.netNtlUsd - Number(prev.netNtlUsd);
      if (Math.abs(change) >= thresholdUsd) {
        alerts.push({
          coin: c.coin,
          changeUsd: round(change, 2),
          direction: change > 0 ? "net_long_increase" : "net_short_increase",
          netNtlUsdNow: c.netNtlUsd,
          netNtlUsdPrev: round(Number(prev.netNtlUsd), 2),
          wallets: c.wallets,
          ageMinutes: round((now - prior.at) / 60_000, 1),
        });
      }
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

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

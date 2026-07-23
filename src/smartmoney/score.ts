/**
 * Smart-money scoring and behavioral labeling. Pure and deterministic.
 *
 * Score (0..100) is a weighted blend of risk-adjusted performance, winrate,
 * reward/risk, capital size, and activity — so a large, consistent, profitable
 * wallet ranks above a lucky small one. Labels are heuristic behavior tags.
 */
import type { TraderProfile } from "./profile.js";
import { round } from "../core/format.js";

export interface SmartMoneyScore {
  score: number;
  components: {
    performance: number;
    winrate: number;
    rewardRisk: number;
    size: number;
    activity: number;
  };
  labels: string[];
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

export function scoreTrader(p: TraderProfile): SmartMoneyScore {
  const performance = clamp01((p.pnlSharpe ?? 0) / 3); // Sharpe 3 => full marks
  const winrate = clamp01((p.winratePct - 40) / 40); // 40%→0, 80%→1
  const rewardRisk = clamp01((p.avgR ?? 0) / 3); // avgR 3 => full marks
  const size = clamp01(Math.log10(Math.max(p.accountValue, 1)) / 7); // ~$10M => full marks
  const activity = clamp01(p.closedTrades / 200);

  const score =
    100 * (0.3 * performance + 0.25 * winrate + 0.15 * rewardRisk + 0.2 * size + 0.1 * activity);

  return {
    score: round(score, 1),
    components: {
      performance: round(performance, 3),
      winrate: round(winrate, 3),
      rewardRisk: round(rewardRisk, 3),
      size: round(size, 3),
      activity: round(activity, 3),
    },
    labels: labelTrader(p),
  };
}

/** Heuristic behavior tags. Non-exclusive. */
export function labelTrader(p: TraderProfile): string[] {
  const labels: string[] = [];
  if (p.accountValue >= 1_000_000) labels.push("whale");
  else if (p.accountValue >= 100_000) labels.push("large");

  if (p.avgHoldMinutes !== null) {
    if (p.avgHoldMinutes < 30) labels.push("scalper");
    else if (p.avgHoldMinutes > 24 * 60) labels.push("swing");
    else labels.push("intraday");
  }

  // Market-maker-like: very active, balanced two-sided, short holds.
  if (p.tradeCount >= 300 && p.longShortBalance >= 0.6 && (p.avgHoldMinutes ?? Infinity) < 60) {
    labels.push("market_maker_like");
  }

  if (p.winratePct >= 55 && (p.pnlSharpe ?? 0) >= 1) labels.push("sharp");
  if (p.distinctCoins > 0 && p.distinctCoins <= 2 && p.topConcentrationPct >= 0.6) labels.push("high_conviction");
  if (p.realizedPnl < 0) labels.push("underwater");
  else if (p.realizedPnl > 0 && (p.pnlSharpe ?? 0) > 0) labels.push("profitable");

  return labels;
}

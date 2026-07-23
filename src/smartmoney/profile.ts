/**
 * Trader profile: condensed behavioral + performance metrics derived from an
 * address's fills and current account state. Pure (given fetched data), so the
 * scoring/labeling built on top is fully testable.
 */
import type { UserFill } from "../hl/types.js";
import type { NormalizedAccount } from "../hl/account.js";
import { num, round, sharpe } from "../core/format.js";

export interface TraderProfile {
  address: string;
  accountValue: number;
  tradeCount: number;
  closedTrades: number;
  winratePct: number;
  avgR: number | null;
  realizedPnl: number;
  pnlSharpe: number | null;
  avgHoldMinutes: number | null;
  distinctCoins: number;
  topConcentrationPct: number; // largest current position share of book (0..1)
  longShortBalance: number; // 0 = one-sided, 1 = perfectly balanced
}

export function buildTraderProfile(address: string, fills: UserFill[], account: NormalizedAccount): TraderProfile {
  const sorted = [...fills].sort((a, b) => a.time - b.time);
  const closed = sorted.filter((f) => num(f.closedPnl) !== 0);
  const wins = closed.filter((f) => num(f.closedPnl) > 0);
  const losses = closed.filter((f) => num(f.closedPnl) < 0);
  const avgWin = wins.length ? wins.reduce((a, f) => a + num(f.closedPnl), 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((a, f) => a + num(f.closedPnl), 0) / losses.length) : 0;
  const realizedPnl = closed.reduce((a, f) => a + num(f.closedPnl), 0);
  const winratePct = closed.length ? (wins.length / closed.length) * 100 : 0;
  const avgR = avgLoss > 0 ? round(avgWin / avgLoss, 3) : null;
  const pnlSharpe = closed.length >= 2 ? sharpe(closed.map((f) => num(f.closedPnl))) : null;

  const distinctCoins = new Set(sorted.map((f) => f.coin)).size;

  // Current-position stats.
  const notl = account.positions.map((p) => Math.abs(p.positionValueUsd));
  const totalNtl = notl.reduce((a, b) => a + b, 0);
  const topConcentrationPct = totalNtl > 0 ? round(Math.max(0, ...notl) / totalNtl, 4) : 0;
  const longNtl = account.positions.filter((p) => p.side === "long").reduce((a, p) => a + Math.abs(p.positionValueUsd), 0);
  const shortNtl = account.positions.filter((p) => p.side === "short").reduce((a, p) => a + Math.abs(p.positionValueUsd), 0);
  const gross = longNtl + shortNtl;
  const longShortBalance = gross > 0 ? round(1 - Math.abs(longNtl - shortNtl) / gross, 4) : 0;

  return {
    address,
    accountValue: account.accountValue,
    tradeCount: sorted.length,
    closedTrades: closed.length,
    winratePct: round(winratePct, 2),
    avgR,
    realizedPnl: round(realizedPnl, 2),
    pnlSharpe,
    avgHoldMinutes: estimateHoldMinutes(sorted),
    distinctCoins,
    topConcentrationPct,
    longShortBalance,
  };
}

/** Median minutes between a position-opening fill and its closing fill. */
export function estimateHoldMinutes(fills: UserFill[]): number | null {
  const gaps: number[] = [];
  const openTimeByCoin = new Map<string, number>();
  for (const f of fills) {
    if (Math.abs(num(f.startPosition)) < 1e-9 && !openTimeByCoin.has(f.coin)) openTimeByCoin.set(f.coin, f.time);
    if (num(f.closedPnl) !== 0) {
      const opened = openTimeByCoin.get(f.coin);
      if (opened !== undefined) {
        gaps.push((f.time - opened) / 60_000);
        openTimeByCoin.delete(f.coin);
      }
    }
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return round(gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2, 1);
}

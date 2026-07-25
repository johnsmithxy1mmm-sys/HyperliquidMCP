/**
 * Pure cohort ranking — no I/O, fully testable.
 *
 * Leaderboard payloads from Hyperliquid's public stats endpoint are loosely
 * typed and vary in shape (window keys, string/number amounts, occasional
 * nulls), so parsing is defensive: anything unrecognizable is dropped rather
 * than guessed at.
 */
import { isAddress, num } from "../core/format.js";

/** How to pick the cohort from a leaderboard. */
export type CohortStrategy = "accountValue" | "pnlMonth" | "pnlAllTime";

export interface RankedWallet {
  address: string;
  accountValue: number;
  pnl: number;
  /** Value the ranking actually sorted on (depends on strategy). */
  rankBy: number;
}

/**
 * Loose shape of a leaderboard row. Field names differ between payload
 * versions, so several aliases are accepted for each concept.
 */
export interface RawLeaderboardRow {
  ethAddress?: unknown;
  address?: unknown;
  user?: unknown;
  accountValue?: unknown;
  windowPerformances?: unknown;
  pnl?: unknown;
  [k: string]: unknown;
}

/** Extract a wallet address from any of the known field aliases. */
function pickAddress(row: RawLeaderboardRow): string | null {
  for (const key of ["ethAddress", "address", "user"] as const) {
    const v = row[key];
    if (typeof v === "string" && isAddress(v)) return v.toLowerCase();
  }
  return null;
}

/**
 * `windowPerformances` is typically [["day",{pnl,roi,vlm}], ["week",{...}],
 * ["month",{...}], ["allTime",{...}]]. Returns the pnl for a window, or 0.
 */
export function pnlForWindow(row: RawLeaderboardRow, window: string): number {
  const wp = row.windowPerformances;
  if (!Array.isArray(wp)) return 0;
  for (const entry of wp) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    if (entry[0] !== window) continue;
    const perf = entry[1];
    if (perf && typeof perf === "object" && "pnl" in perf) {
      return num((perf as { pnl: unknown }).pnl as string | number);
    }
  }
  return 0;
}

/**
 * Rank leaderboard rows into a cohort.
 *
 * `minAccountValue` filters out dust accounts that can top a PnL leaderboard
 * with a lucky small trade — without it, a $200 wallet up 900% outranks a
 * disciplined $5M desk.
 */
export function rankCohort(
  rows: RawLeaderboardRow[],
  opts: { strategy?: CohortStrategy; topN?: number; minAccountValue?: number } = {},
): RankedWallet[] {
  const strategy: CohortStrategy = opts.strategy ?? "accountValue";
  const topN = Math.max(1, Math.floor(opts.topN ?? 50));
  const minAccountValue = Math.max(0, opts.minAccountValue ?? 0);

  const seen = new Set<string>();
  const out: RankedWallet[] = [];

  for (const row of rows) {
    const address = pickAddress(row);
    if (!address || seen.has(address)) continue;

    const accountValue = num(row.accountValue as string | number);
    if (accountValue < minAccountValue) continue;

    const pnlMonth = pnlForWindow(row, "month");
    const pnlAllTime = pnlForWindow(row, "allTime");
    const pnl = strategy === "pnlAllTime" ? pnlAllTime : pnlMonth;

    let rankBy: number;
    switch (strategy) {
      case "pnlMonth":
        rankBy = pnlMonth;
        break;
      case "pnlAllTime":
        rankBy = pnlAllTime;
        break;
      case "accountValue":
      default:
        rankBy = accountValue;
    }
    if (!Number.isFinite(rankBy)) continue;

    seen.add(address);
    out.push({ address, accountValue, pnl, rankBy });
  }

  out.sort((a, b) => b.rankBy - a.rankBy);
  return out.slice(0, topN);
}

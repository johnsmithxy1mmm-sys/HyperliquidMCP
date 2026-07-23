/**
 * Shared helpers: numeric parsing, address validation, pagination, annualization.
 * Keeping these DRY (hard rule: no dumps — aggregate/paginate/truncate).
 */
import { invalidAddress } from "./errors.js";

export function num(x: string | number | null | undefined, fallback = 0): number {
  if (x === null || x === undefined) return fallback;
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : fallback;
}

export function round(x: number, dp = 6): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export function assertAddress(address: string): string {
  if (!ADDR_RE.test(address)) throw invalidAddress(address);
  return address.toLowerCase();
}

export function isAddress(address: string): boolean {
  return ADDR_RE.test(address);
}

export interface PageResult<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
}

export function paginate<T>(all: T[], offset?: number, limit?: number): PageResult<T> {
  // NaN/undefined-safe: callers outside the SDK validation path (e.g. Apify) may
  // pass unset values; degrade to sane defaults instead of a NaN slice.
  const start = Number.isFinite(offset as number) ? Math.max(0, Math.floor(offset as number)) : 0;
  const lim = Number.isFinite(limit as number) ? Math.max(1, Math.floor(limit as number)) : 50;
  const items = all.slice(start, start + lim);
  const nextOffset = start + lim < all.length ? start + lim : null;
  return { items, total: all.length, offset: start, limit: lim, nextOffset };
}

/**
 * Hyperliquid funding is charged hourly. Annualized rate = hourly * 24 * 365.
 * Returned as a decimal fraction (0.12 = 12% APR).
 */
export function annualizeHourlyFunding(hourlyRate: number): number {
  return hourlyRate * 24 * 365;
}

/** Compact percentage string for text summaries. */
export function pct(fraction: number, dp = 2): string {
  return `${round(fraction * 100, dp)}%`;
}

/** Stable short hash for cache/snapshot keys (not cryptographic). */
export function shortHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Sharpe from a series of per-period returns (unannualized ratio). */
export function sharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const sd = Math.sqrt(variance);
  return sd === 0 ? 0 : round(mean / sd, 4);
}

/** Downside-deviation Sortino ratio. */
export function sortino(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const downside = returns.filter((r) => r < 0);
  if (downside.length === 0) return 0;
  const dd = Math.sqrt(downside.reduce((a, b) => a + b * b, 0) / downside.length);
  return dd === 0 ? 0 : round(mean / dd, 4);
}

/** Max drawdown of an equity curve (fraction, positive number). */
export function maxDrawdown(equity: number[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    if (peak > 0) mdd = Math.max(mdd, (peak - v) / peak);
  }
  return round(mdd, 4);
}

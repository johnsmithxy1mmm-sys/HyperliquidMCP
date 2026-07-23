/**
 * Pure execution planners. Given intent, produce a schedule of child orders.
 * No I/O — fully unit-testable. The runner drives these over TradingService.
 */

export interface ChildOrder {
  index: number;
  size: number;
  /** ms offset from execution start when this child should fire. */
  atOffsetMs: number;
}

export interface TwapParams {
  totalSize: number;
  slices: number;
  durationMs: number;
}

/**
 * TWAP: split totalSize into `slices` evenly-sized children spread evenly over
 * durationMs. Rounding drift is folded into the final slice so children sum
 * exactly to totalSize.
 */
export function planTwap(p: TwapParams): ChildOrder[] {
  const slices = Math.max(1, Math.floor(p.slices));
  if (!(p.totalSize > 0)) return [];
  const per = p.totalSize / slices;
  const gap = slices > 1 ? p.durationMs / (slices - 1) : 0;
  const out: ChildOrder[] = [];
  let allocated = 0;
  for (let i = 0; i < slices; i++) {
    const isLast = i === slices - 1;
    const size = isLast ? round(p.totalSize - allocated, 10) : round(per, 10);
    allocated = round(allocated + size, 10);
    out.push({ index: i, size, atOffsetMs: Math.round(gap * i) });
  }
  // Accumulated rounding can leave the folded last slice ≤ 0 — drop empty
  // children and reindex so indices stay contiguous for the runner.
  return out.filter((c) => c.size > 0).map((c, i) => ({ ...c, index: i }));
}

/** Iceberg: fixed-size clips until totalSize is consumed, fired back-to-back. */
export function planIceberg(totalSize: number, clipSize: number, spacingMs = 0): ChildOrder[] {
  if (!(totalSize > 0) || !(clipSize > 0)) return [];
  const out: ChildOrder[] = [];
  let remaining = totalSize;
  let i = 0;
  while (remaining > 1e-12) {
    const size = round(Math.min(clipSize, remaining), 10);
    out.push({ index: i, size, atOffsetMs: i * spacingMs });
    remaining = round(remaining - size, 10);
    i++;
    if (i > 100_000) break; // safety
  }
  return out;
}

export interface MirrorPositionInput {
  coin: string;
  szi: number; // signed target size
  markPx: number;
}

export interface MirrorOrder {
  coin: string;
  isBuy: boolean;
  size: number;
  targetNotionalUsd: number;
  scaledNotionalUsd: number;
}

/**
 * Copy-trading planner: replicate a target wallet's directional exposure scaled
 * to your own equity. scaleFactor = (myEquity * scale) / targetEquity, so a
 * $10k account mirroring a $1M whale at scale=1 takes ~1% of the whale's size.
 */
export function planMirror(
  targetPositions: MirrorPositionInput[],
  myEquityUsd: number,
  targetEquityUsd: number,
  scale = 1,
): MirrorOrder[] {
  if (!(myEquityUsd > 0) || !(targetEquityUsd > 0)) return [];
  const factor = (myEquityUsd * scale) / targetEquityUsd;
  const out: MirrorOrder[] = [];
  for (const p of targetPositions) {
    if (p.szi === 0 || !(p.markPx > 0)) continue;
    const targetNotional = Math.abs(p.szi) * p.markPx;
    const scaledNotional = targetNotional * factor;
    const size = round(scaledNotional / p.markPx, 8);
    if (size <= 0) continue;
    out.push({
      coin: p.coin,
      isBuy: p.szi > 0,
      size,
      targetNotionalUsd: round(targetNotional, 2),
      scaledNotionalUsd: round(scaledNotional, 2),
    });
  }
  return out;
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

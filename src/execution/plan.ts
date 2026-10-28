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
  /** The coin's size decimals: slices are whole multiples of 10^-szDecimals. */
  szDecimals: number;
}

/**
 * TWAP: split totalSize into `slices` children spread evenly over durationMs.
 *
 * Sizes are whole lots (10^-szDecimals). The exchange rounds every order to
 * szDecimals, so a 1.5-coin slice of a 0-decimal coin would go out as 2 and
 * ten of them would send 20. Lots are spread so slices differ by at most one
 * lot and sum exactly to totalSize rounded to the lot.
 */
export function planTwap(p: TwapParams): ChildOrder[] {
  const slices = Math.max(1, Math.floor(p.slices));
  const perLot = 10 ** p.szDecimals;
  const lots = Math.round(p.totalSize * perLot);
  if (!(lots > 0)) return [];
  const base = Math.floor(lots / slices);
  const extra = lots % slices;
  const gap = slices > 1 ? p.durationMs / (slices - 1) : 0;
  const out: ChildOrder[] = [];
  for (let i = 0; i < slices; i++) {
    const size = (base + (i < extra ? 1 : 0)) / perLot;
    out.push({ index: i, size, atOffsetMs: Math.round(gap * i) });
  }
  // With fewer lots than slices some children are empty — drop them and
  // reindex so indices stay contiguous for the runner. Callers compare the
  // count with what they asked for.
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
  /** Size of the DELTA trade, not of the desired end position. */
  size: number;
  /** True when this leg only shrinks an existing position (never on a flip). */
  reduceOnly: boolean;
  targetNotionalUsd: number;
  /** Notional of the desired end position after this leg. */
  scaledNotionalUsd: number;
  /** Notional actually being traded now. Risk checks bound THIS. */
  deltaNotionalUsd: number;
}

/**
 * Copy-trading planner: move from what you CURRENTLY hold to the target's
 * exposure scaled to your equity. scaleFactor = (myEquity * scale) /
 * targetEquity, so a $10k account mirroring a $1M whale at scale=1 aims at ~1%
 * of the whale's size.
 *
 * Orders are DELTAS, not the full desired position. Copy-trading is inherently
 * repeated — "keep me in sync with this whale" is the normal way it is used —
 * and emitting the full mirror each time compounds exposure without limit:
 * three sync calls would leave you at 3x the intended position with nothing
 * ever offsetting it. Passing your current positions makes the operation
 * idempotent: once in sync, a repeat call emits nothing.
 */
export function planMirror(
  targetPositions: MirrorPositionInput[],
  myEquityUsd: number,
  targetEquityUsd: number,
  scale = 1,
  myCurrentPositions: MirrorPositionInput[] = [],
): MirrorOrder[] {
  if (!(myEquityUsd > 0) || !(targetEquityUsd > 0)) return [];
  const factor = (myEquityUsd * scale) / targetEquityUsd;

  const currentByCoin = new Map<string, MirrorPositionInput>();
  for (const p of myCurrentPositions) currentByCoin.set(p.coin, p);

  // Union of coins: a coin the target has EXITED still needs an order to unwind
  // the leg we opened for it, otherwise stale exposure lingers forever.
  const coins = new Set<string>();
  for (const p of targetPositions) coins.add(p.coin);
  for (const p of myCurrentPositions) coins.add(p.coin);

  const out: MirrorOrder[] = [];
  for (const coin of coins) {
    const tgt = targetPositions.find((p) => p.coin === coin);
    const cur = currentByCoin.get(coin);
    const markPx = (tgt?.markPx ?? 0) > 0 ? (tgt as MirrorPositionInput).markPx : (cur?.markPx ?? 0);
    if (!(markPx > 0)) continue;

    const desiredSzi = round((tgt?.szi ?? 0) * factor, 8);
    const currentSzi = cur?.szi ?? 0;
    const deltaSzi = round(desiredSzi - currentSzi, 8);
    const size = Math.abs(deltaSzi);
    if (size <= 0) continue;

    // reduceOnly only when the trade shrinks an existing position without
    // crossing through zero; a flip must not be marked reduce-only or the
    // exchange rejects it.
    const shrinking =
      currentSzi !== 0 &&
      (desiredSzi === 0 || (Math.sign(desiredSzi) === Math.sign(currentSzi) && Math.abs(desiredSzi) < Math.abs(currentSzi)));

    out.push({
      coin,
      isBuy: deltaSzi > 0,
      size,
      reduceOnly: shrinking,
      targetNotionalUsd: round(Math.abs(tgt?.szi ?? 0) * markPx, 2),
      scaledNotionalUsd: round(Math.abs(desiredSzi) * markPx, 2),
      deltaNotionalUsd: round(size * markPx, 2),
    });
  }
  return out;
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

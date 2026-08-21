/**
 * Ladder coherence for threshold markets. Pure — no I/O.
 *
 * A price path is continuous: touching $180k requires passing $170k first, so
 * P(touch $170k) >= P(touch $180k) is not a modelling opinion, it is logic.
 * Real ladders violate it anyway (the Octagon BTC-2026 report carried four
 * such violations, unflagged). Surfacing them does two jobs:
 *   - flags internally inconsistent market data BEFORE an agent trades on it;
 *   - the violating pair itself is a potential structural edge (the same
 *     constraint polymarket_bot's chain arbitrage trades).
 *
 * Comparisons are strict: same mode AND same end date only. A touch-by-June
 * vs touch-by-December pair is a DATE ladder, not a value ladder, and a
 * touch-anytime vs above-at-expiry pair prices different events — neither is
 * comparable, so neither is compared.
 */
import type { ThresholdMode } from "./parse.js";

export interface LadderEntry {
  question: string;
  slug: string;
  thresholdUsd: number;
  mode: ThresholdMode;
  yesProb: number;
  endDate: string | undefined;
  liquidityUsd: number;
}

export interface LadderViolation {
  /** The easier threshold (closer to spot) — its YES is implied by the harder one. */
  nearer: { question: string; thresholdUsd: number; yesProb: number };
  /** The harder threshold (further from spot). */
  further: { question: string; thresholdUsd: number; yesProb: number };
  /** How far the impossible ordering goes, in probability points (0..1). */
  gap: number;
  explanation: string;
}

/** Upward ladders: higher threshold = harder. Downward: lower = harder. */
function isUpward(mode: ThresholdMode): boolean {
  return mode === "above" || mode === "touch";
}

/**
 * All-pairs check within each (mode, endDate) group. All pairs rather than
 * adjacent-only: with three rungs A < B < C, prices can order A < C without
 * violating A↔B or B↔C — adjacent-only scanning misses it.
 */
export function findLadderViolations(entries: LadderEntry[], maxReported = 20): LadderViolation[] {
  const groups = new Map<string, LadderEntry[]>();
  for (const e of entries) {
    if (!(e.yesProb >= 0) || !(e.yesProb <= 1)) continue;
    const key = `${e.mode}:${e.endDate ?? ""}`;
    const arr = groups.get(key) ?? [];
    arr.push(e);
    groups.set(key, arr);
  }

  const out: LadderViolation[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const up = isUpward(group[0].mode);
    // Sort easiest-first: ascending K for upward ladders, descending for downward.
    const sorted = [...group].sort((a, b) => (up ? a.thresholdUsd - b.thresholdUsd : b.thresholdUsd - a.thresholdUsd));
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const nearer = sorted[i];
        const further = sorted[j];
        if (nearer.thresholdUsd === further.thresholdUsd) continue; // duplicate rung, not a ladder pair
        const gap = further.yesProb - nearer.yesProb;
        if (gap > 1e-9) {
          out.push({
            nearer: { question: nearer.question, thresholdUsd: nearer.thresholdUsd, yesProb: nearer.yesProb },
            further: { question: further.question, thresholdUsd: further.thresholdUsd, yesProb: further.yesProb },
            gap,
            explanation:
              `Reaching $${further.thresholdUsd.toLocaleString("en-US")} requires passing ` +
              `$${nearer.thresholdUsd.toLocaleString("en-US")} first, yet the further outcome is priced ` +
              `${(gap * 100).toFixed(1)}pp HIGHER — logically impossible; one of the two prices is wrong.`,
          });
        }
      }
    }
  }

  out.sort((a, b) => b.gap - a.gap);
  return out.slice(0, maxReported);
}

/**
 * Collapse duplicate listings of the same economic contract — same mode,
 * threshold, and end date. Real feeds carry these (the Octagon BTC-2026 table
 * listed one ↓$60k contract four times at four different prices); pricing each
 * copy separately double-counts one opportunity and lets contradictory copies
 * coexist silently. Keeps the most liquid copy — the price closest to real
 * capital. Returns the survivors plus how many rows were folded away.
 */
export function dedupeLadderEntries<T extends LadderEntry>(entries: T[]): { unique: T[]; dropped: number } {
  const byKey = new Map<string, T>();
  let dropped = 0;
  for (const e of entries) {
    const key = `${e.mode}:${e.endDate ?? ""}:${e.thresholdUsd}`;
    const cur = byKey.get(key);
    if (!cur) {
      byKey.set(key, e);
    } else {
      dropped++;
      if (e.liquidityUsd > cur.liquidityUsd) byKey.set(key, e);
    }
  }
  return { unique: [...byKey.values()], dropped };
}

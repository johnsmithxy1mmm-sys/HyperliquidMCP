/**
 * Coordination / same-entity detection. Given each wallet's positioning as a
 * vector (coin -> signed notional share of its book), wallets that hold nearly
 * identical directional exposure have high cosine similarity — likely the same
 * entity, a copy-bot, or a coordinated group. Pure and testable.
 */
import { round } from "../core/format.js";

export interface WalletVector {
  address: string;
  vec: Map<string, number>; // coin -> signed share (long +, short -)
}

export interface CoordinationPair {
  a: string;
  b: string;
  similarity: number;
}

export interface CoordinationResult {
  pairs: CoordinationPair[];
  clusters: string[][];
  /** Wallets with enough open coins to be compared at all. */
  compared: number;
}

/**
 * Below this many open coins every same-direction book has cosine 1.0 (all
 * BTC longs look identical), and union-find chains them into one "entity".
 */
export const MIN_COINS_FOR_SIMILARITY = 3;
/** Strongest pairs returned; clustering still uses every linked pair. */
const MAX_PAIRS = 50;

export function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const v of a.values()) na += v * v;
  for (const v of b.values()) nb += v * v;
  const coins = new Set([...a.keys(), ...b.keys()]);
  for (const c of coins) dot += (a.get(c) ?? 0) * (b.get(c) ?? 0);
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Detect co-moving wallets. Pairs above `threshold` become edges; connected
 * components (union-find) form clusters of ≥2 addresses. */
export function detectCoordination(allWallets: WalletVector[], threshold = 0.9): CoordinationResult {
  const wallets = allWallets.filter(
    (w) => [...w.vec.values()].filter((v) => v !== 0).length >= MIN_COINS_FOR_SIMILARITY,
  );
  const pairs: CoordinationPair[] = [];
  const parent = new Map<string, string>();
  for (const w of wallets) parent.set(w.address, w.address);

  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    // path compression
    let cur = x;
    while (parent.get(cur) !== r) {
      const next = parent.get(cur) as string;
      parent.set(cur, r);
      cur = next;
    }
    return r;
  };
  const union = (x: string, y: string): void => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  };

  for (let i = 0; i < wallets.length; i++) {
    for (let j = i + 1; j < wallets.length; j++) {
      const sim = cosineSimilarity(wallets[i].vec, wallets[j].vec);
      if (sim >= threshold) {
        pairs.push({ a: wallets[i].address, b: wallets[j].address, similarity: round(sim, 4) });
        union(wallets[i].address, wallets[j].address);
      }
    }
  }

  const groups = new Map<string, string[]>();
  for (const w of wallets) {
    const root = find(w.address);
    const arr = groups.get(root) ?? [];
    arr.push(w.address);
    groups.set(root, arr);
  }
  const clusters = [...groups.values()].filter((g) => g.length >= 2).sort((a, b) => b.length - a.length);

  pairs.sort((p, q) => q.similarity - p.similarity);
  return { pairs: pairs.slice(0, MAX_PAIRS), clusters, compared: wallets.length };
}

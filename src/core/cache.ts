/**
 * In-memory LRU + TTL cache. Used for markets (5s), metadata (5min),
 * whale cohorts (60s) etc. Single-process; good enough for MVP.
 *
 * The store holds mixed value types; get/set/getOrLoad are generic per call so
 * each caller recovers its concrete type.
 */

interface Entry {
  value: unknown;
  expiresAt: number;
}

export class TtlLruCache {
  private readonly max: number;
  private readonly store = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(maxEntries = 500) {
    this.max = Math.max(1, maxEntries);
  }

  get<T>(key: string): T | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    // refresh recency
    this.store.delete(key);
    this.store.set(key, e);
    return e.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    if (this.store.size > this.max) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
  }

  /** Get-or-compute with per-key single-flight to avoid stampedes. */
  async getOrLoad<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const hit = this.get<T>(key);
    if (hit !== undefined) return hit;

    const inflight = this.pending.get(key);
    if (inflight) return inflight as Promise<T>;

    const p = (async () => {
      try {
        const value = await loader();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, p);
    return p;
  }

  clear(): void {
    this.store.clear();
    this.pending.clear();
  }
}

/** Standard TTLs (ms) from the brief. */
export const TTL = {
  markets: 5_000,
  orderbook: 2_000,
  candles: 15_000,
  metadata: 5 * 60_000,
  whaleCohort: 60_000,
  account: 5_000,
  heavyAggregation: 60_000,
} as const;

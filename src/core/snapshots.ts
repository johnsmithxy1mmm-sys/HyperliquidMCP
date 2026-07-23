/**
 * Time-series snapshot store for computing deltas (e.g. whale position change
 * over 1h/24h). Default implementation is in-memory (single process, pruned to
 * ~26h). A SQLite-backed implementation can be swapped in for persistence.
 */

export interface Snapshot<T = unknown> {
  at: number;
  value: T;
}

export interface SnapshotStore {
  record(ns: string, key: string, value: unknown, at?: number): void;
  /** Snapshot whose age is closest to `targetAgeMs`, within `toleranceMs`. */
  nearest(ns: string, key: string, targetAgeMs: number, toleranceMs: number): Snapshot | undefined;
  /** All keys currently tracked under a namespace (for detecting vanished entities). */
  keys(ns: string): string[];
}

const MAX_AGE_MS = 26 * 3_600_000;
const MAX_PER_KEY = 200;

export class InMemorySnapshotStore implements SnapshotStore {
  private readonly series = new Map<string, Snapshot[]>();

  private k(ns: string, key: string): string {
    return `${ns}::${key}`;
  }

  record(ns: string, key: string, value: unknown, at = Date.now()): void {
    const k = this.k(ns, key);
    const arr = this.series.get(k) ?? [];
    arr.push({ at, value });
    // prune old + cap
    const cutoff = Date.now() - MAX_AGE_MS;
    let pruned = arr.filter((s) => s.at >= cutoff);
    if (pruned.length > MAX_PER_KEY) pruned = pruned.slice(pruned.length - MAX_PER_KEY);
    this.series.set(k, pruned);
  }

  nearest(ns: string, key: string, targetAgeMs: number, toleranceMs: number): Snapshot | undefined {
    const arr = this.series.get(this.k(ns, key));
    if (!arr || arr.length === 0) return undefined;
    const now = Date.now();
    let best: Snapshot | undefined;
    let bestDiff = Infinity;
    for (const s of arr) {
      const age = now - s.at;
      const diff = Math.abs(age - targetAgeMs);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = s;
      }
    }
    return best && bestDiff <= toleranceMs ? best : undefined;
  }

  keys(ns: string): string[] {
    const prefix = `${ns}::`;
    const out: string[] = [];
    for (const k of this.series.keys()) {
      if (k.startsWith(prefix)) out.push(k.slice(prefix.length));
    }
    return out;
  }
}

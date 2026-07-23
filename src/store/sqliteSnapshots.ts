/**
 * SQLite-backed SnapshotStore: persists the positioning time-series across
 * restarts (the keystone for whale deltas, alerts, and track record). Same
 * interface as InMemorySnapshotStore, so tools are unchanged.
 */
import type Database from "better-sqlite3";
import type { Snapshot, SnapshotStore } from "../core/snapshots.js";

const MAX_AGE_MS = 26 * 3_600_000;

export class SqliteSnapshotStore implements SnapshotStore {
  private writes = 0;

  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        ns    TEXT NOT NULL,
        key   TEXT NOT NULL,
        at    INTEGER NOT NULL,
        value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_ns_key_at ON snapshots(ns, key, at);
    `);
  }

  record(ns: string, key: string, value: unknown, at = Date.now()): void {
    this.db.prepare(`INSERT INTO snapshots (ns, key, at, value) VALUES (?, ?, ?, ?)`).run(
      ns,
      key,
      at,
      JSON.stringify(value),
    );
    // Amortized pruning every 200 writes.
    if (++this.writes % 200 === 0) {
      this.db.prepare(`DELETE FROM snapshots WHERE at < ?`).run(Date.now() - MAX_AGE_MS);
    }
  }

  nearest(ns: string, key: string, targetAgeMs: number, toleranceMs: number): Snapshot | undefined {
    const now = Date.now();
    const target = now - targetAgeMs;
    const row = this.db
      .prepare(
        `SELECT at, value FROM snapshots
         WHERE ns = ? AND key = ? AND at BETWEEN ? AND ?
         ORDER BY ABS(at - ?) ASC LIMIT 1`,
      )
      .get(ns, key, target - toleranceMs, target + toleranceMs, target) as
      | { at: number; value: string }
      | undefined;
    if (!row) return undefined;
    return { at: row.at, value: safeParse(row.value) };
  }

  keys(ns: string): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT key FROM snapshots WHERE ns = ? AND at >= ?`)
      .all(ns, Date.now() - MAX_AGE_MS) as Array<{ key: string }>;
    return rows.map((r) => r.key);
  }

  /** Latest value at/under a timestamp (used by track-record scoring). */
  latestBefore(ns: string, key: string, before: number): Snapshot | undefined {
    const row = this.db
      .prepare(`SELECT at, value FROM snapshots WHERE ns = ? AND key = ? AND at <= ? ORDER BY at DESC LIMIT 1`)
      .get(ns, key, before) as { at: number; value: string } | undefined;
    return row ? { at: row.at, value: safeParse(row.value) } : undefined;
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

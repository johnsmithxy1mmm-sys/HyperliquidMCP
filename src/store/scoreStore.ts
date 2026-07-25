/**
 * Score snapshots + their forward outcomes.
 *
 * Every time a wallet is scored we record (address, score, time). Later a
 * resolver fills in the realized PnL that wallet earned over the forward
 * window. Those pairs are what `calibrate()` needs to answer whether the score
 * has any predictive value — the claim the product currently cannot make.
 *
 * Forward outcome is measured as realized PnL from fills over [ts, ts+horizon],
 * NOT equity change: equity moves with deposits and withdrawals, which have
 * nothing to do with trading skill.
 */
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { ScoredOutcome } from "../smartmoney/calibration.js";
import { log } from "../logger.js";

export interface DueSnapshot {
  id: string;
  address: string;
  ts: number;
  horizonDays: number;
}

/** A snapshot is abandoned after this many failed resolution attempts. */
export const MAX_RESOLVE_ATTEMPTS = 5;

export class ScoreStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS score_snapshots (
        id            TEXT PRIMARY KEY,
        address       TEXT NOT NULL,
        score         REAL NOT NULL,
        account_value REAL NOT NULL,
        ts            INTEGER NOT NULL,
        horizon_days  INTEGER NOT NULL,
        resolved_at   INTEGER,
        forward_pnl   REAL
      );
      CREATE INDEX IF NOT EXISTS idx_score_unresolved ON score_snapshots(resolved_at, ts);
      CREATE INDEX IF NOT EXISTS idx_score_addr_ts ON score_snapshots(address, ts);
    `);
    // Added after v1.2.0: attempt tracking so one permanently failing address
    // cannot sit at the head of the queue forever and starve every later row.
    if (!this.hasColumn("attempts")) {
      db.exec(`ALTER TABLE score_snapshots ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`);
    }
    // Enforce the per-(address, day, horizon) dedupe in the schema, not just in
    // the read-then-write in record(): stdio and http can share one DB file.
    try {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_score_dedupe
          ON score_snapshots(address, horizon_days, ts / 86400000);
      `);
    } catch {
      // A pre-existing DB may already hold duplicates from the read-then-write
      // path. Dedupe is then best-effort in record(); losing the constraint is
      // not worth refusing to start over.
      log.warn("score_snapshots: could not add dedupe index (existing duplicates)");
    }
  }

  private hasColumn(name: string): boolean {
    const cols = this.db.prepare(`PRAGMA table_info(score_snapshots)`).all() as Array<{ name: string }>;
    return cols.some((c) => c.name === name);
  }

  /**
   * Record a scoring observation. Deduped per (address, day, horizon) so
   * repeated tool calls on the same day don't inflate the sample and bias
   * calibration toward whoever gets queried most.
   */
  record(input: {
    address: string;
    score: number;
    accountValue: number;
    horizonDays: number;
    ts?: number;
  }): void {
    const ts = input.ts ?? Date.now();
    const dayStart = Math.floor(ts / 86_400_000) * 86_400_000;
    const existing = this.db
      .prepare(
        `SELECT 1 FROM score_snapshots
         WHERE address = ? AND horizon_days = ? AND ts >= ? AND ts < ?`,
      )
      .get(input.address, input.horizonDays, dayStart, dayStart + 86_400_000);
    if (existing) return;

    this.db
      .prepare(
        `INSERT OR IGNORE INTO score_snapshots (id, address, score, account_value, ts, horizon_days)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), input.address, input.score, input.accountValue, ts, input.horizonDays);
  }

  /**
   * Snapshots whose horizon has elapsed and that still need an outcome.
   *
   * Rows that have already failed MAX_RESOLVE_ATTEMPTS times are excluded. The
   * queue is drained oldest-first with a small limit per tick, so without this
   * a single permanently unresolvable address (deleted account, malformed
   * input) would occupy the head of the queue forever and no later observation
   * would ever be resolved.
   */
  due(limit = 10, now = Date.now()): DueSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT id, address, ts, horizon_days FROM score_snapshots
         WHERE resolved_at IS NULL AND attempts < ? AND (ts + horizon_days * 86400000) <= ?
         ORDER BY attempts ASC, ts ASC LIMIT ?`,
      )
      .all(MAX_RESOLVE_ATTEMPTS, now, limit) as Array<{
      id: string;
      address: string;
      ts: number;
      horizon_days: number;
    }>;
    return rows.map((r) => ({ id: r.id, address: r.address, ts: r.ts, horizonDays: r.horizon_days }));
  }

  /** Record a failed resolution attempt so the row eventually stops retrying. */
  markAttempt(id: string): void {
    this.db.prepare(`UPDATE score_snapshots SET attempts = attempts + 1 WHERE id = ?`).run(id);
  }

  /** Observations abandoned after repeated resolution failures. */
  abandoned(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM score_snapshots WHERE resolved_at IS NULL AND attempts >= ?`)
      .get(MAX_RESOLVE_ATTEMPTS) as { n: number };
    return row.n;
  }

  setOutcome(id: string, forwardPnl: number, resolvedAt = Date.now()): void {
    this.db
      .prepare(`UPDATE score_snapshots SET forward_pnl = ?, resolved_at = ? WHERE id = ?`)
      .run(forwardPnl, resolvedAt, id);
  }

  /** Resolved (score, outcome) pairs for calibration. */
  outcomes(limit = 5000): ScoredOutcome[] {
    const rows = this.db
      .prepare(
        `SELECT score, forward_pnl FROM score_snapshots
         WHERE resolved_at IS NOT NULL AND forward_pnl IS NOT NULL
         ORDER BY ts DESC LIMIT ?`,
      )
      .all(limit) as Array<{ score: number; forward_pnl: number }>;
    return rows.map((r) => ({ score: r.score, forwardPnl: r.forward_pnl }));
  }

  counts(): { total: number; resolved: number; pending: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN resolved_at IS NOT NULL THEN 1 ELSE 0 END) AS resolved
         FROM score_snapshots`,
      )
      .get() as { total: number; resolved: number | null };
    const resolved = row.resolved ?? 0;
    return { total: row.total, resolved, pending: row.total - resolved };
  }
}

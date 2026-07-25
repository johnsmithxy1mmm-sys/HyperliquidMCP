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

export interface DueSnapshot {
  id: string;
  address: string;
  ts: number;
  horizonDays: number;
}

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
        `INSERT INTO score_snapshots (id, address, score, account_value, ts, horizon_days)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), input.address, input.score, input.accountValue, ts, input.horizonDays);
  }

  /** Snapshots whose horizon has elapsed and that still need an outcome. */
  due(limit = 10, now = Date.now()): DueSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT id, address, ts, horizon_days FROM score_snapshots
         WHERE resolved_at IS NULL AND (ts + horizon_days * 86400000) <= ?
         ORDER BY ts ASC LIMIT ?`,
      )
      .all(now, limit) as Array<{ id: string; address: string; ts: number; horizon_days: number }>;
    return rows.map((r) => ({ id: r.id, address: r.address, ts: r.ts, horizonDays: r.horizon_days }));
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

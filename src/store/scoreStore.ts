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

/**
 * How a snapshot's account value was measured. Before v1.14.0 it was the main
 * dex only ("main"), while forward PnL already covered HIP-3 fills; those rows
 * overstate returns for HIP-3 traders and are left out of calibration, of the
 * resolver queue and of the counts reported next to calibration.
 */
export const EQUITY_BASIS = "traded_dexes";

/** A snapshot is abandoned after this many failed resolution attempts. */
export const MAX_RESOLVE_ATTEMPTS = 5;

/**
 * Forward window over which a score's realized PnL outcome is measured.
 * Shared by the tool and the background sampler: if these ever diverged, the
 * two would write into different horizons and neither sample would fill up.
 */
export const SCORE_HORIZON_DAYS = 30;

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
    // Added in v1.14.0; existing rows keep "main".
    if (!this.hasColumn("equity_basis")) {
      db.exec(`ALTER TABLE score_snapshots ADD COLUMN equity_basis TEXT NOT NULL DEFAULT 'main'`);
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
        `INSERT OR IGNORE INTO score_snapshots (id, address, score, account_value, ts, horizon_days, equity_basis)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), input.address, input.score, input.accountValue, ts, input.horizonDays, EQUITY_BASIS);
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
         WHERE resolved_at IS NULL AND attempts < ? AND equity_basis = ? AND (ts + horizon_days * 86400000) <= ?
         ORDER BY attempts ASC, ts ASC LIMIT ?`,
      )
      .all(MAX_RESOLVE_ATTEMPTS, EQUITY_BASIS, now, limit) as Array<{
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

  /**
   * Whether a sample already exists for the given UTC day and horizon.
   *
   * Lets the background sampler be idempotent across restarts: a server that
   * reboots five times in a day must not re-walk the whole cohort five times
   * (the rows would be deduped anyway, but the API calls would not).
   */
  hasSampleForDay(horizonDays: number, ts = Date.now()): boolean {
    const dayStart = Math.floor(ts / 86_400_000) * 86_400_000;
    const row = this.db
      .prepare(
        `SELECT 1 FROM score_snapshots
         WHERE horizon_days = ? AND ts >= ? AND ts < ? LIMIT 1`,
      )
      .get(horizonDays, dayStart, dayStart + 86_400_000);
    return row !== undefined;
  }

  /** Observations abandoned after repeated resolution failures. */
  abandoned(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM score_snapshots WHERE resolved_at IS NULL AND attempts >= ? AND equity_basis = ?`)
      .get(MAX_RESOLVE_ATTEMPTS, EQUITY_BASIS) as { n: number };
    return row.n;
  }

  setOutcome(id: string, forwardPnl: number, resolvedAt = Date.now()): void {
    this.db
      .prepare(`UPDATE score_snapshots SET forward_pnl = ?, resolved_at = ? WHERE id = ?`)
      .run(forwardPnl, resolvedAt, id);
  }

  /**
   * Resolved (score, outcome) pairs for calibration. The outcome is a return on
   * the account value at sampling time: the score rewards account size, so raw
   * USD PnL would correlate with it through size alone.
   */
  outcomes(limit = 5000): ScoredOutcome[] {
    const rows = this.db
      .prepare(
        `SELECT address, ts, horizon_days, score, forward_pnl, account_value FROM score_snapshots
         WHERE resolved_at IS NOT NULL AND forward_pnl IS NOT NULL AND account_value > 0 AND equity_basis = ?
         ORDER BY address, ts ASC`,
      )
      .all(EQUITY_BASIS) as Array<{ address: string; ts: number; horizon_days: number; score: number; forward_pnl: number; account_value: number }>;
    // The sampler scores the same wallets daily over a 30-day forward window,
    // so consecutive rows of one wallet share almost all of their outcome and
    // would inflate n (and shrink the p-value) without adding evidence. Keep,
    // per wallet, only rows whose forward windows do not overlap.
    const kept: typeof rows = [];
    let lastAddress = "";
    let windowEnd = -Infinity;
    for (const r of rows) {
      if (r.address !== lastAddress) {
        lastAddress = r.address;
        windowEnd = -Infinity;
      }
      if (r.ts < windowEnd) continue;
      kept.push(r);
      windowEnd = r.ts + r.horizon_days * 86_400_000;
    }
    return kept
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit)
      .map((r) => ({ score: r.score, forwardReturn: r.forward_pnl / r.account_value }));
  }

  counts(): { total: number; resolved: number; pending: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN resolved_at IS NOT NULL THEN 1 ELSE 0 END) AS resolved
         FROM score_snapshots WHERE equity_basis = ?`,
      )
      .get(EQUITY_BASIS) as { total: number; resolved: number | null };
    const resolved = row.resolved ?? 0;
    return { total: row.total, resolved, pending: row.total - resolved };
  }
}

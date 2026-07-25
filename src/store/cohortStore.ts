/**
 * Persisted whale cohort. Replaces the hand-maintained HL_WHALE_ADDRESSES list
 * with a snapshot that a background job refreshes, so the cohort stays current
 * without manual work and survives restarts.
 *
 * Stored as a full replacement per refresh (not incremental): a cohort is a
 * ranked set at a point in time, and partial updates would mix rankings from
 * different moments.
 */
import type Database from "better-sqlite3";
import type { RankedWallet } from "../hl/cohortRank.js";

export interface CohortSnapshot {
  addresses: string[];
  wallets: RankedWallet[];
  strategy: string;
  refreshedAt: number;
  ageSeconds: number;
}

export class CohortStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS whale_cohort (
        address       TEXT NOT NULL,
        rank          INTEGER NOT NULL,
        account_value REAL NOT NULL,
        pnl           REAL NOT NULL,
        rank_by       REAL NOT NULL,
        strategy      TEXT NOT NULL,
        refreshed_at  INTEGER NOT NULL,
        PRIMARY KEY (address)
      );
      CREATE INDEX IF NOT EXISTS idx_whale_cohort_rank ON whale_cohort(rank);
    `);
  }

  /** Atomically replace the cohort with a freshly ranked set. */
  replace(wallets: RankedWallet[], strategy: string, refreshedAt = Date.now()): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM whale_cohort`).run();
      const insert = this.db.prepare(
        `INSERT INTO whale_cohort (address, rank, account_value, pnl, rank_by, strategy, refreshed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      wallets.forEach((w, i) => {
        insert.run(w.address, i, w.accountValue, w.pnl, w.rankBy, strategy, refreshedAt);
      });
    });
    tx();
  }

  /** Current cohort, or null if never refreshed. */
  get(limit = 200, now = Date.now()): CohortSnapshot | null {
    const rows = this.db
      .prepare(
        `SELECT address, account_value, pnl, rank_by, strategy, refreshed_at
         FROM whale_cohort ORDER BY rank ASC LIMIT ?`,
      )
      .all(limit) as Array<{
      address: string;
      account_value: number;
      pnl: number;
      rank_by: number;
      strategy: string;
      refreshed_at: number;
    }>;
    if (rows.length === 0) return null;

    const refreshedAt = rows[0].refreshed_at;
    return {
      addresses: rows.map((r) => r.address),
      wallets: rows.map((r) => ({
        address: r.address,
        accountValue: r.account_value,
        pnl: r.pnl,
        rankBy: r.rank_by,
      })),
      strategy: rows[0].strategy,
      refreshedAt,
      ageSeconds: Math.max(0, Math.round((now - refreshedAt) / 1000)),
    };
  }
}

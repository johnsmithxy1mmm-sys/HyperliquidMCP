/**
 * SQLite storage for billing: API keys, monthly usage counters, and consumed
 * x402 payment nonces (replay protection). Uses better-sqlite3 (synchronous).
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TierName } from "./tiers.js";
import { log } from "../logger.js";

export interface KeyRow {
  keyHash: string;
  tier: TierName;
  label: string | null;
  createdAt: number;
  disabled: number;
}

let db: Database.Database | undefined;

export function getDb(path: string): Database.Database {
  if (db) return db;
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    /* dir may already exist */
  }
  db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      key_hash   TEXT PRIMARY KEY,
      tier       TEXT NOT NULL,
      label      TEXT,
      created_at INTEGER NOT NULL,
      disabled   INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS usage_counters (
      key_hash TEXT NOT NULL,
      period   TEXT NOT NULL,           -- 'YYYY-MM'
      tool     TEXT NOT NULL,
      count    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (key_hash, period, tool)
    );
    CREATE TABLE IF NOT EXISTS x402_payments (
      payment_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
  `);
  log.info("billing db ready", { path });
  return db;
}

export function upsertKey(database: Database.Database, keyHash: string, tier: TierName, label?: string): void {
  database
    .prepare(
      `INSERT INTO api_keys (key_hash, tier, label, created_at, disabled)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(key_hash) DO UPDATE SET tier=excluded.tier, label=excluded.label`,
    )
    .run(keyHash, tier, label ?? null, Date.now());
}

export function getKey(database: Database.Database, keyHash: string): KeyRow | undefined {
  const row = database.prepare(`SELECT * FROM api_keys WHERE key_hash = ?`).get(keyHash) as
    | { key_hash: string; tier: TierName; label: string | null; created_at: number; disabled: number }
    | undefined;
  if (!row) return undefined;
  return {
    keyHash: row.key_hash,
    tier: row.tier,
    label: row.label,
    createdAt: row.created_at,
    disabled: row.disabled,
  };
}

/** Atomically increment and return the new monthly count for (key, tool). */
export function incrementUsage(database: Database.Database, keyHash: string, period: string, tool: string): number {
  const tx = database.transaction(() => {
    database
      .prepare(
        `INSERT INTO usage_counters (key_hash, period, tool, count) VALUES (?, ?, ?, 1)
         ON CONFLICT(key_hash, period, tool) DO UPDATE SET count = count + 1`,
      )
      .run(keyHash, period, tool);
    const row = database
      .prepare(`SELECT COALESCE(SUM(count),0) AS total FROM usage_counters WHERE key_hash = ? AND period = ?`)
      .get(keyHash, period) as { total: number };
    return row.total;
  });
  return tx();
}

export function monthlyTotal(database: Database.Database, keyHash: string, period: string): number {
  const row = database
    .prepare(`SELECT COALESCE(SUM(count),0) AS total FROM usage_counters WHERE key_hash = ? AND period = ?`)
    .get(keyHash, period) as { total: number };
  return row.total;
}

/** Returns true if the payment id is new (and records it); false if already consumed. */
export function consumePaymentId(database: Database.Database, paymentId: string): boolean {
  try {
    database.prepare(`INSERT INTO x402_payments (payment_id, created_at) VALUES (?, ?)`).run(paymentId, Date.now());
    return true;
  } catch {
    return false; // primary-key conflict => replay
  }
}

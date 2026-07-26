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
    -- Self-serve free keys. Keyed by a HASHED client fingerprint (never the raw
    -- IP) so one requester holds at most one active free key at a time.
    CREATE TABLE IF NOT EXISTS free_key_grants (
      fingerprint TEXT PRIMARY KEY,
      key_hash    TEXT NOT NULL,
      granted_at  INTEGER NOT NULL,
      grants      INTEGER NOT NULL DEFAULT 1
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
       ON CONFLICT(key_hash) DO UPDATE SET tier=excluded.tier, label=excluded.label, disabled=0`,
    )
    .run(keyHash, tier, label ?? null, Date.now());
}

/**
 * Revoke env-provisioned keys that are no longer present in the environment.
 * Only touches rows labeled '%-bootstrap' (keys provisioned from env), so keys
 * added through other channels are never mass-disabled. Returns rows changed.
 */
export function disableMissingBootstrapKeys(database: Database.Database, presentHashes: string[]): number {
  if (presentHashes.length === 0) {
    return database.prepare(`UPDATE api_keys SET disabled=1 WHERE label LIKE '%-bootstrap' AND disabled=0`).run()
      .changes;
  }
  const placeholders = presentHashes.map(() => "?").join(",");
  return database
    .prepare(
      `UPDATE api_keys SET disabled=1
       WHERE label LIKE '%-bootstrap' AND disabled=0 AND key_hash NOT IN (${placeholders})`,
    )
    .run(...presentHashes).changes;
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

/**
 * Undo a reservation made by consumePaymentId when the payment turned out not
 * to settle. Only call this when settlement is KNOWN to have failed — releasing
 * on an unknown outcome would re-open the id to a double charge.
 */
export function releasePaymentId(database: Database.Database, paymentId: string): void {
  database.prepare(`DELETE FROM x402_payments WHERE payment_id = ?`).run(paymentId);
}

export interface FreeKeyGrant {
  fingerprint: string;
  keyHash: string;
  grantedAt: number;
  grants: number;
}

export function getFreeKeyGrant(database: Database.Database, fingerprint: string): FreeKeyGrant | undefined {
  const row = database.prepare(`SELECT * FROM free_key_grants WHERE fingerprint = ?`).get(fingerprint) as
    | { fingerprint: string; key_hash: string; granted_at: number; grants: number }
    | undefined;
  return row
    ? { fingerprint: row.fingerprint, keyHash: row.key_hash, grantedAt: row.granted_at, grants: row.grants }
    : undefined;
}

export function countFreeKeyGrants(database: Database.Database): number {
  return (database.prepare(`SELECT COUNT(*) AS c FROM free_key_grants`).get() as { c: number }).c;
}

/**
 * Record a self-serve free key for a fingerprint, replacing any previous one.
 *
 * Re-issuing revokes the old key AND moves its usage counters onto the new
 * hash. Without the transfer, "lose the key, ask again" would be a free quota
 * reset — one requester could mint an unlimited number of 100-call allowances.
 * Atomic so a crash can never leave a live old key beside a fresh counter.
 */
export function recordFreeKeyGrant(
  database: Database.Database,
  fingerprint: string,
  newKeyHash: string,
  now = Date.now(),
): void {
  const tx = database.transaction(() => {
    const prior = getFreeKeyGrant(database, fingerprint);
    if (prior) {
      database.prepare(`UPDATE api_keys SET disabled = 1 WHERE key_hash = ?`).run(prior.keyHash);
      database.prepare(`UPDATE usage_counters SET key_hash = ? WHERE key_hash = ?`).run(newKeyHash, prior.keyHash);
    }
    database
      .prepare(
        `INSERT INTO free_key_grants (fingerprint, key_hash, granted_at, grants)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(fingerprint) DO UPDATE SET
           key_hash = excluded.key_hash,
           granted_at = excluded.granted_at,
           grants = grants + 1`,
      )
      .run(fingerprint, newKeyHash, now);
  });
  tx();
}

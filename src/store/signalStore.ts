/**
 * Persistent store for emitted signals + their forward-return scoring. Powers a
 * transparent, verifiable track record ("our whale alerts show X% 24h edge").
 */
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export interface SignalRow {
  id: string;
  type: string;
  coin: string;
  direction: "long" | "short" | "neutral";
  refPx: number;
  ts: number;
  horizonMinutes: number;
  signature: string | null;
  scoredAt: number | null;
  scoredPx: number | null;
  forwardReturn: number | null; // signed, direction-adjusted fraction
}

export interface TrackRecord {
  type: string;
  total: number;
  scored: number;
  wins: number;
  hitRatePct: number;
  avgReturnPct: number;
  medianReturnPct: number;
}

export class SignalStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS signals (
        id             TEXT PRIMARY KEY,
        type           TEXT NOT NULL,
        coin           TEXT NOT NULL,
        direction      TEXT NOT NULL,
        ref_px         REAL NOT NULL,
        ts             INTEGER NOT NULL,
        horizon_minutes INTEGER NOT NULL,
        signature      TEXT,
        scored_at      INTEGER,
        scored_px      REAL,
        forward_return REAL
      );
      CREATE INDEX IF NOT EXISTS idx_signals_type ON signals(type);
      CREATE INDEX IF NOT EXISTS idx_signals_unscored ON signals(scored_at, ts);
    `);
  }

  record(input: {
    type: string;
    coin: string;
    direction: "long" | "short" | "neutral";
    refPx: number;
    horizonMinutes: number;
    signature?: string;
    ts?: number;
  }): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO signals (id, type, coin, direction, ref_px, ts, horizon_minutes, signature)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.type, input.coin, input.direction, input.refPx, input.ts ?? Date.now(), input.horizonMinutes, input.signature ?? null);
    return id;
  }

  /** Signals whose horizon has elapsed and are not yet scored. */
  dueForScoring(now = Date.now()): SignalRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM signals WHERE scored_at IS NULL AND (ts + horizon_minutes * 60000) <= ? ORDER BY ts ASC LIMIT 500`,
      )
      .all(now) as RawSignal[];
    return rows.map(mapRow);
  }

  setScore(id: string, scoredPx: number, forwardReturn: number, scoredAt = Date.now()): void {
    this.db
      .prepare(`UPDATE signals SET scored_at = ?, scored_px = ?, forward_return = ? WHERE id = ?`)
      .run(scoredAt, scoredPx, forwardReturn, id);
  }

  trackRecord(type?: string): TrackRecord[] {
    // Bounded to the most recent 10k signals so this stays fast after months
    // of accumulation (the full history remains in the table).
    const recent = `SELECT * FROM (SELECT * FROM signals ORDER BY ts DESC LIMIT 10000)`;
    const rows = (
      type
        ? this.db.prepare(`${recent} WHERE type = ?`).all(type)
        : this.db.prepare(recent).all()
    ) as RawSignal[];
    const byType = new Map<string, SignalRow[]>();
    for (const r of rows.map(mapRow)) {
      const arr = byType.get(r.type) ?? [];
      arr.push(r);
      byType.set(r.type, arr);
    }
    const out: TrackRecord[] = [];
    for (const [t, sigs] of byType) {
      const scored = sigs.filter((s) => s.forwardReturn !== null);
      const returns = scored.map((s) => s.forwardReturn as number);
      const wins = returns.filter((r) => r > 0).length;
      out.push({
        type: t,
        total: sigs.length,
        scored: scored.length,
        wins,
        hitRatePct: scored.length ? round((wins / scored.length) * 100) : 0,
        avgReturnPct: returns.length ? round((returns.reduce((a, b) => a + b, 0) / returns.length) * 100) : 0,
        medianReturnPct: returns.length ? round(median(returns) * 100) : 0,
      });
    }
    return out.sort((a, b) => b.scored - a.scored);
  }
}

interface RawSignal {
  id: string;
  type: string;
  coin: string;
  direction: string;
  ref_px: number;
  ts: number;
  horizon_minutes: number;
  signature: string | null;
  scored_at: number | null;
  scored_px: number | null;
  forward_return: number | null;
}

function mapRow(r: RawSignal): SignalRow {
  return {
    id: r.id,
    type: r.type,
    coin: r.coin,
    direction: r.direction as "long" | "short" | "neutral",
    refPx: r.ref_px,
    ts: r.ts,
    horizonMinutes: r.horizon_minutes,
    signature: r.signature,
    scoredAt: r.scored_at,
    scoredPx: r.scored_px,
    forwardReturn: r.forward_return,
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function round(x: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/**
 * Persistent store for standing alerts and their fired events.
 */
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { AlertRecord, AlertType, AlertParams, FiredEvent } from "../alerts/types.js";

interface AlertRow {
  id: string;
  subject: string;
  type: string;
  params: string;
  enabled: number;
  cooldown_minutes: number;
  last_fired_at: number | null;
  last_state: string | null;
  created_at: number;
}

export class AlertStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS alerts (
        id              TEXT PRIMARY KEY,
        subject         TEXT NOT NULL,
        type            TEXT NOT NULL,
        params          TEXT NOT NULL,
        enabled         INTEGER NOT NULL DEFAULT 1,
        cooldown_minutes INTEGER NOT NULL DEFAULT 60,
        last_fired_at   INTEGER,
        last_state      TEXT,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_alerts_subject ON alerts(subject);
      CREATE TABLE IF NOT EXISTS fired_events (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_id TEXT NOT NULL,
        subject  TEXT NOT NULL,
        at       INTEGER NOT NULL,
        message  TEXT NOT NULL,
        payload  TEXT NOT NULL,
        acked    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_fired_subject_acked ON fired_events(subject, acked);
    `);
  }

  create(subject: string, type: AlertType, params: AlertParams, cooldownMinutes: number): AlertRecord {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO alerts (id, subject, type, params, enabled, cooldown_minutes, last_fired_at, last_state, created_at)
         VALUES (?, ?, ?, ?, 1, ?, NULL, NULL, ?)`,
      )
      .run(id, subject, type, JSON.stringify(params), cooldownMinutes, now);
    return {
      id,
      subject,
      type,
      params,
      enabled: true,
      cooldownMinutes,
      lastFiredAt: null,
      lastState: null,
      createdAt: now,
    };
  }

  private map(r: AlertRow): AlertRecord {
    return {
      id: r.id,
      subject: r.subject,
      type: r.type as AlertType,
      params: JSON.parse(r.params) as AlertParams,
      enabled: r.enabled === 1,
      cooldownMinutes: r.cooldown_minutes,
      lastFiredAt: r.last_fired_at,
      lastState: r.last_state ? JSON.parse(r.last_state) : null,
      createdAt: r.created_at,
    };
  }

  list(subject: string): AlertRecord[] {
    return (this.db.prepare(`SELECT * FROM alerts WHERE subject = ? ORDER BY created_at DESC`).all(subject) as AlertRow[]).map(
      (r) => this.map(r),
    );
  }

  listActive(): AlertRecord[] {
    return (this.db.prepare(`SELECT * FROM alerts WHERE enabled = 1`).all() as AlertRow[]).map((r) => this.map(r));
  }

  /** Returns true if a row was deleted (ownership enforced by subject). */
  delete(id: string, subject: string): boolean {
    return this.db.prepare(`DELETE FROM alerts WHERE id = ? AND subject = ?`).run(id, subject).changes > 0;
  }

  updateState(id: string, lastState: unknown, lastFiredAt: number | null): void {
    this.db
      .prepare(`UPDATE alerts SET last_state = ?, last_fired_at = ? WHERE id = ?`)
      .run(lastState === undefined ? null : JSON.stringify(lastState), lastFiredAt, id);
  }

  recordFired(alertId: string, subject: string, at: number, message: string, payload: Record<string, unknown>): void {
    this.db
      .prepare(`INSERT INTO fired_events (alert_id, subject, at, message, payload, acked) VALUES (?, ?, ?, ?, ?, 0)`)
      .run(alertId, subject, at, message, JSON.stringify(payload));
    // Keep the table bounded: delivered events older than 30 days are history.
    this.db.prepare(`DELETE FROM fired_events WHERE acked = 1 AND at < ?`).run(Date.now() - 30 * 86_400_000);
  }

  /** Return unacked events for a subject and mark them acked (at-least-once delivery). */
  pollUnacked(subject: string, limit = 50): FiredEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM fired_events WHERE subject = ? AND acked = 0 ORDER BY at ASC LIMIT ?`)
      .all(subject, limit) as Array<{ id: number; alert_id: string; subject: string; at: number; message: string; payload: string }>;
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      this.db.prepare(`UPDATE fired_events SET acked = 1 WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
    }
    return rows.map((r) => ({
      id: r.id,
      alertId: r.alert_id,
      subject: r.subject,
      at: r.at,
      message: r.message,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
    }));
  }
}

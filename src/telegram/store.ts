/**
 * Which Telegram chat receives an API key's alerts, and the one-time codes
 * that link them (alerts belong to a key, so the key owner proves control by
 * opening a code the key minted).
 */
import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";

const LINK_CODE_TTL_MS = 15 * 60_000;

export class TelegramStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_links (
        subject   TEXT PRIMARY KEY,
        chat_id   TEXT NOT NULL,
        linked_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS telegram_codes (
        code       TEXT PRIMARY KEY,
        subject    TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  createLinkCode(subject: string, now = Date.now()): string {
    const code = randomBytes(8).toString("hex");
    this.db.prepare(`DELETE FROM telegram_codes WHERE expires_at < ?`).run(now);
    this.db.prepare(`INSERT INTO telegram_codes (code, subject, expires_at) VALUES (?, ?, ?)`).run(code, subject, now + LINK_CODE_TTL_MS);
    return code;
  }

  /** Consume a code and link its key to `chatId`; undefined if unknown or expired. */
  redeem(code: string, chatId: string, now = Date.now()): string | undefined {
    const row = this.db.prepare(`SELECT subject, expires_at FROM telegram_codes WHERE code = ?`).get(code) as
      | { subject: string; expires_at: number }
      | undefined;
    if (!row) return undefined;
    this.db.prepare(`DELETE FROM telegram_codes WHERE code = ?`).run(code);
    if (row.expires_at < now) return undefined;
    this.link(row.subject, chatId, now);
    return row.subject;
  }

  link(subject: string, chatId: string, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO telegram_links (subject, chat_id, linked_at) VALUES (?, ?, ?)
         ON CONFLICT(subject) DO UPDATE SET chat_id = excluded.chat_id, linked_at = excluded.linked_at`,
      )
      .run(subject, chatId, now);
  }

  chatFor(subject: string): string | undefined {
    const row = this.db.prepare(`SELECT chat_id FROM telegram_links WHERE subject = ?`).get(subject) as
      | { chat_id: string }
      | undefined;
    return row?.chat_id;
  }

  unlink(subject: string): boolean {
    return this.db.prepare(`DELETE FROM telegram_links WHERE subject = ?`).run(subject).changes > 0;
  }

  unlinkChat(chatId: string): number {
    return this.db.prepare(`DELETE FROM telegram_links WHERE chat_id = ?`).run(chatId).changes;
  }
}

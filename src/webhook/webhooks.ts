/**
 * Webhook delivery for standing alerts: one HTTPS URL per API key, each POST
 * HMAC-signed. The server makes outbound requests to caller-chosen URLs, so
 * every target is checked against private and internal address ranges (on
 * set and again on every send, against DNS rebinding) and redirects are not
 * followed.
 */
import type Database from "better-sqlite3";
import { createHmac, randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ToolError } from "../core/errors.js";
import { log } from "../logger.js";

const MAX_PER_HOUR = 30;
const TIMEOUT_MS = 5_000;

export type Lookup = (host: string) => Promise<Array<{ address: string; family: number }>>;
const defaultLookup: Lookup = (host) => dnsLookup(host, { all: true });

/** Loopback, private, link-local, CGNAT, unspecified and ULA ranges (incl. IPv4-mapped IPv6). */
export function isPrivateAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const addr = mapped ? mapped[1] : ip;
  if (isIP(addr) === 4) {
    const [a, b] = addr.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  const v6 = addr.toLowerCase();
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6);
}

/** Throws unless `url` is https and every address it resolves to is public. */
export async function assertPublicHttpsUrl(url: string, lookup: Lookup = defaultLookup): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ToolError("bad_webhook_url", "Not a valid URL.");
  }
  if (parsed.protocol !== "https:") throw new ToolError("bad_webhook_url", "Webhook URLs must use https.");
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host);
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new ToolError("bad_webhook_url", "Webhook URLs must resolve to public addresses only.");
  }
}

export class WebhookStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS webhooks (
        subject    TEXT PRIMARY KEY,
        url        TEXT NOT NULL,
        secret     TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  /** Set the key's URL with a fresh signing secret, returned to show once. */
  set(subject: string, url: string, now = Date.now()): string {
    const secret = randomBytes(32).toString("hex");
    this.db
      .prepare(
        `INSERT INTO webhooks (subject, url, secret, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(subject) DO UPDATE SET url = excluded.url, secret = excluded.secret, created_at = excluded.created_at`,
      )
      .run(subject, url, secret, now);
    return secret;
  }

  get(subject: string): { url: string; secret: string } | undefined {
    return this.db.prepare(`SELECT url, secret FROM webhooks WHERE subject = ?`).get(subject) as
      | { url: string; secret: string }
      | undefined;
  }

  delete(subject: string): boolean {
    return this.db.prepare(`DELETE FROM webhooks WHERE subject = ?`).run(subject).changes > 0;
  }
}

export class WebhookSender {
  private readonly sentAt = new Map<string, number[]>();

  constructor(
    private readonly store: WebhookStore,
    private readonly lookup: Lookup = defaultLookup,
  ) {}

  async set(subject: string, url: string): Promise<string> {
    await assertPublicHttpsUrl(url, this.lookup);
    return this.store.set(subject, url);
  }

  delete(subject: string): boolean {
    return this.store.delete(subject);
  }

  /** POST a fired alert to the key's webhook, signed, within the hourly cap. */
  async notify(subject: string, payload: Record<string, unknown>, now = Date.now()): Promise<boolean> {
    const hook = this.store.get(subject);
    if (!hook) return false;
    const recent = (this.sentAt.get(subject) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= MAX_PER_HOUR) return false;
    this.sentAt.set(subject, [...recent, now]);
    try {
      await assertPublicHttpsUrl(hook.url, this.lookup); // DNS may have changed since it was set
      const body = JSON.stringify(payload);
      const signature = `sha256=${createHmac("sha256", hook.secret).update(body).digest("hex")}`;
      await fetch(hook.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hypersignal-signature": signature },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return true;
    } catch (err) {
      log.warn("webhook delivery failed", { err: String(err) });
      return false;
    }
  }
}

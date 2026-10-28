/**
 * Telegram delivery for standing alerts. One bot for the service: a key links
 * its chat with /start <code>, fired alerts are pushed there, and house
 * signals can go to a public channel. Long polling (one machine), no webhook.
 */
import type { TelegramStore } from "./store.js";
import { HOUSE_SUBJECT } from "../alerts/house.js";
import { log } from "../logger.js";

/** Per-chat cap: spam guard and Telegram's own limits; the rest stays in hl_poll_alerts. */
const MAX_MESSAGES_PER_HOUR = 30;
const POLL_TIMEOUT_S = 25;

export interface TelegramUpdate {
  update_id: number;
  message?: { chat: { id: number | string }; text?: string };
}

export class TelegramBot {
  private username: string | undefined;
  private readonly sentAt = new Map<string, number[]>();
  private offset = 0;
  private running = false;

  constructor(
    private readonly token: string,
    private readonly store: TelegramStore,
    private readonly opts: { channelId?: string; publicBaseUrl?: string } = {},
  ) {}

  private async api<T>(method: string, body: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json()) as { ok?: boolean; result?: T; description?: string };
    if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? res.status}`);
    return json.result as T;
  }

  /** One-time t.me link that ties `subject`'s alerts to whichever chat opens it. */
  async linkFor(subject: string): Promise<string> {
    return `https://t.me/${await this.botUsername()}?start=${this.store.createLinkCode(subject)}`;
  }

  unlink(subject: string): boolean {
    return this.store.unlink(subject);
  }

  async botUsername(): Promise<string> {
    this.username ??= (await this.api<{ username: string }>("getMe")).username;
    return this.username;
  }

  /** Send to one chat within its hourly cap; false when capped or failed. */
  async send(chatId: string, text: string, now = Date.now()): Promise<boolean> {
    const recent = (this.sentAt.get(chatId) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= MAX_MESSAGES_PER_HOUR) return false;
    this.sentAt.set(chatId, [...recent, now]);
    try {
      await this.api("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
      return true;
    } catch (err) {
      log.warn("telegram send failed", { err: String(err) });
      return false;
    }
  }

  /** Push a fired alert to its owner's chat, or a house signal to the public channel. */
  async notify(subject: string, message: string): Promise<void> {
    const chatId = subject === HOUSE_SUBJECT ? this.opts.channelId : this.store.chatFor(subject);
    if (!chatId) return;
    const verify = this.opts.publicBaseUrl ? `\n\nTrack record: ${this.opts.publicBaseUrl}/track-record` : "";
    await this.send(chatId, `🔔 ${message}${verify}`);
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const chatId = update.message ? String(update.message.chat.id) : undefined;
    const text = update.message?.text?.trim() ?? "";
    if (!chatId) return;
    if (text.startsWith("/start")) {
      const code = text.split(/\s+/)[1];
      const subject = code ? this.store.redeem(code, chatId) : undefined;
      await this.send(
        chatId,
        subject
          ? "Linked: alerts for your HyperSignal key will arrive here. Send /stop to unlink."
          : "This link has expired or was already used. Get a new one with hl_link_telegram.",
      );
    } else if (text === "/stop") {
      const removed = this.store.unlinkChat(chatId);
      await this.send(chatId, removed ? "Unlinked: no more alerts here." : "Nothing was linked to this chat.");
    }
  }

  /** Long-poll getUpdates until stop(). */
  start(): void {
    if (this.running) return;
    this.running = true;
    void (async () => {
      while (this.running) {
        try {
          const updates = await this.api<TelegramUpdate[]>(
            "getUpdates",
            { offset: this.offset, timeout: POLL_TIMEOUT_S, allowed_updates: ["message"] },
            (POLL_TIMEOUT_S + 10) * 1000,
          );
          for (const u of updates) {
            this.offset = u.update_id + 1;
            await this.handleUpdate(u);
          }
        } catch (err) {
          log.warn("telegram poll failed", { err: String(err) });
          await new Promise((resolve) => setTimeout(resolve, 5_000).unref());
        }
      }
    })();
    log.info("telegram bot polling");
  }

  stop(): void {
    this.running = false;
  }
}

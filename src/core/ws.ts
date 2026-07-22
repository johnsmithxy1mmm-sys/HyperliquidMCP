/**
 * Live mid-price feed over Hyperliquid WebSocket (`allMids` subscription).
 * Graceful degradation (hard rule #4): if the socket is disabled, not yet
 * connected, or dropped, `getMid()` falls back to REST metaAndAssetCtxs.
 *
 * Lazy: the socket only connects on first `ensureConnected()`. stdio quick-use
 * works without ever opening a socket.
 */
import WebSocket from "ws";
import type { Config } from "../config.js";
import type { HyperliquidClient } from "./hlClient.js";
import { log } from "../logger.js";

export class MidsFeed {
  private ws: WebSocket | undefined;
  private mids = new Map<string, number>();
  private connected = false;
  private connecting = false;
  private reconnectDelay = 1_000;
  private lastMsgAt = 0;

  constructor(
    private readonly config: Config,
    private readonly hl: HyperliquidClient,
  ) {}

  ensureConnected(): void {
    if (!this.config.wsEnabled || this.connected || this.connecting) return;
    this.connecting = true;
    try {
      const ws = new WebSocket(this.config.wsUrl);
      this.ws = ws;

      ws.on("open", () => {
        this.connected = true;
        this.connecting = false;
        this.reconnectDelay = 1_000;
        ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "allMids" } }));
        log.info("ws connected", { url: this.config.wsUrl });
      });

      ws.on("message", (raw: WebSocket.RawData) => {
        this.lastMsgAt = Date.now();
        try {
          const msg = JSON.parse(raw.toString()) as { channel?: string; data?: { mids?: Record<string, string> } };
          if (msg.channel === "allMids" && msg.data?.mids) {
            for (const [coin, px] of Object.entries(msg.data.mids)) {
              const n = Number(px);
              if (Number.isFinite(n)) this.mids.set(coin, n);
            }
          }
        } catch {
          /* ignore malformed frames */
        }
      });

      ws.on("close", () => this.onDrop("close"));
      ws.on("error", (err) => {
        log.warn("ws error", { err: String(err) });
        this.onDrop("error");
      });
    } catch (err) {
      this.connecting = false;
      log.warn("ws connect failed", { err: String(err) });
    }
  }

  private onDrop(reason: string): void {
    this.connected = false;
    this.connecting = false;
    try {
      this.ws?.removeAllListeners();
      this.ws?.terminate();
    } catch {
      /* noop */
    }
    this.ws = undefined;
    if (!this.config.wsEnabled) return;
    log.warn("ws dropped, scheduling reconnect", { reason, delay: this.reconnectDelay });
    setTimeout(() => this.ensureConnected(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
  }

  private isFresh(): boolean {
    return this.connected && this.lastMsgAt > 0 && Date.now() - this.lastMsgAt < 15_000;
  }

  /** Get a coin's mid price; live if available, else REST fallback. */
  async getMid(coin: string): Promise<number | undefined> {
    this.ensureConnected();
    if (this.isFresh()) {
      const live = this.mids.get(coin);
      if (live !== undefined) return live;
    }
    // REST fallback.
    const [meta, ctxs] = await this.hl.metaAndAssetCtxs();
    const idx = meta.universe.findIndex((a) => a.name === coin);
    if (idx < 0) return undefined;
    const ctx = ctxs[idx];
    const mid = ctx?.midPx ?? ctx?.markPx;
    return mid ? Number(mid) : undefined;
  }

  close(): void {
    this.config.wsEnabled = false;
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
    this.ws = undefined;
    this.connected = false;
  }
}

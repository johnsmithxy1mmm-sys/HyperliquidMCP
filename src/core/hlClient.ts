/**
 * Typed Hyperliquid Info API client. Every method maps 1:1 to a verified Info
 * request type (docs/PHASE0.md). Caching + rate limiting are applied here so
 * tools stay thin. No invented endpoints (hard rule #6).
 */
import type { Config } from "../config.js";
import { TtlLruCache, TTL } from "./cache.js";
import { RateLimiter } from "./rateLimiter.js";
import { postJson } from "./http.js";
import type {
  MetaAndAssetCtxs,
  PerpMeta,
  L2Book,
  Candle,
  FundingHistoryEntry,
  ClearinghouseState,
  OpenOrder,
  UserFill,
  PredictedFundings,
  PerpDexEntry,
} from "../hl/types.js";

/** Max rows userFillsByTime returns per call (Hyperliquid Info API). */
const FILLS_PAGE_LIMIT = 2000;
/** Hard bound on paging so one wallet can never monopolize the weight budget. */
const FILLS_MAX_PAGES = 10;

export class HyperliquidClient {
  private readonly cache = new TtlLruCache();
  private readonly limiter: RateLimiter;

  constructor(private readonly config: Config) {
    this.limiter = new RateLimiter(config.rateWeightPerMin);
  }

  private async info<T>(body: Record<string, unknown>, weight = 2): Promise<T> {
    await this.limiter.acquire(weight);
    return postJson<T>(this.config.infoBaseUrl, body, {
      timeoutMs: this.config.requestTimeoutMs,
      maxRetries: this.config.maxRetries,
    });
  }

  // ---- Metadata / markets ----------------------------------------------------

  metaAndAssetCtxs(): Promise<MetaAndAssetCtxs> {
    return this.cache.getOrLoad("metaAndAssetCtxs", TTL.markets, () =>
      this.info<MetaAndAssetCtxs>({ type: "metaAndAssetCtxs" }, 2),
    );
  }

  perpMeta(): Promise<PerpMeta> {
    return this.cache.getOrLoad("meta", TTL.metadata, () => this.info<PerpMeta>({ type: "meta" }, 2));
  }

  spotMetaAndAssetCtxs(): Promise<unknown> {
    return this.cache.getOrLoad("spotMetaAndAssetCtxs", TTL.markets, () =>
      this.info<unknown>({ type: "spotMetaAndAssetCtxs" }, 2),
    );
  }

  /** Builder-deployed perp dex list (HIP-3). First entry is null (default dex). */
  perpDexs(): Promise<PerpDexEntry[]> {
    return this.cache.getOrLoad("perpDexs", TTL.metadata, () => this.info<PerpDexEntry[]>({ type: "perpDexs" }, 2));
  }

  /** metaAndAssetCtxs scoped to a builder dex. Callers must try/catch — coverage varies. */
  metaAndAssetCtxsForDex(dex: string): Promise<MetaAndAssetCtxs> {
    return this.cache.getOrLoad(`metaAndAssetCtxs:${dex}`, TTL.markets, () =>
      this.info<MetaAndAssetCtxs>({ type: "metaAndAssetCtxs", dex }, 2),
    );
  }

  predictedFundings(): Promise<PredictedFundings> {
    return this.cache.getOrLoad("predictedFundings", TTL.markets, () =>
      this.info<PredictedFundings>({ type: "predictedFundings" }, 2),
    );
  }

  // ---- Per-coin market data --------------------------------------------------

  l2Book(coin: string): Promise<L2Book> {
    return this.cache.getOrLoad(`l2:${coin}`, TTL.orderbook, () =>
      this.info<L2Book>({ type: "l2Book", coin }, 2),
    );
  }

  candles(coin: string, interval: string, startTime: number, endTime: number): Promise<Candle[]> {
    const key = `candles:${coin}:${interval}:${startTime}:${endTime}`;
    return this.cache.getOrLoad(key, TTL.candles, () =>
      this.info<Candle[]>({ type: "candleSnapshot", req: { coin, interval, startTime, endTime } }, 4),
    );
  }

  fundingHistory(coin: string, startTime: number, endTime?: number): Promise<FundingHistoryEntry[]> {
    const key = `funding:${coin}:${startTime}:${endTime ?? "now"}`;
    const body: Record<string, unknown> = { type: "fundingHistory", coin, startTime };
    if (endTime !== undefined) body.endTime = endTime;
    return this.cache.getOrLoad(key, TTL.candles, () => this.info<FundingHistoryEntry[]>(body, 2));
  }

  // ---- Account state ---------------------------------------------------------

  clearinghouseState(user: string): Promise<ClearinghouseState> {
    return this.cache.getOrLoad(`chs:${user.toLowerCase()}`, TTL.account, () =>
      this.info<ClearinghouseState>({ type: "clearinghouseState", user }, 2),
    );
  }

  openOrders(user: string): Promise<OpenOrder[]> {
    return this.cache.getOrLoad(`oo:${user.toLowerCase()}`, TTL.account, () =>
      this.info<OpenOrder[]>({ type: "frontendOpenOrders", user }, 2),
    );
  }

  userFills(user: string): Promise<UserFill[]> {
    return this.cache.getOrLoad(`fills:${user.toLowerCase()}`, TTL.account, () =>
      this.info<UserFill[]>({ type: "userFills", user }, 2),
    );
  }

  /**
   * Fills in [startTime, endTime]. The endpoint returns at most
   * FILLS_PAGE_LIMIT rows per call, so an active wallet over a long window is
   * silently truncated unless the window is walked forward — which would make
   * realized-PnL totals (trader stats, score calibration) quietly wrong.
   * Pages until exhausted, bounded by FILLS_MAX_PAGES.
   */
  userFillsByTime(user: string, startTime: number, endTime?: number): Promise<UserFill[]> {
    return this.cache.getOrLoad(`fillsT:${user.toLowerCase()}:${startTime}:${endTime ?? "now"}`, TTL.account, () =>
      this.fetchAllFills(user, startTime, endTime),
    );
  }

  private async fetchAllFills(user: string, startTime: number, endTime?: number): Promise<UserFill[]> {
    const all: UserFill[] = [];
    const seen = new Set<string>();
    let cursor = startTime;

    for (let page = 0; page < FILLS_MAX_PAGES; page++) {
      const body: Record<string, unknown> = { type: "userFillsByTime", user, startTime: cursor, aggregateByTime: false };
      if (endTime !== undefined) body.endTime = endTime;
      const batch = await this.info<UserFill[]>(body, 4);
      if (!Array.isArray(batch) || batch.length === 0) break;

      // Pages overlap on `time`, so dedupe by the fill's unique id.
      for (const f of batch) {
        const id = `${f.tid ?? ""}:${f.hash ?? ""}:${f.time}:${f.coin}:${f.px}:${f.sz}`;
        if (seen.has(id)) continue;
        seen.add(id);
        all.push(f);
      }
      if (batch.length < FILLS_PAGE_LIMIT) break;

      const maxTime = batch.reduce((m, f) => Math.max(m, Number(f.time) || 0), 0);
      // No forward progress (a single millisecond holds a full page) — stop
      // rather than loop on the same window.
      if (maxTime <= cursor) break;
      cursor = maxTime;
    }
    return all;
  }

  /** Raw escape hatch for aggregation tools that need an uncached, custom Info request. */
  rawInfo<T>(body: Record<string, unknown>, weight = 2): Promise<T> {
    return this.info<T>(body, weight);
  }
}

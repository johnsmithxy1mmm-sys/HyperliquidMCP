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
/**
 * Info request weights from Hyperliquid's rate-limit docs: 2 for a few light
 * requests, 20 for every other one, plus 1 per N items the paged endpoints return.
 */
const WEIGHT_LIGHT = 2;
const WEIGHT_INFO = 20;
const ITEMS_PER_WEIGHT = 20;
const CANDLES_PER_WEIGHT = 60;

/** Hyperliquid serves only a user's 10,000 most recent fills, however they are paged. */
export const MAX_AVAILABLE_FILLS = 10_000;
const TIME_RANGE_PAGE_LIMIT = 500;
const FUNDING_MAX_PAGES = 10;
const FILLS_PAGE_LIMIT = 2000;
/** Hard bound on paging so one wallet can never monopolize the weight budget. */
const FILLS_MAX_PAGES = 10;

export class HyperliquidClient {
  private readonly cache = new TtlLruCache();
  private readonly limiter: RateLimiter;

  constructor(private readonly config: Config) {
    this.limiter = new RateLimiter(config.rateWeightPerMin);
  }

  private async info<T>(body: Record<string, unknown>, weight = WEIGHT_INFO, itemsPerWeight?: number): Promise<T> {
    await this.limiter.acquire(weight);
    const res = await postJson<T>(this.config.infoBaseUrl, body, {
      timeoutMs: this.config.requestTimeoutMs,
      maxRetries: this.config.maxRetries,
      // Hyperliquid weighs every HTTP request, retries included.
      onRetry: () => this.limiter.acquire(weight),
    });
    // The per-item surcharge is only known once the response is in.
    const extra = itemsPerWeight && Array.isArray(res) ? Math.floor(res.length / itemsPerWeight) : 0;
    if (extra > 0) await this.limiter.acquire(extra);
    return res;
  }

  // ---- Metadata / markets ----------------------------------------------------

  metaAndAssetCtxs(): Promise<MetaAndAssetCtxs> {
    return this.cache.getOrLoad("metaAndAssetCtxs", TTL.markets, () =>
      this.info<MetaAndAssetCtxs>({ type: "metaAndAssetCtxs" }),
    );
  }

  perpMeta(): Promise<PerpMeta> {
    return this.cache.getOrLoad("meta", TTL.metadata, () => this.info<PerpMeta>({ type: "meta" }));
  }

  spotMetaAndAssetCtxs(): Promise<unknown> {
    return this.cache.getOrLoad("spotMetaAndAssetCtxs", TTL.markets, () =>
      this.info<unknown>({ type: "spotMetaAndAssetCtxs" }),
    );
  }

  /** Builder-deployed perp dex list (HIP-3). First entry is null (default dex). */
  perpDexs(): Promise<PerpDexEntry[]> {
    return this.cache.getOrLoad("perpDexs", TTL.metadata, () => this.info<PerpDexEntry[]>({ type: "perpDexs" }));
  }

  /** metaAndAssetCtxs scoped to a builder dex. Callers must try/catch — coverage varies. */
  metaAndAssetCtxsForDex(dex: string): Promise<MetaAndAssetCtxs> {
    return this.cache.getOrLoad(`metaAndAssetCtxs:${dex}`, TTL.markets, () =>
      this.info<MetaAndAssetCtxs>({ type: "metaAndAssetCtxs", dex }),
    );
  }

  predictedFundings(): Promise<PredictedFundings> {
    return this.cache.getOrLoad("predictedFundings", TTL.markets, () =>
      this.info<PredictedFundings>({ type: "predictedFundings" }),
    );
  }

  // ---- Per-coin market data --------------------------------------------------

  l2Book(coin: string): Promise<L2Book> {
    return this.cache.getOrLoad(`l2:${coin}`, TTL.orderbook, () =>
      this.info<L2Book>({ type: "l2Book", coin }, WEIGHT_LIGHT),
    );
  }

  candles(coin: string, interval: string, startTime: number, endTime: number): Promise<Candle[]> {
    const key = `candles:${coin}:${interval}:${startTime}:${endTime}`;
    return this.cache.getOrLoad(key, TTL.candles, () =>
      this.info<Candle[]>({ type: "candleSnapshot", req: { coin, interval, startTime, endTime } }, WEIGHT_INFO, CANDLES_PER_WEIGHT),
    );
  }

  fundingHistory(coin: string, startTime: number, endTime?: number): Promise<FundingHistoryEntry[]> {
    const key = `funding:${coin}:${startTime}:${endTime ?? "now"}`;
    return this.cache.getOrLoad(key, TTL.candles, () => this.fetchAllFunding(coin, startTime, endTime));
  }

  /**
   * Time-range info responses hold at most 500 entries (Hyperliquid docs), so a
   * window over ~21 days of hourly funding was silently cut. Page forward from
   * the last returned time, bounded like fills.
   */
  private async fetchAllFunding(coin: string, startTime: number, endTime?: number): Promise<FundingHistoryEntry[]> {
    const all: FundingHistoryEntry[] = [];
    let cursor = startTime;
    for (let page = 0; page < FUNDING_MAX_PAGES; page++) {
      const body: Record<string, unknown> = { type: "fundingHistory", coin, startTime: cursor };
      if (endTime !== undefined) body.endTime = endTime;
      const batch = await this.info<FundingHistoryEntry[]>(body, WEIGHT_INFO, ITEMS_PER_WEIGHT);
      if (!Array.isArray(batch) || batch.length === 0) break;
      all.push(...batch);
      if (batch.length < TIME_RANGE_PAGE_LIMIT) break;
      const lastTime = batch.reduce((m, e) => Math.max(m, Number(e.time) || 0), 0);
      if (lastTime < cursor) break;
      cursor = lastTime + 1;
    }
    return all;
  }

  // ---- Account state ---------------------------------------------------------

  clearinghouseState(user: string): Promise<ClearinghouseState> {
    return this.cache.getOrLoad(`chs:${user.toLowerCase()}`, TTL.account, () =>
      this.info<ClearinghouseState>({ type: "clearinghouseState", user }, WEIGHT_LIGHT),
    );
  }

  openOrders(user: string): Promise<OpenOrder[]> {
    return this.cache.getOrLoad(`oo:${user.toLowerCase()}`, TTL.account, () =>
      this.info<OpenOrder[]>({ type: "frontendOpenOrders", user }),
    );
  }

  userFills(user: string): Promise<UserFill[]> {
    return this.cache.getOrLoad(`fills:${user.toLowerCase()}`, TTL.account, () =>
      this.info<UserFill[]>({ type: "userFills", user }, WEIGHT_INFO, ITEMS_PER_WEIGHT),
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
      const batch = await this.info<UserFill[]>(body, WEIGHT_INFO, ITEMS_PER_WEIGHT);
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
  rawInfo<T>(body: Record<string, unknown>, weight = WEIGHT_INFO): Promise<T> {
    return this.info<T>(body, weight);
  }
}

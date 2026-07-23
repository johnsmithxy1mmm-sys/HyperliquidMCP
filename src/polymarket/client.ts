/**
 * Minimal Polymarket Gamma API client. Fetches active markets and normalizes
 * the fields we need (question, end date, Yes probability, liquidity). Cached
 * briefly; times out and degrades gracefully (no invented data).
 */
import type { Config } from "../config.js";
import { TtlLruCache, TTL } from "../core/cache.js";
import { num } from "../core/format.js";
import { log } from "../logger.js";

export interface PolymarketMarket {
  question: string;
  slug: string;
  endDate: string | undefined;
  yesProb: number | null; // implied probability of the "Yes"/first outcome
  volumeUsd: number;
  liquidityUsd: number;
}

interface RawMarket {
  question?: string;
  slug?: string;
  endDate?: string;
  active?: boolean;
  closed?: boolean;
  outcomes?: string | string[];
  outcomePrices?: string | string[];
  volume?: string | number;
  volumeNum?: number;
  liquidity?: string | number;
  liquidityNum?: number;
}

const cache = new TtlLruCache();

export class PolymarketClient {
  constructor(private readonly config: Config) {}

  /** Active, non-closed markets sorted by liquidity (cached ~60s). */
  async activeMarkets(maxMarkets = 500): Promise<PolymarketMarket[]> {
    return cache.getOrLoad<PolymarketMarket[]>(`pm:active:${maxMarkets}`, TTL.heavyAggregation, async () => {
      const url = `${this.config.polymarket.gammaUrl.replace(/\/$/, "")}/markets?active=true&closed=false&limit=${maxMarkets}`;
      const raw = await this.get<RawMarket[]>(url);
      const markets = (raw ?? [])
        .filter((m) => m.closed !== true && m.question)
        .map((m) => this.normalize(m))
        .filter((m): m is PolymarketMarket => m !== null);
      markets.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
      return markets;
    });
  }

  private normalize(m: RawMarket): PolymarketMarket | null {
    const outcomes = parseArr(m.outcomes);
    const prices = parseArr(m.outcomePrices);
    // Yes/No binary: first price is the "Yes" implied probability.
    let yesProb: number | null = null;
    if (prices.length >= 1) {
      const idxYes = outcomes.findIndex((o) => /yes/i.test(o));
      const p = num(prices[idxYes >= 0 ? idxYes : 0]);
      yesProb = p > 0 && p <= 1 ? p : null;
    }
    return {
      question: m.question ?? "",
      slug: m.slug ?? "",
      endDate: m.endDate,
      yesProb,
      volumeUsd: num(m.volumeNum ?? m.volume),
      liquidityUsd: num(m.liquidityNum ?? m.liquidity),
    };
  }

  private async get<T>(url: string): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
      if (!res.ok) {
        log.warn("polymarket http error", { status: res.status });
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      log.warn("polymarket fetch failed", { err: String(err) });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseArr(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

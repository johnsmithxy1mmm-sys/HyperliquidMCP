/**
 * Market normalization helpers shared by many tools. Turns Hyperliquid's
 * index-aligned [meta, assetCtxs] tuple into flat, typed rows and provides
 * coin resolution with actionable errors.
 */
import type { HyperliquidClient } from "../core/hlClient.js";
import type { AssetMeta, AssetCtx } from "./types.js";
import { num, annualizeHourlyFunding } from "../core/format.js";
import { unknownCoin } from "../core/errors.js";

export interface MarketRow {
  coin: string;
  index: number;
  markPx: number;
  oraclePx: number;
  midPx: number | null;
  fundingHourly: number;
  fundingApr: number;
  openInterest: number;
  dayNtlVlm: number;
  prevDayPx: number;
  change24hPct: number;
  maxLeverage: number;
  szDecimals: number;
  isDelisted: boolean;
  /** HIP-3 builder-deployed perp markets carry a ":" in their name (dex:coin). */
  isHip3: boolean;
}

export function buildRow(meta: AssetMeta, ctx: AssetCtx, index: number): MarketRow {
  const markPx = num(ctx.markPx);
  const prevDayPx = num(ctx.prevDayPx);
  const fundingHourly = num(ctx.funding);
  const change24hPct = prevDayPx > 0 ? (markPx - prevDayPx) / prevDayPx : 0;
  return {
    coin: meta.name,
    index,
    markPx,
    oraclePx: num(ctx.oraclePx),
    midPx: ctx.midPx === null || ctx.midPx === undefined ? null : num(ctx.midPx),
    fundingHourly,
    fundingApr: annualizeHourlyFunding(fundingHourly),
    openInterest: num(ctx.openInterest),
    dayNtlVlm: num(ctx.dayNtlVlm),
    prevDayPx,
    change24hPct,
    maxLeverage: meta.maxLeverage,
    szDecimals: meta.szDecimals,
    isDelisted: meta.isDelisted === true,
    isHip3: meta.name.includes(":"),
  };
}

export async function getMarketRows(hl: HyperliquidClient): Promise<MarketRow[]> {
  const [meta, ctxs] = await hl.metaAndAssetCtxs();
  const rows: MarketRow[] = [];
  for (let i = 0; i < meta.universe.length; i++) {
    const m = meta.universe[i];
    const c = ctxs[i];
    if (!m || !c) continue;
    rows.push(buildRow(m, c, i));
  }
  return rows;
}

/** Resolve a coin symbol (case-insensitive) to its market row or throw unknownCoin. */
export async function resolveMarket(hl: HyperliquidClient, coin: string): Promise<MarketRow> {
  const rows = await getMarketRows(hl);
  const wanted = coin.trim();
  const exact = rows.find((r) => r.coin === wanted);
  if (exact) return exact;
  const ci = rows.find((r) => r.coin.toLowerCase() === wanted.toLowerCase());
  if (ci) return ci;
  throw unknownCoin(coin);
}

/** Resolve just the asset index for exchange/order calls. */
export async function resolveAssetIndex(hl: HyperliquidClient, coin: string): Promise<number> {
  return (await resolveMarket(hl, coin)).index;
}

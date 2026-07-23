/**
 * Hyperliquid Info API response types (subset we consume).
 * Grounded in the official python SDK request/response shapes (see docs/PHASE0.md).
 * Numeric fields arrive as strings from the API; we keep them as strings here
 * and parse at the edges.
 */

export interface AssetMeta {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated?: boolean;
  isDelisted?: boolean;
}

export interface PerpMeta {
  universe: AssetMeta[];
}

export interface AssetCtx {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  premium: string | null;
  oraclePx: string;
  markPx: string;
  midPx: string | null;
  impactPxs: [string, string] | null;
}

/** metaAndAssetCtxs returns a tuple [PerpMeta, AssetCtx[]] index-aligned to universe. */
export type MetaAndAssetCtxs = [PerpMeta, AssetCtx[]];

export interface L2Level {
  px: string;
  sz: string;
  n: number;
}

export interface L2Book {
  coin: string;
  time: number;
  levels: [L2Level[], L2Level[]]; // [bids, asks]
}

/** candleSnapshot element. */
export interface Candle {
  t: number; // open time (ms)
  T: number; // close time (ms)
  s: string; // coin
  i: string; // interval
  o: string;
  c: string;
  h: string;
  l: string;
  v: string; // volume (base)
  n: number; // trades
}

export interface FundingHistoryEntry {
  coin: string;
  fundingRate: string;
  premium: string;
  time: number;
}

export interface AssetPosition {
  type: string;
  position: {
    coin: string;
    szi: string; // signed size (negative => short)
    entryPx: string | null;
    positionValue: string;
    unrealizedPnl: string;
    returnOnEquity: string;
    leverage: { type: string; value: number; rawUsd?: string };
    liquidationPx: string | null;
    marginUsed: string;
    maxLeverage: number;
  };
}

export interface MarginSummary {
  accountValue: string;
  totalNtlPos: string;
  totalRawUsd: string;
  totalMarginUsed: string;
}

export interface ClearinghouseState {
  marginSummary: MarginSummary;
  crossMarginSummary: MarginSummary;
  crossMaintenanceMarginUsed: string;
  withdrawable: string;
  assetPositions: AssetPosition[];
  time: number;
}

export interface OpenOrder {
  coin: string;
  oid: number;
  side: "A" | "B"; // A=ask/sell, B=bid/buy
  limitPx: string;
  sz: string;
  timestamp: number;
  origSz?: string;
  reduceOnly?: boolean;
  orderType?: string;
  triggerPx?: string;
  isTrigger?: boolean;
}

export interface UserFill {
  coin: string;
  px: string;
  sz: string;
  side: "A" | "B";
  time: number;
  startPosition: string;
  dir: string;
  closedPnl: string;
  hash: string;
  oid: number;
  crossed: boolean;
  fee: string;
  tid: number;
}

export interface PredictedFundingVenue {
  fundingRate: string;
  nextFundingTime: number;
  /** Funding period length in hours; venues without it default per-venue (HlPerp=1h, others 8h). */
  fundingIntervalHours?: number;
}

/** predictedFundings => [coin, [ [venue, data|null], ... ]][] */
export type PredictedFundings = Array<[string, Array<[string, PredictedFundingVenue | null]>]>;

/** perpDexs => array whose first element is null (the default dex), then builder dexs. */
export type PerpDexEntry = {
  name: string;
  full_name?: string;
  deployer?: string;
  oracle_updater?: string | null;
} | null;

/**
 * Account/position normalization shared by hl_get_account, hl_portfolio_risk,
 * hl_whale_positions, and liquidation mapping.
 */
import type { ClearinghouseState } from "./types.js";
import { num, round } from "../core/format.js";

export interface NormalizedPosition {
  coin: string;
  szi: number; // signed size (negative = short)
  side: "long" | "short" | "flat";
  entryPx: number | null;
  positionValueUsd: number;
  unrealizedPnl: number;
  returnOnEquity: number;
  leverage: number;
  leverageType: string;
  liquidationPx: number | null;
  marginUsed: number;
  maxLeverage: number;
}

export interface NormalizedAccount {
  accountValue: number;
  totalNtlPos: number;
  totalMarginUsed: number;
  withdrawable: number;
  crossMaintenanceMarginUsed: number;
  positions: NormalizedPosition[];
}

export function normalizeAccount(state: ClearinghouseState): NormalizedAccount {
  const positions: NormalizedPosition[] = (state.assetPositions ?? []).map((ap) => {
    const p = ap.position;
    const szi = num(p.szi);
    return {
      coin: p.coin,
      szi,
      side: szi > 0 ? "long" : szi < 0 ? "short" : "flat",
      entryPx: p.entryPx === null ? null : num(p.entryPx),
      positionValueUsd: num(p.positionValue),
      unrealizedPnl: num(p.unrealizedPnl),
      returnOnEquity: num(p.returnOnEquity),
      leverage: num(p.leverage?.value),
      leverageType: p.leverage?.type ?? "cross",
      liquidationPx: p.liquidationPx === null || p.liquidationPx === undefined ? null : num(p.liquidationPx),
      marginUsed: num(p.marginUsed),
      maxLeverage: p.maxLeverage,
    };
  });

  const ms = state.marginSummary;
  return {
    accountValue: round(num(ms?.accountValue), 2),
    totalNtlPos: round(num(ms?.totalNtlPos), 2),
    totalMarginUsed: round(num(ms?.totalMarginUsed), 2),
    withdrawable: round(num(state.withdrawable), 2),
    crossMaintenanceMarginUsed: round(num(state.crossMaintenanceMarginUsed), 2),
    positions,
  };
}

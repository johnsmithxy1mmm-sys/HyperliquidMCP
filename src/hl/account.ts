/**
 * Account/position normalization shared by hl_get_account, hl_portfolio_risk,
 * hl_whale_positions, and liquidation mapping.
 */
import type { ClearinghouseState } from "./types.js";
import { num, round } from "../core/format.js";
import { ToolError } from "../core/errors.js";

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

/** A `dex` argument as the API names it: lowercase, and "main" (what outputs report) is the main dex. */
export function dexArg(raw: unknown): string | undefined {
  const dex = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return dex && dex !== "main" ? dex : undefined;
}

/**
 * Throw unless `dex` is a live HIP-3 dex: the API answers an unknown name with
 * null, which reads as an empty account or crashes the caller.
 */
export async function assertKnownDex(hl: { perpDexs(): Promise<Array<{ name?: string } | null>> }, dex: string): Promise<void> {
  const names = (await hl.perpDexs()).flatMap((d) => (d?.name ? [d.name] : []));
  if (names.includes(dex)) return;
  throw new ToolError(
    "unknown_dex",
    `Unknown perp dex "${dex}". Known HIP-3 dexes: ${names.join(", ")}. Omit dex for the main dex.`,
    { knownDexs: names },
  );
}

/**
 * Perp account state on the main dex (no `dex`), one HIP-3 builder dex, or all
 * of them ("all"): each dex keeps its own margin, so "all" sums the margin
 * figures and concatenates positions (HIP-3 coins keep their "dex:" prefix).
 */
export async function accountStateFor(
  hl: { clearinghouseState(user: string, dex?: string): Promise<ClearinghouseState>; perpDexs(): Promise<Array<{ name?: string } | null>> },
  user: string,
  dex?: string,
): Promise<ClearinghouseState> {
  if (dex !== "all") {
    if (dex) await assertKnownDex(hl, dex);
    return hl.clearinghouseState(user, dex || undefined);
  }
  const builderDexs = (await hl.perpDexs()).flatMap((d) => (d?.name ? [d.name] : []));
  const states = await Promise.all([hl.clearinghouseState(user), ...builderDexs.map((d) => hl.clearinghouseState(user, d))]);
  const sum = (pick: (s: ClearinghouseState) => string) => String(states.reduce((a, s) => a + num(pick(s)), 0));
  const margin = (key: "marginSummary" | "crossMarginSummary") => ({
    accountValue: sum((s) => s[key].accountValue),
    totalNtlPos: sum((s) => s[key].totalNtlPos),
    totalRawUsd: sum((s) => s[key].totalRawUsd),
    totalMarginUsed: sum((s) => s[key].totalMarginUsed),
  });
  return {
    ...states[0],
    marginSummary: margin("marginSummary"),
    crossMarginSummary: margin("crossMarginSummary"),
    crossMaintenanceMarginUsed: sum((s) => s.crossMaintenanceMarginUsed),
    withdrawable: sum((s) => s.withdrawable),
    assetPositions: states.flatMap((s) => s.assetPositions),
  };
}

/**
 * Whale cohort aggregation: fetch each wallet's perp state (bounded concurrency)
 * and aggregate positions by coin. Shared by hl_whale_positions,
 * hl_whale_flow_alerts, and hl_liquidation_map.
 */
import type { ToolContext } from "../tools/registry.js";
import { normalizeAccount, type NormalizedAccount, type NormalizedPosition } from "./account.js";
import { round } from "../core/format.js";
import { log } from "../logger.js";

export interface CohortAccount {
  address: string;
  account: NormalizedAccount;
}

/** Fetch accounts with bounded concurrency; failed wallets are skipped (graceful). */
export async function fetchCohortAccounts(ctx: ToolContext, addresses: string[], concurrency = 5): Promise<CohortAccount[]> {
  const out: CohortAccount[] = [];
  let i = 0;
  async function worker(): Promise<void> {
    while (i < addresses.length) {
      const idx = i++;
      const address = addresses[idx];
      try {
        const state = await ctx.hl.clearinghouseState(address);
        out.push({ address, account: normalizeAccount(state) });
      } catch (err) {
        log.warn("cohort wallet fetch failed", { address, err: String(err) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, addresses.length) }, worker));
  return out;
}

export interface CoinAggregate {
  coin: string;
  wallets: number;
  longWallets: number;
  shortWallets: number;
  longSz: number;
  shortSz: number;
  netSz: number;
  longNtlUsd: number;
  shortNtlUsd: number;
  netNtlUsd: number;
  wavgEntryLong: number | null;
  wavgEntryShort: number | null;
  totalUnrealizedPnl: number;
}

export function aggregateByCoin(accounts: CohortAccount[]): Map<string, CoinAggregate> {
  const map = new Map<string, CoinAggregate>();
  const entryLongAccum = new Map<string, { pxSz: number; sz: number }>();
  const entryShortAccum = new Map<string, { pxSz: number; sz: number }>();

  for (const { account } of accounts) {
    for (const p of account.positions) {
      if (p.side === "flat" || p.szi === 0) continue;
      const agg = map.get(p.coin) ?? blank(p.coin);
      const absSz = Math.abs(p.szi);
      const ntl = Math.abs(p.positionValueUsd);
      agg.wallets += 1;
      agg.totalUnrealizedPnl += p.unrealizedPnl;
      if (p.side === "long") {
        agg.longWallets += 1;
        agg.longSz += absSz;
        agg.longNtlUsd += ntl;
        accumEntry(entryLongAccum, p, absSz);
      } else {
        agg.shortWallets += 1;
        agg.shortSz += absSz;
        agg.shortNtlUsd += ntl;
        accumEntry(entryShortAccum, p, absSz);
      }
      map.set(p.coin, agg);
    }
  }

  for (const [coin, agg] of map) {
    agg.netSz = round(agg.longSz - agg.shortSz, 6);
    agg.netNtlUsd = round(agg.longNtlUsd - agg.shortNtlUsd, 2);
    agg.longSz = round(agg.longSz, 6);
    agg.shortSz = round(agg.shortSz, 6);
    agg.longNtlUsd = round(agg.longNtlUsd, 2);
    agg.shortNtlUsd = round(agg.shortNtlUsd, 2);
    agg.totalUnrealizedPnl = round(agg.totalUnrealizedPnl, 2);
    const el = entryLongAccum.get(coin);
    const es = entryShortAccum.get(coin);
    agg.wavgEntryLong = el && el.sz > 0 ? round(el.pxSz / el.sz, 6) : null;
    agg.wavgEntryShort = es && es.sz > 0 ? round(es.pxSz / es.sz, 6) : null;
  }
  return map;
}

function accumEntry(m: Map<string, { pxSz: number; sz: number }>, p: NormalizedPosition, absSz: number): void {
  if (p.entryPx === null) return;
  const cur = m.get(p.coin) ?? { pxSz: 0, sz: 0 };
  cur.pxSz += p.entryPx * absSz;
  cur.sz += absSz;
  m.set(p.coin, cur);
}

function blank(coin: string): CoinAggregate {
  return {
    coin,
    wallets: 0,
    longWallets: 0,
    shortWallets: 0,
    longSz: 0,
    shortSz: 0,
    netSz: 0,
    longNtlUsd: 0,
    shortNtlUsd: 0,
    netNtlUsd: 0,
    wavgEntryLong: null,
    wavgEntryShort: null,
    totalUnrealizedPnl: 0,
  };
}

export const ANALYTICS_DISCLAIMER = "Analytics only, not investment advice.";

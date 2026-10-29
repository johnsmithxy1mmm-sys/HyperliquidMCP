/**
 * Network wrapper: fetch each address's fills + account state (bounded
 * concurrency, failed wallets skipped) and build a TraderProfile. Kept separate
 * from the pure scoring so the latter stays unit-testable.
 */
import type { ToolContext } from "../tools/registry.js";
import { normalizeAccount, mergeStates } from "../hl/account.js";
import { dexOf } from "../hl/markets.js";
import { buildTraderProfile, type TraderProfile } from "./profile.js";
import { log } from "../logger.js";

export async function analyzeAddress(ctx: ToolContext, address: string, lookbackDays: number): Promise<TraderProfile> {
  const startTime = Date.now() - lookbackDays * 86_400_000;
  const [fills, main] = await Promise.all([
    ctx.hl.userFillsByTime(address, startTime),
    ctx.hl.clearinghouseState(address),
  ]);
  // Fills cover every perp dex, so equity and positions must too: PnL made on
  // HIP-3 dexes over main-dex equity alone overstates the return.
  // shortcut: a dex with positions but no fills in the window is missed; read every dex if that matters.
  const dexs = [...new Set(fills.map((f) => dexOf(f.coin)).filter((d): d is string => !!d))];
  const others = await Promise.all(dexs.map((d) => ctx.hl.clearinghouseState(address, d)));
  // A delisted dex answers null.
  return buildTraderProfile(address, fills, normalizeAccount(mergeStates([main, ...others.filter((s) => s)])));
}

export async function analyzeCohort(
  ctx: ToolContext,
  addresses: string[],
  lookbackDays: number,
  concurrency = 4,
): Promise<TraderProfile[]> {
  const out: TraderProfile[] = [];
  let i = 0;
  const worker = async (): Promise<void> => {
    while (i < addresses.length) {
      const address = addresses[i++];
      try {
        out.push(await analyzeAddress(ctx, address, lookbackDays));
      } catch (err) {
        log.warn("smart-money analyze failed", { address, err: String(err) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, addresses.length) }, worker));
  return out;
}

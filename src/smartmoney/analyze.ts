/**
 * Network wrapper: fetch each address's fills + account state (bounded
 * concurrency, failed wallets skipped) and build a TraderProfile. Kept separate
 * from the pure scoring so the latter stays unit-testable.
 */
import type { ToolContext } from "../tools/registry.js";
import { normalizeAccount } from "../hl/account.js";
import { buildTraderProfile, type TraderProfile } from "./profile.js";
import { log } from "../logger.js";

export async function analyzeAddress(ctx: ToolContext, address: string, lookbackDays: number): Promise<TraderProfile> {
  const startTime = Date.now() - lookbackDays * 86_400_000;
  const [fills, state] = await Promise.all([
    ctx.hl.userFillsByTime(address, startTime),
    ctx.hl.clearinghouseState(address),
  ]);
  return buildTraderProfile(address, fills, normalizeAccount(state));
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

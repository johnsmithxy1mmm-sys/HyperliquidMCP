/**
 * Whale-cohort resolution, in priority order:
 *   1. `cohort` argument      — caller knows exactly which wallets they want
 *   2. auto-refreshed cohort  — persisted snapshot from the leaderboard job
 *   3. HL_WHALE_ADDRESSES     — manual fallback / override for the job
 *   4. direct leaderboard hit — last resort if the job hasn't run yet
 *
 * The auto cohort outranks the env list because a stale hand-written list is
 * the failure mode we're removing; the env list stays as a deliberate manual
 * override when no leaderboard is configured. No invented endpoints (hard
 * rule #6): with no source at all we raise an actionable error.
 */
import type { ToolContext } from "../tools/registry.js";
import { ToolError } from "../core/errors.js";
import { isAddress } from "../core/format.js";
import { log } from "../logger.js";

export interface CohortResolution {
  addresses: string[];
  source: "arg" | "auto" | "env" | "leaderboard";
  /** Age of the auto cohort snapshot, when that's the source. */
  ageSeconds?: number;
  strategy?: string;
}

/** Auto cohorts older than this are considered stale and skipped. */
const MAX_AUTO_AGE_SECONDS = 24 * 3600;

interface LeaderboardRow {
  ethAddress?: string;
  address?: string;
  accountValue?: string | number;
}

export async function resolveCohort(
  ctx: ToolContext,
  argCohort: string[] | undefined,
  topN: number,
): Promise<CohortResolution> {
  if (argCohort && argCohort.length > 0) {
    const valid = dedupe(argCohort.filter(isAddress).map((a) => a.toLowerCase()));
    if (valid.length === 0) throw invalidCohort();
    return { addresses: valid.slice(0, topN), source: "arg" };
  }

  // Auto-refreshed cohort (preferred: always current, zero manual upkeep).
  const auto = ctx.store.cohort.get(topN);
  if (auto && auto.addresses.length > 0 && auto.ageSeconds <= MAX_AUTO_AGE_SECONDS) {
    return {
      addresses: auto.addresses.slice(0, topN),
      source: "auto",
      ageSeconds: auto.ageSeconds,
      strategy: auto.strategy,
    };
  }
  if (auto && auto.ageSeconds > MAX_AUTO_AGE_SECONDS) {
    log.warn("auto cohort is stale, falling back", { ageSeconds: auto.ageSeconds });
  }

  if (ctx.config.whaleAddresses.length > 0) {
    const valid = dedupe(ctx.config.whaleAddresses.filter(isAddress).map((a) => a.toLowerCase()));
    if (valid.length > 0) return { addresses: valid.slice(0, topN), source: "env" };
  }

  if (ctx.config.leaderboardUrl) {
    try {
      const addrs = await fetchLeaderboard(ctx.config.leaderboardUrl, topN, ctx.config.requestTimeoutMs);
      if (addrs.length > 0) return { addresses: addrs, source: "leaderboard" };
    } catch (err) {
      log.warn("leaderboard fetch failed", { err: String(err) });
    }
  }

  throw noCohort();
}

async function fetchLeaderboard(url: string, topN: number, timeoutMs: number): Promise<string[]> {
  // Try GET first; some endpoints accept POST. postJson only does POST, so use fetch here.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { leaderboardRows?: LeaderboardRow[] } | LeaderboardRow[];
    const rows: LeaderboardRow[] = Array.isArray(body) ? body : (body.leaderboardRows ?? []);
    const scored = rows
      .map((r) => ({
        addr: (r.ethAddress ?? r.address ?? "").toLowerCase(),
        av: Number(r.accountValue ?? 0),
      }))
      .filter((r) => isAddress(r.addr));
    scored.sort((a, b) => b.av - a.av);
    return dedupe(scored.map((r) => r.addr)).slice(0, topN);
  } finally {
    clearTimeout(timer);
  }
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

function invalidCohort(): ToolError {
  return new ToolError(
    "invalid_cohort",
    "No valid 0x addresses in `cohort`. Pass an array of 42-char 0x addresses.",
  );
}

function noCohort(): ToolError {
  return new ToolError(
    "no_cohort",
    "Whale tools need a wallet cohort. Options, best first: set HL_LEADERBOARD_URL so the server " +
      "auto-refreshes a ranked cohort hourly; or set HL_WHALE_ADDRESSES to a fixed list; or pass " +
      "`cohort` (array of 0x addresses) per call.",
  );
}

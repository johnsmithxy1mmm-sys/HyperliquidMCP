/**
 * Whale-cohort resolution. Canonical, reproducible source = an explicit address
 * list (tool `cohort` arg or env HL_WHALE_ADDRESSES). No invented endpoints
 * (hard rule #6). An OPTIONAL best-effort public leaderboard can be configured
 * via HL_LEADERBOARD_URL; if unavailable we throw an actionable error rather
 * than fabricate data.
 */
import type { ToolContext } from "../tools/registry.js";
import { ToolError } from "../core/errors.js";
import { isAddress } from "../core/format.js";
import { log } from "../logger.js";

export interface CohortResolution {
  addresses: string[];
  source: "arg" | "env" | "leaderboard";
}

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
    "Whale tools need a wallet cohort. Pass `cohort` (array of 0x addresses), or set HL_WHALE_ADDRESSES, " +
      "or configure HL_LEADERBOARD_URL for best-effort leaderboard sourcing.",
  );
}

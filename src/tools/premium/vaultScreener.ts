import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { assertAddress, num, round, sharpe, sortino, maxDrawdown } from "../../core/format.js";
import { ANALYTICS_DISCLAIMER } from "../../hl/whales.js";
import { log } from "../../logger.js";

interface PortfolioPeriod {
  accountValueHistory?: Array<[number, string]>;
  pnlHistory?: Array<[number, string]>;
  vlm?: string;
}
interface VaultDetails {
  name?: string;
  vaultAddress?: string;
  leader?: string;
  apr?: number;
  leaderFraction?: number;
  isClosed?: boolean;
  portfolio?: Array<[string, PortfolioPeriod]>;
  followers?: Array<{ user?: string; vaultEquity?: string; pnl?: string; daysFollowing?: number }>;
}

/**
 * Screens user vaults by risk-adjusted performance. Since the Info API exposes
 * vault metrics per address (`vaultDetails`), the screener takes an explicit
 * list of vault addresses (arg `vaults` or env HL_VAULT_ADDRESSES) and ranks
 * them. Vaults whose details can't be fetched are reported as unavailable.
 */
export const vaultScreener: ToolDef = {
  name: "hl_vault_screener",
  tier: "premium",
  title: "Vault screener",
  description:
    "Screen Hyperliquid user vaults by APR, max drawdown, Sharpe/Sortino, age, TVL, and leader capital share. " +
    "Provide `vaults` (list of vault 0x addresses) or set HL_VAULT_ADDRESSES. Metrics derived from vault history. " +
    ANALYTICS_DISCLAIMER,
  inputSchema: {
    vaults: z.array(z.string()).optional().describe("Vault 0x addresses to screen; else HL_VAULT_ADDRESSES."),
    sort: z.enum(["apr", "sharpe", "sortino", "tvl", "maxDrawdown"]).default("sharpe"),
    minTvlUsd: z.number().min(0).default(0),
  },
  outputSchema: {
    screened: z.number(),
    unavailable: z.array(z.string()),
    vaults: z.array(z.record(z.any())),
    disclaimer: z.string(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  run: async (args, ctx) => {
    const provided = (args.vaults as string[] | undefined) ?? [];
    const fromEnv = process.env.HL_VAULT_ADDRESSES?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
    const list = (provided.length ? provided : fromEnv).map((a) => assertAddress(a));
    if (list.length === 0) {
      return {
        summary: "No vaults to screen. Pass `vaults` (0x addresses) or set HL_VAULT_ADDRESSES.",
        data: { screened: 0, unavailable: [], vaults: [], disclaimer: ANALYTICS_DISCLAIMER },
      };
    }
    const sort = (args.sort as "apr" | "sharpe" | "sortino" | "tvl" | "maxDrawdown") ?? "sharpe";
    const minTvl = (args.minTvlUsd as number) ?? 0;

    const unavailable: string[] = [];
    const results: Array<Record<string, unknown>> = [];

    await Promise.all(
      list.map(async (vaultAddress) => {
        try {
          const d = await ctx.hl.rawInfo<VaultDetails>({ type: "vaultDetails", vaultAddress }, 2);
          if (!d || (!d.portfolio && !d.followers)) {
            unavailable.push(vaultAddress);
            return;
          }
          const metrics = deriveMetrics(d);
          if (Number(metrics.tvlUsd) < minTvl) return;
          results.push({ vaultAddress, ...metrics });
        } catch (err) {
          log.warn("vaultDetails failed", { vaultAddress, err: String(err) });
          unavailable.push(vaultAddress);
        }
      }),
    );

    // Map sort names to the actual metric field names.
    const SORT_FIELD: Record<string, string> = {
      apr: "aprPct",
      sharpe: "sharpe",
      sortino: "sortino",
      tvl: "tvlUsd",
      maxDrawdown: "maxDrawdownPct",
    };
    results.sort((a, b) => {
      const key = SORT_FIELD[sort];
      const av = Number(a[key] ?? 0);
      const bv = Number(b[key] ?? 0);
      return sort === "maxDrawdown" ? av - bv : bv - av; // lower drawdown is better
    });

    const top = results[0] as { name?: string; aprPct?: number } | undefined;
    return {
      summary:
        `Screened ${results.length}/${list.length} vaults (${unavailable.length} unavailable), sorted by ${sort}.` +
        (top ? ` Top: ${top.name ?? "vault"} (${top.aprPct}% APR).` : ""),
      data: { screened: results.length, unavailable, vaults: results, disclaimer: ANALYTICS_DISCLAIMER },
    };
  },
};

function deriveMetrics(d: VaultDetails): Record<string, unknown> {
  const periods = new Map((d.portfolio ?? []).map(([k, v]) => [k, v]));
  const allTime = periods.get("allTime") ?? periods.get("month") ?? periods.get("week");
  const avHistory = allTime?.accountValueHistory ?? [];
  const equity = avHistory.map(([, v]) => num(v)).filter((x) => x > 0);
  const returns: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    if (equity[i - 1] > 0) returns.push((equity[i] - equity[i - 1]) / equity[i - 1]);
  }

  const followers = d.followers ?? [];
  const tvlUsd = followers.reduce((a, f) => a + num(f.vaultEquity), 0);
  const leaderEquity = followers.find((f) => f.user && d.leader && f.user.toLowerCase() === d.leader.toLowerCase());
  const leaderShare =
    typeof d.leaderFraction === "number"
      ? d.leaderFraction
      : tvlUsd > 0 && leaderEquity
        ? num(leaderEquity.vaultEquity) / tvlUsd
        : null;

  const firstTs = avHistory[0]?.[0];
  const ageDays = firstTs ? round((Date.now() - firstTs) / 86_400_000, 1) : null;

  return {
    name: d.name ?? null,
    leader: d.leader ?? null,
    isClosed: d.isClosed ?? false,
    aprPct: typeof d.apr === "number" ? round(d.apr * 100, 2) : null,
    tvlUsd: round(tvlUsd, 2),
    followers: followers.length,
    leaderSharePct: leaderShare !== null ? round(leaderShare * 100, 2) : null,
    ageDays,
    sharpe: sharpe(returns),
    sortino: sortino(returns),
    maxDrawdownPct: round(maxDrawdown(equity) * 100, 2),
  };
}

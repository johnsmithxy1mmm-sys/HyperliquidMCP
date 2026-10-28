import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { resolveCohort } from "../../hl/cohort.js";
import { fetchCohortAccounts, aggregateByCoin, cohortSizeFor, dexArg, ANALYTICS_DISCLAIMER } from "../../hl/whales.js";
import { dexOf } from "../../hl/markets.js";
import { round, shortHash } from "../../core/format.js";

export const whalePositions: ToolDef = {
  name: "hl_whale_positions",
  tier: "premium",
  title: "Aggregate whale positions by coin",
  description:
    "Aggregated positioning of a whale cohort for a coin (or all coins): total long/short size & notional, " +
    "long/short wallet counts, weighted-average entry, net bias, and change vs 1h/24h ago. " +
    "Cohort = `cohort` arg or HL_WHALE_ADDRESSES. " +
    ANALYTICS_DISCLAIMER,
  inputSchema: {
    coin: z.string().optional().describe("Restrict to one coin (a HIP-3 coin like 'xyz:XYZ100' reads its own dex); omit for all coins."),
    dex: z
      .string()
      .optional()
      .describe("Perp dex: omit for the main dex, a HIP-3 builder dex name (e.g. 'xyz'), or 'all' for every dex (at most 20 wallets)."),
    cohort: z.array(z.string()).optional().describe("Explicit list of 0x wallet addresses."),
    topN: z.number().int().min(1).max(200).default(50).describe("Max wallets to include from the cohort."),
  },
  outputSchema: {
    source: z.string(),
    walletsQueried: z.number(),
    walletsRequested: z.number(),
    dex: z.string(),
    walletsCappedTo: z.number().nullable(),
    asOf: z.number(),
    coins: z.array(z.record(z.any())),
    disclaimer: z.string(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  run: async (args, ctx) => {
    const coinArg = args.coin as string | undefined;
    const coinFilter = coinArg?.toUpperCase();
    // A coin names its own dex: "xyz:XYZ100" lives on xyz, "BTC" on the main dex.
    const dex = coinArg ? dexOf(coinArg) : dexArg(args.dex);
    const size = cohortSizeFor(dex, (args.topN as number) ?? 50);
    const cohort = await resolveCohort(ctx, args.cohort as string[] | undefined, size.topN);
    const accounts = await fetchCohortAccounts(ctx, cohort.addresses, dex);
    const agg = aggregateByCoin(accounts);
    // A wallet that failed to load would read as an exit: a partial cohort is
    // neither compared against nor recorded as a baseline.
    const complete = accounts.length === cohort.addresses.length;

    const now = Date.now();
    let coins = [...agg.values()];
    if (coinFilter) coins = coins.filter((c) => c.coin.toUpperCase() === coinFilter);
    coins.sort((a, b) => Math.abs(b.netNtlUsd) - Math.abs(a.netNtlUsd));

    // change vs 1h / 24h using snapshot store, keyed per coin+cohort.
    const cohortKey = cohort.addresses.slice().sort().join(",");
    const enriched = coins.map((c) => {
      const key = `${c.coin}:${shortHash(cohortKey)}`;
      const snap1h = ctx.snapshots.nearest("whalePositions", key, 3_600_000, 1_800_000);
      const snap24h = ctx.snapshots.nearest("whalePositions", key, 86_400_000, 6 * 3_600_000);
      if (complete) ctx.snapshots.record("whalePositions", key, { netNtlUsd: c.netNtlUsd }, now);
      return {
        ...c,
        netBias: c.netNtlUsd >= 0 ? "long" : "short",
        change1hUsd: complete ? delta(c.netNtlUsd, snap1h?.value) : null,
        change24hUsd: complete ? delta(c.netNtlUsd, snap24h?.value) : null,
      };
    });

    const lead = enriched[0];
    return {
      summary:
        `Whale cohort (${accounts.length}/${cohort.addresses.length} wallets, source=${cohort.source}) — ` +
        (lead
          ? `${lead.coin} net ${lead.netBias} $${Math.abs(lead.netNtlUsd)} across ${lead.wallets} wallets.`
          : "no open cohort positions."),
      data: {
        source: cohort.source,
        walletsQueried: accounts.length,
        walletsRequested: cohort.addresses.length,
        dex: dex ?? "main",
        walletsCappedTo: size.cappedTo,
        asOf: now,
        coins: enriched,
        disclaimer: ANALYTICS_DISCLAIMER,
      },
    };
  },
};

function delta(current: number, prev: unknown): number | null {
  if (prev && typeof prev === "object" && "netNtlUsd" in prev) {
    return round(current - Number((prev as { netNtlUsd: number }).netNtlUsd), 2);
  }
  return null;
}

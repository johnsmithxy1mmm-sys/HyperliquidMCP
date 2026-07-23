import { z } from "zod";
import type { ToolDef } from "../registry.js";
import type { ToolContext } from "../registry.js";
import { getMarketRows, buildRow, type MarketRow } from "../../hl/markets.js";
import { round, paginate } from "../../core/format.js";
import { ANALYTICS_DISCLAIMER } from "../../hl/whales.js";
import { log } from "../../logger.js";

/**
 * HIP-3 markets are builder-deployed perps (RWA / equity-style) living on
 * SEPARATE perp dexs, not the main universe. Coverage strategy:
 *   1. enumerate builder dexs via `perpDexs` (verified endpoint);
 *   2. fetch each dex's metaAndAssetCtxs (try/catch — skip dexs that fail);
 *   3. plus any ":"-named rows already present in the main universe.
 * Optionally pass `spotRefs` (coin -> external spot price) for basis calc.
 */
const MAX_DEXS = 10;

export const hip3Analytics: ToolDef = {
  name: "hl_hip3_analytics",
  tier: "premium",
  title: "HIP-3 market analytics",
  description:
    "Analytics for HIP-3 (builder-deployed) perp markets such as RWA/equity perps: volume, open interest, funding, " +
    "and 24h change, enumerated across builder dexs. Optionally pass `spotRefs` (coin→external spot price) to " +
    "compute basis vs an external reference. " +
    ANALYTICS_DISCLAIMER,
  inputSchema: {
    dex: z.string().optional().describe("Filter to one builder dex by name (the part before ':' in market names)."),
    spotRefs: z
      .record(z.number())
      .optional()
      .describe("Optional map of coin symbol -> external spot price for basis calculation."),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(200).default(50),
  },
  outputSchema: {
    hip3MarketCount: z.number(),
    dexsScanned: z.array(z.string()),
    dexsFailed: z.array(z.string()),
    markets: z.array(z.record(z.any())),
    nextOffset: z.number().nullable(),
    disclaimer: z.string(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  run: async (args, ctx) => {
    const dexFilter = (args.dex as string | undefined)?.toLowerCase();
    const spotRefs = (args.spotRefs as Record<string, number> | undefined) ?? {};

    const { rows, dexsScanned, dexsFailed } = await collectHip3Rows(ctx, dexFilter);

    const markets = rows.map((r) => {
      const dex = r.coin.includes(":") ? r.coin.split(":")[0] : null;
      const ref = spotRefs[r.coin] ?? spotRefs[r.coin.split(":").pop() ?? r.coin];
      const basisPct = ref && ref > 0 ? round(((r.markPx - ref) / ref) * 100, 4) : null;
      return {
        coin: r.coin,
        dex,
        markPx: r.markPx,
        oraclePx: r.oraclePx,
        fundingAprPct: round(r.fundingApr * 100, 2),
        openInterestUsd: round(r.openInterest * r.markPx, 0),
        dayNtlVlm: round(r.dayNtlVlm, 0),
        change24hPct: round(r.change24hPct * 100, 2),
        maxLeverage: r.maxLeverage,
        externalSpotRef: ref ?? null,
        basisPct,
      };
    });
    markets.sort((a, b) => b.dayNtlVlm - a.dayNtlVlm);
    const page = paginate(markets, args.offset as number, args.limit as number);

    return {
      summary:
        markets.length === 0
          ? `No HIP-3 markets found (${dexsScanned.length} builder dexs scanned` +
            (dexsFailed.length ? `, ${dexsFailed.length} unavailable` : "") +
            `).`
          : `${markets.length} HIP-3 markets across ${dexsScanned.length} dexs. ` +
            `Top by volume: ${page.items.slice(0, 3).map((m) => m.coin).join(", ")}.`,
      data: {
        hip3MarketCount: markets.length,
        dexsScanned,
        dexsFailed,
        markets: page.items,
        nextOffset: page.nextOffset,
        disclaimer: ANALYTICS_DISCLAIMER,
      },
    };
  },
};

async function collectHip3Rows(
  ctx: ToolContext,
  dexFilter: string | undefined,
): Promise<{ rows: MarketRow[]; dexsScanned: string[]; dexsFailed: string[] }> {
  const byCoin = new Map<string, MarketRow>();

  // 1) ":"-named rows already visible in the main universe.
  for (const r of await getMarketRows(ctx.hl)) {
    if (r.isHip3 && !r.isDelisted) byCoin.set(r.coin, r);
  }

  // 2) Builder dexs (the canonical source of HIP-3 markets).
  const dexsScanned: string[] = [];
  const dexsFailed: string[] = [];
  let dexNames: string[] = [];
  try {
    dexNames = (await ctx.hl.perpDexs())
      .filter((d): d is NonNullable<typeof d> => d !== null && typeof d?.name === "string" && d.name.length > 0)
      .map((d) => d.name);
  } catch (err) {
    log.warn("perpDexs unavailable", { err: String(err) });
  }
  if (dexFilter) dexNames = dexNames.filter((n) => n.toLowerCase() === dexFilter);

  for (const dex of dexNames.slice(0, MAX_DEXS)) {
    try {
      const [meta, ctxs] = await ctx.hl.metaAndAssetCtxsForDex(dex);
      for (let i = 0; i < meta.universe.length; i++) {
        const m = meta.universe[i];
        const c = ctxs[i];
        if (!m || !c || m.isDelisted === true) continue;
        const row = buildRow(m, c, i);
        const coin = m.name.includes(":") ? m.name : `${dex}:${m.name}`;
        byCoin.set(coin, { ...row, coin, isHip3: true });
      }
      dexsScanned.push(dex);
    } catch (err) {
      log.warn("builder dex fetch failed", { dex, err: String(err) });
      dexsFailed.push(dex);
    }
  }

  let rows = [...byCoin.values()];
  if (dexFilter) rows = rows.filter((r) => r.coin.toLowerCase().startsWith(`${dexFilter}:`));
  return { rows, dexsScanned, dexsFailed };
}

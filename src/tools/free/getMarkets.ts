import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { getMarketRows } from "../../hl/markets.js";
import { paginate, round } from "../../core/format.js";

const SORTS = ["volume", "openInterest", "funding", "change24h", "name"] as const;

export const getMarkets: ToolDef = {
  name: "hl_get_markets",
  tier: "free",
  title: "List Hyperliquid perp markets",
  description:
    "List Hyperliquid perpetual markets with mark/oracle price, hourly + annualized funding, open interest, and 24h volume. " +
    "Use to discover valid coin symbols and scan the board. Supports name filter, sorting, and pagination.",
  inputSchema: {
    filter: z.string().optional().describe("Case-insensitive substring match on coin symbol (e.g. 'BTC')."),
    sort: z.enum(SORTS).default("volume").describe("Sort field (desc for numeric, asc for name)."),
    includeDelisted: z.boolean().default(false).describe("Include delisted markets."),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(200).default(50),
  },
  outputSchema: {
    markets: z.array(z.record(z.any())),
    total: z.number(),
    offset: z.number(),
    limit: z.number(),
    nextOffset: z.number().nullable(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  run: async (args, ctx) => {
    const filter = (args.filter as string | undefined)?.toLowerCase();
    const sort = (args.sort as (typeof SORTS)[number]) ?? "volume";
    const includeDelisted = args.includeDelisted === true;
    const offset = (args.offset as number) ?? 0;
    const limit = (args.limit as number) ?? 50;

    let rows = await getMarketRows(ctx.hl);
    if (!includeDelisted) rows = rows.filter((r) => !r.isDelisted);
    if (filter) rows = rows.filter((r) => r.coin.toLowerCase().includes(filter));

    rows.sort((a, b) => {
      switch (sort) {
        case "name":
          return a.coin.localeCompare(b.coin);
        case "openInterest":
          return b.openInterest * b.markPx - a.openInterest * a.markPx;
        case "funding":
          return Math.abs(b.fundingApr) - Math.abs(a.fundingApr);
        case "change24h":
          return b.change24hPct - a.change24hPct;
        case "volume":
        default:
          return b.dayNtlVlm - a.dayNtlVlm;
      }
    });

    const page = paginate(rows, offset, limit);
    const markets = page.items.map((r) => ({
      coin: r.coin,
      markPx: r.markPx,
      oraclePx: r.oraclePx,
      fundingHourly: round(r.fundingHourly, 8),
      fundingApr: round(r.fundingApr, 4),
      openInterestUsd: round(r.openInterest * r.markPx, 0),
      dayNtlVlm: round(r.dayNtlVlm, 0),
      change24hPct: round(r.change24hPct * 100, 2),
      maxLeverage: r.maxLeverage,
      isHip3: r.isHip3,
    }));

    const top = markets.slice(0, 5).map((m) => `${m.coin} $${m.markPx}`).join(", ");
    return {
      summary: `${page.total} markets (showing ${markets.length}, sorted by ${sort}). Top: ${top}.`,
      data: { markets, total: page.total, offset: page.offset, limit: page.limit, nextOffset: page.nextOffset },
    };
  },
};

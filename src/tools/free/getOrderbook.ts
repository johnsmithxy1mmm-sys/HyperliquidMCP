import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { resolveMarket } from "../../hl/markets.js";
import { num, round } from "../../core/format.js";

export const getOrderbook: ToolDef = {
  name: "hl_get_orderbook",
  tier: "free",
  title: "Get L2 order book",
  description:
    "Level-2 order book for a coin: top-N bid/ask levels with price, size, and order count, plus spread and mid. " +
    "Use for microstructure, spread, and near-touch liquidity. If the coin is unknown, call hl_get_markets first.",
  inputSchema: {
    coin: z.string().describe("Perp coin symbol, e.g. 'BTC' (case-insensitive)."),
    depth: z.number().int().min(1).max(50).default(10).describe("Number of levels per side."),
  },
  outputSchema: {
    coin: z.string(),
    time: z.number(),
    midPx: z.number().nullable(),
    spread: z.number().nullable(),
    spreadBps: z.number().nullable(),
    bids: z.array(z.record(z.any())),
    asks: z.array(z.record(z.any())),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  run: async (args, ctx) => {
    const coin = String(args.coin);
    const depth = (args.depth as number) ?? 10;
    const market = await resolveMarket(ctx.hl, coin);
    const book = await ctx.hl.l2Book(market.coin);

    const mapLevel = (l: { px: string; sz: string; n: number }) => ({
      px: num(l.px),
      sz: num(l.sz),
      orders: l.n,
    });
    const bids = (book.levels?.[0] ?? []).slice(0, depth).map(mapLevel);
    const asks = (book.levels?.[1] ?? []).slice(0, depth).map(mapLevel);

    const bestBid = bids[0]?.px;
    const bestAsk = asks[0]?.px;
    const mid = bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : market.midPx;
    const spread = bestBid !== undefined && bestAsk !== undefined ? bestAsk - bestBid : null;
    const spreadBps = spread !== null && mid ? round((spread / mid) * 10_000, 3) : null;

    return {
      summary:
        `${market.coin} book — mid ${mid ? "$" + round(mid, 6) : "n/a"}, ` +
        `spread ${spreadBps ?? "n/a"} bps, ${bids.length} bids / ${asks.length} asks.`,
      data: {
        coin: market.coin,
        time: book.time,
        midPx: mid ?? null,
        spread,
        spreadBps,
        bids,
        asks,
      },
    };
  },
};

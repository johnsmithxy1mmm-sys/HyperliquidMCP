import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { assertAddress, num, paginate } from "../../core/format.js";
import { resolveDexArg } from "../../hl/account.js";

export const getOpenOrders: ToolDef = {
  name: "hl_get_open_orders",
  tier: "free",
  title: "Get open orders",
  description:
    "Open resting orders for an address: coin, side, price, size, order id, type, and trigger info. " +
    "Read-only; paginated. Use to inspect any wallet's live order book footprint.",
  inputSchema: {
    address: z.string().describe("EVM 0x address."),
    dex: z.string().optional().describe("Perp dex: omit for the main dex, a HIP-3 builder dex name (e.g. 'xyz'), or 'all' for every dex."),
    coin: z.string().optional().describe("Optional filter to a single coin."),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(200).default(100),
  },
  outputSchema: {
    address: z.string(),
    total: z.number(),
    orders: z.array(z.record(z.any())),
    nextOffset: z.number().nullable(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  run: async (args, ctx) => {
    const address = assertAddress(String(args.address));
    const coinFilter = (args.coin as string | undefined)?.toUpperCase();
    const dex = await resolveDexArg(ctx.hl, args.dex);
    const dexs = dex === "all" ? [undefined, ...(await ctx.hl.perpDexs()).flatMap((d) => (d?.name ? [d.name] : []))] : [dex || undefined];
    const raw = (await Promise.all(dexs.map((d) => ctx.hl.openOrders(address, d)))).flat();

    let orders = raw.map((o) => ({
      coin: o.coin,
      oid: o.oid,
      side: o.side === "B" ? "buy" : "sell",
      limitPx: num(o.limitPx),
      sz: num(o.sz),
      origSz: o.origSz !== undefined ? num(o.origSz) : undefined,
      reduceOnly: o.reduceOnly ?? false,
      orderType: o.orderType ?? "limit",
      isTrigger: o.isTrigger ?? false,
      triggerPx: o.triggerPx !== undefined ? num(o.triggerPx) : undefined,
      timestamp: o.timestamp,
    }));
    if (coinFilter) orders = orders.filter((o) => o.coin.toUpperCase() === coinFilter);

    const page = paginate(orders, args.offset as number, args.limit as number);
    return {
      summary: `${address.slice(0, 8)}…: ${page.total} open orders${coinFilter ? ` on ${coinFilter}` : ""}.`,
      data: { address, total: page.total, orders: page.items, nextOffset: page.nextOffset },
    };
  },
};

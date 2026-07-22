import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { resolveMarket } from "../../hl/markets.js";
import { num, round, paginate } from "../../core/format.js";

const INTERVALS = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d", "3d", "1w", "1M"] as const;

const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "8h": 28_800_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
  "3d": 259_200_000,
  "1w": 604_800_000,
  "1M": 2_592_000_000,
};

export const getCandles: ToolDef = {
  name: "hl_get_candles",
  tier: "free",
  title: "Get OHLCV candles",
  description:
    "OHLCV candlestick history for a coin at a given interval. Provide either an explicit [startTime,endTime] " +
    "(ms epoch) or a `lookback` count of the most recent candles. Returns most-recent-last, paginated.",
  inputSchema: {
    coin: z.string().describe("Perp coin symbol, e.g. 'ETH'."),
    interval: z.enum(INTERVALS).default("1h"),
    lookback: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("Number of most-recent candles to fetch (ignored if startTime given)."),
    startTime: z.number().int().optional().describe("Start time in ms epoch."),
    endTime: z.number().int().optional().describe("End time in ms epoch (default now)."),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(500).default(200),
  },
  outputSchema: {
    coin: z.string(),
    interval: z.string(),
    candles: z.array(z.record(z.any())),
    total: z.number(),
    nextOffset: z.number().nullable(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  run: async (args, ctx) => {
    const coin = String(args.coin);
    const interval = (args.interval as string) ?? "1h";
    const market = await resolveMarket(ctx.hl, coin);

    const endTime = (args.endTime as number | undefined) ?? Date.now();
    let startTime = args.startTime as number | undefined;
    if (startTime === undefined) {
      const lookback = (args.lookback as number | undefined) ?? 200;
      startTime = endTime - lookback * (INTERVAL_MS[interval] ?? 3_600_000);
    }

    const raw = await ctx.hl.candles(market.coin, interval, startTime, endTime);
    const candles = raw
      .sort((a, b) => a.t - b.t)
      .map((c) => ({
        t: c.t,
        o: num(c.o),
        h: num(c.h),
        l: num(c.l),
        c: num(c.c),
        v: round(num(c.v), 4),
        n: c.n,
      }));

    const page = paginate(candles, args.offset as number, args.limit as number);
    const last = page.items[page.items.length - 1];
    return {
      summary:
        `${market.coin} ${interval}: ${page.total} candles` +
        (last ? `, last close $${last.c} at ${new Date(last.t).toISOString()}.` : "."),
      data: {
        coin: market.coin,
        interval,
        candles: page.items,
        total: page.total,
        nextOffset: page.nextOffset,
      },
    };
  },
};

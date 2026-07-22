import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { resolveMarket } from "../../hl/markets.js";
import { num, round, annualizeHourlyFunding, paginate } from "../../core/format.js";

export const getFundingHistory: ToolDef = {
  name: "hl_get_funding_history",
  tier: "free",
  title: "Get funding rate history",
  description:
    "Historical hourly funding rates for a coin over a time window, with cumulative and average annualized funding. " +
    "Use for carry analysis and funding trend. Defaults to the last 7 days if no window is given.",
  inputSchema: {
    coin: z.string().describe("Perp coin symbol, e.g. 'BTC'."),
    startTime: z.number().int().optional().describe("Start time ms epoch (default: 7 days ago)."),
    endTime: z.number().int().optional().describe("End time ms epoch (default now)."),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(500).default(200),
  },
  outputSchema: {
    coin: z.string(),
    count: z.number(),
    avgHourly: z.number(),
    avgApr: z.number(),
    cumulative: z.number(),
    entries: z.array(z.record(z.any())),
    nextOffset: z.number().nullable(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  run: async (args, ctx) => {
    const coin = String(args.coin);
    const market = await resolveMarket(ctx.hl, coin);
    const endTime = (args.endTime as number | undefined) ?? Date.now();
    const startTime = (args.startTime as number | undefined) ?? endTime - 7 * 86_400_000;

    const raw = await ctx.hl.fundingHistory(market.coin, startTime, endTime);
    const sorted = raw.sort((a, b) => a.time - b.time);
    const rates = sorted.map((e) => num(e.fundingRate));
    const avgHourly = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
    const cumulative = rates.reduce((a, b) => a + b, 0);

    const entries = sorted.map((e) => ({
      time: e.time,
      fundingRate: round(num(e.fundingRate), 8),
      premium: round(num(e.premium), 8),
    }));
    const page = paginate(entries, args.offset as number, args.limit as number);

    return {
      summary:
        `${market.coin} funding: ${entries.length} points, avg ${round(annualizeHourlyFunding(avgHourly) * 100, 3)}% APR, ` +
        `cumulative ${round(cumulative * 100, 4)}% over window.`,
      data: {
        coin: market.coin,
        count: entries.length,
        avgHourly: round(avgHourly, 8),
        avgApr: round(annualizeHourlyFunding(avgHourly), 6),
        cumulative: round(cumulative, 8),
        entries: page.items,
        nextOffset: page.nextOffset,
      },
    };
  },
};

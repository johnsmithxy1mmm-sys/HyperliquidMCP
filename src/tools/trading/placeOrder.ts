import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { ToolError } from "../../core/errors.js";

const TRADING_DISCLAIMER =
  "⚠️ Places a REAL order via your agent wallet when confirm=true and dry-run is off. " +
  "Trades are risky and irreversible; this is not investment advice. Test on testnet first. " +
  "The customer builder code is attached to earn a small builder fee.";

export const placeOrder: ToolDef = {
  name: "hl_place_order",
  tier: "trading",
  title: "Place order (agent wallet)",
  description:
    "Place a limit or market perp order through YOUR local agent wallet, with the HyperSignal builder code attached. " +
    "Dry-run by default (previews the exact signed action without sending). Set confirm=true AND dryRun=false to submit. " +
    TRADING_DISCLAIMER,
  inputSchema: {
    coin: z.string().describe("Perp coin symbol, e.g. 'BTC'."),
    side: z.enum(["buy", "sell"]),
    size: z.number().positive().describe("Order size in base units."),
    limitPx: z.number().positive().optional().describe("Limit price; omit for a market (IOC) order."),
    tif: z.enum(["Gtc", "Ioc", "Alo"]).default("Gtc").describe("Time-in-force for limit orders."),
    reduceOnly: z.boolean().default(false),
    slippageBps: z.number().min(0).max(1000).default(50).describe("Slippage bound for market orders (bps)."),
    confirm: z.boolean().default(false).describe("Must be true to submit. False => dry-run preview."),
    dryRun: z.boolean().default(true).describe("Keep true to preview only; set false (with confirm) to submit."),
  },
  outputSchema: {
    mode: z.string(),
    reason: z.string().optional(),
    action: z.record(z.any()),
    builderAttached: z.record(z.any()).nullable(),
    agentAddress: z.string().optional(),
    response: z.any().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  run: async (args, ctx) => {
    if (!ctx.trading) throw new ToolError("trading_unavailable", "Trading tools are only available in local stdio mode.");
    const confirm = args.confirm === true;
    const dryRun = args.dryRun !== false;
    const result = await ctx.trading.placeOrder(
      {
        coin: String(args.coin),
        isBuy: args.side === "buy",
        sz: args.size as number,
        limitPx: args.limitPx as number | undefined,
        reduceOnly: args.reduceOnly === true,
        tif: (args.tif as "Gtc" | "Ioc" | "Alo") ?? "Gtc",
        slippageBps: args.slippageBps as number | undefined,
      },
      { confirm, dryRun },
    );
    return { summary: summarize(result.mode, String(args.coin), String(args.side)), data: result };
  },
};

function summarize(mode: string, coin: string, side: string): string {
  if (mode === "submitted") return `Submitted ${side} ${coin} order.`;
  if (mode === "blocked") return `Order blocked (not submitted). ${coin} ${side}.`;
  return `Dry-run preview for ${side} ${coin}. Set confirm=true and dryRun=false to submit.`;
}

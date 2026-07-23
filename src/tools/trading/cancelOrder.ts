import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { ToolError } from "../../core/errors.js";

export const cancelOrder: ToolDef = {
  name: "hl_cancel_order",
  tier: "trading",
  title: "Cancel order (agent wallet)",
  description:
    "Cancel a resting order by coin + order id via your local agent wallet. Dry-run by default; set confirm=true AND " +
    "dryRun=false to submit. Analytics/execution helper, not investment advice.",
  inputSchema: {
    coin: z.string().describe("Perp coin symbol of the order."),
    oid: z.number().int().describe("Order id (from hl_get_open_orders)."),
    confirm: z.boolean().default(false),
    dryRun: z.boolean().default(true),
  },
  outputSchema: {
    mode: z.string(),
    reason: z.string().optional(),
    action: z.record(z.any()),
    builderAttached: z.record(z.any()).nullable().optional(),
    agentAddress: z.string().optional(),
    response: z.any().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  run: async (args, ctx) => {
    if (!ctx.trading) throw new ToolError("trading_unavailable", "Trading tools are only available in local stdio mode.");
    const result = await ctx.trading.cancelOrder(String(args.coin), args.oid as number, {
      confirm: args.confirm === true,
      dryRun: args.dryRun !== false,
    });
    const summary =
      result.mode === "submitted"
        ? `Cancelled order ${args.oid} on ${args.coin}.`
        : result.mode === "blocked"
          ? `Cancel of order ${args.oid} on ${args.coin} blocked (${result.reason}); not submitted.`
          : `Dry-run: would cancel order ${args.oid} on ${args.coin}. Set confirm=true & dryRun=false to submit.`;
    return { summary, data: result };
  },
};

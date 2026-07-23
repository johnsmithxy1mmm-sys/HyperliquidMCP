import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { ToolError } from "../../core/errors.js";

export const closePosition: ToolDef = {
  name: "hl_close_position",
  tier: "trading",
  title: "Close position (agent wallet)",
  description:
    "Close an open perp position with a reduce-only market (IOC) order via your local agent wallet, builder code " +
    "attached. Dry-run by default; set confirm=true AND dryRun=false to submit. Irreversible; not investment advice.",
  inputSchema: {
    coin: z.string().describe("Perp coin symbol of the position to close."),
    address: z.string().optional().describe("Account holding the position; defaults to the agent wallet address."),
    confirm: z.boolean().default(false),
    dryRun: z.boolean().default(true),
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
    const result = await ctx.trading.closePosition(
      String(args.coin),
      { confirm: args.confirm === true, dryRun: args.dryRun !== false },
      args.address as string | undefined,
    );
    const summary =
      result.mode === "submitted"
        ? `Submitted reduce-only close for ${args.coin}.`
        : result.mode === "blocked"
          ? `Close of ${args.coin} blocked (${result.reason}); not submitted.`
          : `Dry-run: would close ${args.coin}. Set confirm=true & dryRun=false to submit.`;
    return { summary, data: result };
  },
};

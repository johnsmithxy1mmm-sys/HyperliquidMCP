import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { ToolError } from "../../core/errors.js";

export const approveBuilderFeeGuide: ToolDef = {
  name: "hl_approve_builder_fee_guide",
  tier: "trading",
  title: "Approve builder fee — guide (read-only)",
  description:
    "Read-only. Generates the exact approveBuilderFee action payload and step-by-step instructions for the user to " +
    "authorize the HyperSignal builder code with their MAIN wallet. This tool never signs and never sees your main " +
    "key. Not investment advice.",
  inputSchema: {},
  outputSchema: {
    action: z.record(z.any()),
    maxFeeRate: z.string(),
    builderAddress: z.string(),
    endpoint: z.string(),
    instructions: z.array(z.string()),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run: async (_args, ctx) => {
    if (!ctx.trading) throw new ToolError("trading_unavailable", "Trading tools are only available in local stdio mode.");
    const guide = ctx.trading.approveBuilderFeeGuide();
    return {
      summary: `To enable the builder code, approve ${guide.builderAddress} up to ${guide.maxFeeRate} with your main wallet.`,
      data: guide,
    };
  },
};

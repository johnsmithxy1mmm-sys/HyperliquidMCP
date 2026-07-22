import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { assertAddress, round } from "../../core/format.js";
import { normalizeAccount } from "../../hl/account.js";

export const getAccount: ToolDef = {
  name: "hl_get_account",
  tier: "free",
  title: "Get account positions & margin",
  description:
    "Perp account snapshot for any address: equity, margin usage, withdrawable, and open positions " +
    "(size, entry, uPnL, leverage, liquidation price). Read-only; works for any public 0x address.",
  inputSchema: {
    address: z.string().describe("EVM 0x address (42 hex chars)."),
  },
  outputSchema: {
    address: z.string(),
    accountValue: z.number(),
    totalNtlPos: z.number(),
    totalMarginUsed: z.number(),
    withdrawable: z.number(),
    marginUtilization: z.number(),
    positions: z.array(z.record(z.any())),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  run: async (args, ctx) => {
    const address = assertAddress(String(args.address));
    const state = await ctx.hl.clearinghouseState(address);
    const acct = normalizeAccount(state);
    const marginUtilization = acct.accountValue > 0 ? round(acct.totalMarginUsed / acct.accountValue, 4) : 0;

    return {
      summary:
        `Account ${address.slice(0, 8)}…: equity $${acct.accountValue}, ` +
        `${acct.positions.length} positions, margin util ${round(marginUtilization * 100, 1)}%.`,
      data: {
        address,
        accountValue: acct.accountValue,
        totalNtlPos: acct.totalNtlPos,
        totalMarginUsed: acct.totalMarginUsed,
        withdrawable: acct.withdrawable,
        marginUtilization,
        positions: acct.positions,
      },
    };
  },
};

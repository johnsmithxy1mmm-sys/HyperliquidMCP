import { z } from "zod";
import type { ToolDef, ToolContext } from "../registry.js";
import { ToolError } from "../../core/errors.js";
import { resolveMarket } from "../../hl/markets.js";
import { normalizeAccount } from "../../hl/account.js";
import { addressForKey } from "../../trading/signing.js";
import { assertAddress } from "../../core/format.js";
import { planTwap, planMirror, type MirrorPositionInput } from "../../execution/plan.js";

const EXEC_DISCLAIMER =
  "⚠️ Executes REAL child orders on your agent wallet when confirm=true & dryRun=false (builder code attached). " +
  "Dry-run by default. Irreversible; not investment advice. Test on testnet first.";

function requireExecution(ctx: ToolContext) {
  if (!ctx.execution || !ctx.trading) {
    throw new ToolError("execution_unavailable", "Execution tools are only available in local stdio mode.");
  }
  return { execution: ctx.execution, trading: ctx.trading };
}

export const twapOrder: ToolDef = {
  name: "hl_twap_order",
  tier: "trading",
  title: "TWAP execution",
  description:
    "Accumulate/reduce a position by slicing it into evenly-spaced child orders over a duration (TWAP), minimizing " +
    "market impact, with the builder code on every child. Dry-run returns the schedule; live schedules it and returns " +
    "a plan id (poll with hl_execution_status). " +
    EXEC_DISCLAIMER,
  inputSchema: {
    coin: z.string(),
    side: z.enum(["buy", "sell"]),
    totalSize: z.number().positive(),
    slices: z.number().int().min(1).max(200).default(10),
    durationMinutes: z.number().min(0).max(1440).default(30),
    reduceOnly: z.boolean().default(false),
    confirm: z.boolean().default(false),
    dryRun: z.boolean().default(true),
  },
  outputSchema: {
    mode: z.string(),
    planId: z.string().optional(),
    coin: z.string(),
    side: z.string(),
    children: z.array(z.record(z.any())),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  run: async (args, ctx) => {
    const { execution } = requireExecution(ctx);
    const market = await resolveMarket(ctx.hl, String(args.coin));
    const children = planTwap({
      totalSize: args.totalSize as number,
      slices: args.slices as number,
      durationMs: (args.durationMinutes as number) * 60_000,
    });
    if (children.length === 0) throw new ToolError("bad_plan", "TWAP produced no child orders; check totalSize/slices.");

    const isBuy = args.side === "buy";
    const live = args.confirm === true && args.dryRun !== true;
    if (!live) {
      return {
        summary: `Dry-run TWAP: ${children.length} slices of ${market.coin} over ${args.durationMinutes}m. Set confirm=true & dryRun=false to run.`,
        data: { mode: "dry_run", coin: market.coin, side: String(args.side), children },
      };
    }
    const plan = execution.schedule({
      kind: "twap",
      coin: market.coin,
      isBuy,
      reduceOnly: args.reduceOnly === true,
      children,
      live: true,
    });
    return {
      summary: `TWAP scheduled: ${children.length} slices of ${market.coin}. Poll hl_execution_status with planId ${plan.id.slice(0, 8)}….`,
      data: { mode: "scheduled", planId: plan.id, coin: market.coin, side: String(args.side), children: plan.children },
    };
  },
};

export const copyWallet: ToolDef = {
  name: "hl_copy_wallet",
  tier: "trading",
  title: "Copy-trade a wallet",
  description:
    "Mirror a target wallet's perp positioning, scaled to your equity, as market orders with the builder code " +
    "attached. Dry-run returns the mirror plan (per-coin side/size); live submits it. Your agent equity is inferred " +
    "from the agent wallet unless myEquityUsd is given. " +
    EXEC_DISCLAIMER,
  inputSchema: {
    targetAddress: z.string().describe("Wallet to copy (0x)."),
    scale: z.number().min(0).max(10).default(1).describe("Exposure multiple relative to equity-proportional mirror."),
    myEquityUsd: z.number().min(0).optional().describe("Override your equity; else inferred from the agent wallet."),
    confirm: z.boolean().default(false),
    dryRun: z.boolean().default(true),
  },
  outputSchema: {
    mode: z.string(),
    targetEquityUsd: z.number(),
    myEquityUsd: z.number(),
    orders: z.array(z.record(z.any())),
    results: z.array(z.record(z.any())).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  run: async (args, ctx) => {
    const { trading } = requireExecution(ctx);
    const targetAddress = assertAddress(String(args.targetAddress));
    const target = await ctx.hl.clearinghouseState(targetAddress);
    const targetAcct = normalizeAccount(target);

    let myEquity = args.myEquityUsd as number | undefined;
    if (myEquity === undefined) {
      if (!ctx.config.agentPrivateKey) {
        throw new ToolError("no_equity", "Provide myEquityUsd, or set HL_AGENT_PRIVATE_KEY to infer your equity.");
      }
      const mine = normalizeAccount(await ctx.hl.clearinghouseState(addressForKey(ctx.config.agentPrivateKey)));
      myEquity = mine.accountValue;
    }

    const positions: MirrorPositionInput[] = targetAcct.positions
      .filter((p) => p.szi !== 0)
      .map((p) => ({ coin: p.coin, szi: p.szi, markPx: p.szi !== 0 ? Math.abs(p.positionValueUsd / p.szi) : 0 }));
    const orders = planMirror(positions, myEquity, targetAcct.accountValue, args.scale as number);

    const live = args.confirm === true && args.dryRun !== true;
    if (!live) {
      return {
        summary: `Dry-run copy: mirror ${orders.length} position(s) of ${String(args.targetAddress).slice(0, 8)}… scaled to $${myEquity}. Set confirm=true & dryRun=false to submit.`,
        data: { mode: "dry_run", targetEquityUsd: targetAcct.accountValue, myEquityUsd: myEquity, orders },
      };
    }

    const results: Array<Record<string, unknown>> = [];
    for (const o of orders) {
      // One failed leg must not abort the batch: earlier legs are already on
      // the exchange, so every leg's outcome has to be reported.
      try {
        const res = await trading.placeOrder(
          { coin: o.coin, isBuy: o.isBuy, sz: o.size, reduceOnly: false, tif: "Ioc" },
          { confirm: true, dryRun: false },
        );
        results.push({ coin: o.coin, side: o.isBuy ? "buy" : "sell", size: o.size, mode: res.mode, reason: res.reason });
      } catch (err) {
        results.push({
          coin: o.coin,
          side: o.isBuy ? "buy" : "sell",
          size: o.size,
          mode: "error",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return {
      summary: `Copy submitted: ${results.filter((r) => r.mode === "submitted").length}/${orders.length} mirror orders.`,
      data: { mode: "submitted", targetEquityUsd: targetAcct.accountValue, myEquityUsd: myEquity, orders, results },
    };
  },
};

export const executionStatus: ToolDef = {
  name: "hl_execution_status",
  tier: "trading",
  title: "Execution status",
  description: "Status of TWAP/execution plans: child order progress. Pass planId for one plan, or omit to list all.",
  inputSchema: { planId: z.string().optional() },
  outputSchema: { plans: z.array(z.record(z.any())) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run: async (args, ctx) => {
    const { execution } = requireExecution(ctx);
    if (args.planId) {
      const plan = execution.get(String(args.planId));
      if (!plan) throw new ToolError("not_found", `No execution plan ${args.planId}.`);
      return { summary: `Plan ${plan.id.slice(0, 8)}…: ${plan.status}.`, data: { plans: [plan] } };
    }
    const plans = execution.list();
    return { summary: `${plans.length} execution plan(s).`, data: { plans } };
  },
};

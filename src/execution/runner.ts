/**
 * Background execution runner (stdio / local trading ONLY). Drives a planned
 * schedule of child orders through TradingService, attaching the builder code
 * to each. Live submission is gated (trading enabled + agent key + confirm);
 * otherwise plans stay in "planned" state as previews.
 *
 * Kept intentionally simple and in-memory: execution state lives for the life
 * of the local process. Testnet-first — verify before mainnet.
 */
import { randomUUID } from "node:crypto";
import type { TradingService, OrderParams } from "../trading/exchange.js";
import type { ChildOrder } from "./plan.js";
import { log } from "../logger.js";

export type PlanStatus = "planned" | "running" | "completed" | "failed" | "cancelled";

export interface ChildResult {
  index: number;
  size: number;
  status: "pending" | "submitted" | "error";
  detail?: string;
}

export interface ExecutionPlan {
  id: string;
  kind: "twap" | "iceberg" | "mirror";
  coin: string;
  side: "buy" | "sell";
  status: PlanStatus;
  createdAt: number;
  children: ChildResult[];
  live: boolean;
}

export class ExecutionRunner {
  private readonly plans = new Map<string, ExecutionPlan>();
  private readonly timers = new Map<string, NodeJS.Timeout[]>();

  constructor(private readonly trading: TradingService) {}

  get(id: string): ExecutionPlan | undefined {
    return this.plans.get(id);
  }

  list(): ExecutionPlan[] {
    return [...this.plans.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  cancel(id: string): boolean {
    const plan = this.plans.get(id);
    if (!plan) return false;
    for (const t of this.timers.get(id) ?? []) clearTimeout(t);
    this.timers.delete(id);
    if (plan.status === "planned" || plan.status === "running") plan.status = "cancelled";
    return true;
  }

  /**
   * Schedule a set of child orders. When live=false the plan is recorded as a
   * preview (no orders sent). When live=true each child fires at its offset.
   */
  schedule(args: {
    kind: ExecutionPlan["kind"];
    coin: string;
    isBuy: boolean;
    reduceOnly: boolean;
    children: ChildOrder[];
    live: boolean;
  }): ExecutionPlan {
    const id = randomUUID();
    const plan: ExecutionPlan = {
      id,
      kind: args.kind,
      coin: args.coin,
      side: args.isBuy ? "buy" : "sell",
      status: args.live ? "running" : "planned",
      createdAt: Date.now(),
      children: args.children.map((c) => ({ index: c.index, size: c.size, status: "pending" })),
      live: args.live,
    };
    this.plans.set(id, plan);
    if (!args.live) return plan;

    const timers: NodeJS.Timeout[] = [];
    for (const child of args.children) {
      const t = setTimeout(() => void this.fireChild(plan, child, args), child.atOffsetMs);
      t.unref?.();
      timers.push(t);
    }
    this.timers.set(id, timers);
    return plan;
  }

  private async fireChild(
    plan: ExecutionPlan,
    child: ChildOrder,
    args: { coin: string; isBuy: boolean; reduceOnly: boolean },
  ): Promise<void> {
    if (plan.status === "cancelled") return;
    // Look up by index property, not array position — robust to any planner
    // that filters/reorders children.
    const slot = plan.children.find((s) => s.index === child.index);
    if (!slot) return;
    const params: OrderParams = {
      coin: args.coin,
      isBuy: args.isBuy,
      sz: child.size,
      reduceOnly: args.reduceOnly,
      tif: "Ioc",
    };
    try {
      const res = await this.trading.placeOrder(params, { confirm: true, dryRun: false });
      slot.status = res.mode === "submitted" ? "submitted" : "error";
      slot.detail = res.mode === "submitted" ? undefined : res.reason;
    } catch (err) {
      slot.status = "error";
      slot.detail = err instanceof Error ? err.message : String(err);
      log.warn("execution child failed", { plan: plan.id, index: child.index, err: slot.detail });
    }
    // finalize when all children resolved
    if (plan.children.every((c) => c.status !== "pending")) {
      plan.status = plan.children.some((c) => c.status === "error") ? "failed" : "completed";
    }
  }
}

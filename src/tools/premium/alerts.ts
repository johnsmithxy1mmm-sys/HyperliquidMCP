import { z } from "zod";
import type { ToolDef, ToolContext } from "../registry.js";
import { ToolError } from "../../core/errors.js";
import { ANALYTICS_DISCLAIMER } from "../../hl/whales.js";
import { resolveMarket } from "../../hl/markets.js";
import { isAddress } from "../../core/format.js";
import type { AlertType, AlertParams } from "../../alerts/types.js";

const ALERT_TYPES = ["funding_apr", "price_move", "whale_net_flip"] as const;

function requireOwner(ctx: ToolContext): string {
  if (!ctx.subject || ctx.subject === "anon") {
    throw new ToolError(
      "auth_required",
      "Standing alerts are tied to your API key. Provide a valid key (X-API-Key) to create/list alerts.",
    );
  }
  return ctx.subject;
}

export const createAlert: ToolDef = {
  name: "hl_create_alert",
  tier: "premium",
  requiresSubject: true,
  title: "Create a standing alert",
  description:
    "Register a persistent alert the server evaluates on a schedule; fired events are retrieved with hl_poll_alerts. " +
    "Types: funding_apr (|annualized funding| crosses a threshold), price_move (|return| over a window), " +
    "whale_net_flip (cohort net position flips long/short). Turns the server into a market watcher for your agent. " +
    ANALYTICS_DISCLAIMER,
  inputSchema: {
    type: z.enum(ALERT_TYPES),
    coin: z.string().describe("Perp coin symbol the alert watches."),
    aprThreshold: z.number().min(0).optional().describe("funding_apr: |APR| fraction (0.5 = 50%)."),
    movePct: z.number().min(0).optional().describe("price_move: |return| fraction (0.05 = 5%)."),
    windowMinutes: z.number().int().min(5).max(1440).optional().describe("price_move lookback window."),
    cohort: z.array(z.string()).optional().describe("whale_net_flip: 0x addresses (else HL_WHALE_ADDRESSES)."),
    cooldownMinutes: z.number().int().min(5).max(10080).default(120).describe("Min gap between re-fires."),
  },
  outputSchema: { id: z.string(), type: z.string(), coin: z.string(), cooldownMinutes: z.number() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  run: async (args, ctx) => {
    const subject = requireOwner(ctx);
    const type = args.type as AlertType;
    // Validate the coin NOW: an alert on a typo'd symbol would otherwise sit
    // silently forever without firing. Also canonicalizes the casing.
    const market = await resolveMarket(ctx.hl, String(args.coin));
    const params: AlertParams = {
      coin: market.coin,
      aprThreshold: args.aprThreshold as number | undefined,
      movePct: args.movePct as number | undefined,
      windowMinutes: args.windowMinutes as number | undefined,
      cohort: args.cohort as string[] | undefined,
    };
    if (type === "funding_apr" && params.aprThreshold === undefined) params.aprThreshold = 0.5;
    if (type === "price_move" && params.movePct === undefined) params.movePct = 0.05;
    if (type === "whale_net_flip" && params.cohort && params.cohort.length > 0) {
      const bad = params.cohort.filter((a) => !isAddress(a));
      if (bad.length > 0) {
        throw new ToolError("invalid_cohort", `Invalid 0x addresses in cohort: ${bad.slice(0, 3).join(", ")}.`, {
          invalid: bad,
        });
      }
      params.cohort = params.cohort.map((a) => a.toLowerCase());
    }
    const rec = ctx.store.alerts.create(subject, type, params, args.cooldownMinutes as number);
    return {
      summary: `Alert ${rec.id.slice(0, 8)}… created: ${type} on ${params.coin}. Poll with hl_poll_alerts.`,
      data: { id: rec.id, type, coin: params.coin ?? "", cooldownMinutes: rec.cooldownMinutes },
    };
  },
};

export const listAlerts: ToolDef = {
  name: "hl_list_alerts",
  tier: "premium",
  requiresSubject: true,
  title: "List your standing alerts",
  description: "List the standing alerts registered under your API key, with their type, params, and last-fired time.",
  inputSchema: {},
  outputSchema: { count: z.number(), alerts: z.array(z.record(z.any())) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run: async (_args, ctx) => {
    const subject = requireOwner(ctx);
    const alerts = ctx.store.alerts.list(subject).map((a) => ({
      id: a.id,
      type: a.type,
      params: a.params,
      cooldownMinutes: a.cooldownMinutes,
      lastFiredAt: a.lastFiredAt,
      createdAt: a.createdAt,
    }));
    return { summary: `${alerts.length} active alert(s).`, data: { count: alerts.length, alerts } };
  },
};

export const deleteAlert: ToolDef = {
  name: "hl_delete_alert",
  tier: "premium",
  requiresSubject: true,
  title: "Delete a standing alert",
  description: "Delete one of your standing alerts by id.",
  inputSchema: { id: z.string().describe("Alert id from hl_create_alert / hl_list_alerts.") },
  outputSchema: { deleted: z.boolean() },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  run: async (args, ctx) => {
    const subject = requireOwner(ctx);
    const deleted = ctx.store.alerts.delete(String(args.id), subject);
    if (!deleted) throw new ToolError("not_found", `No alert ${args.id} owned by you.`);
    return { summary: `Alert ${String(args.id).slice(0, 8)}… deleted.`, data: { deleted } };
  },
};

export const pollAlerts: ToolDef = {
  name: "hl_poll_alerts",
  tier: "premium",
  requiresSubject: true,
  title: "Poll fired alerts",
  description:
    "Retrieve alert events that fired since your last poll (at-least-once, then marked delivered). Each event " +
    "includes a signed signal payload you can verify with hl_signal_pubkey. Call periodically to act on the market.",
  inputSchema: { limit: z.number().int().min(1).max(200).default(50) },
  outputSchema: { count: z.number(), events: z.array(z.record(z.any())) },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  run: async (args, ctx) => {
    const subject = requireOwner(ctx);
    const events = ctx.store.alerts.pollUnacked(subject, args.limit as number);
    return {
      summary: events.length ? `${events.length} alert event(s) fired.` : "No new alert events.",
      data: { count: events.length, events },
    };
  },
};

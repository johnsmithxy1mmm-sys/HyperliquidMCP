import { z } from "zod";
import { createHash, timingSafeEqual } from "node:crypto";
import type { ToolDef } from "../registry.js";
import { ToolError } from "../../core/errors.js";
import { getDb } from "../../billing/db.js";
import { collectAdminStats, currentPeriod } from "../../admin/stats.js";

/**
 * Constant-time secret check. Both sides are hashed to a fixed 32-byte digest
 * first so timingSafeEqual never throws on a length mismatch and the check
 * doesn't leak the secret's length via timing.
 */
function verifyAdminSecret(provided: string): void {
  const expected = process.env.HYPERSIGNAL_ADMIN_SECRET;
  if (!expected) {
    throw new ToolError(
      "admin_disabled",
      "hl_admin_stats is disabled. Set HYPERSIGNAL_ADMIN_SECRET on the server to enable it.",
    );
  }
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  if (!timingSafeEqual(a, b)) {
    throw new ToolError("unauthorized", "Invalid admin secret.");
  }
}

export const adminStats: ToolDef = {
  name: "hl_admin_stats",
  tier: "free",
  title: "Admin usage & revenue stats",
  description:
    "OPERATOR ONLY. Requires `adminSecret` matching the server's HYPERSIGNAL_ADMIN_SECRET env var (disabled if unset). " +
    "Reports API-key usage this billing period (by key-hash prefix — raw keys are never stored, so exact identity " +
    "requires your own key-issuance records), top-called tools, active standing alerts, the signal track record, " +
    "and x402 payment counts. Not billed as a premium call.",
  inputSchema: {
    adminSecret: z.string().describe("Must match the server's HYPERSIGNAL_ADMIN_SECRET env var."),
    period: z.string().optional().describe("Billing period as YYYY-MM; defaults to the current UTC month."),
  },
  outputSchema: {
    period: z.string(),
    totalKeys: z.number(),
    keys: z.array(z.record(z.any())),
    toolTotalsThisPeriod: z.array(z.record(z.any())),
    totalCallsThisPeriod: z.number(),
    x402PaymentsTotal: z.number(),
    x402PaymentsLast30d: z.number(),
    activeAlerts: z.number(),
    alertsByType: z.array(z.record(z.any())),
    trackRecord: z.array(z.record(z.any())),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run: async (args, ctx) => {
    verifyAdminSecret(String(args.adminSecret ?? ""));

    const db = getDb(ctx.config.dbPath);
    const period = (args.period as string | undefined) ?? currentPeriod();
    const stats = collectAdminStats(db, period);

    const active = ctx.store.alerts.listActive();
    const alertTypeCounts = new Map<string, number>();
    for (const a of active) alertTypeCounts.set(a.type, (alertTypeCounts.get(a.type) ?? 0) + 1);
    const alertsByType = [...alertTypeCounts.entries()].map(([type, count]) => ({ type, count }));

    const trackRecord = ctx.store.signals.trackRecord();

    const topKey = [...stats.keys].sort((a, b) => b.callsThisPeriod - a.callsThisPeriod)[0];
    return {
      summary:
        `${stats.totalKeys} key(s) on file, ${stats.totalCallsThisPeriod} premium call(s) in ${period}` +
        (topKey && topKey.callsThisPeriod > 0 ? `; busiest key ${topKey.keyHashPrefix}… (${topKey.callsThisPeriod} calls)` : "") +
        `. ${active.length} active alert(s). x402: ${stats.x402PaymentsTotal} total payment(s), ${stats.x402PaymentsLast30d} in last 30d.`,
      data: { ...stats, activeAlerts: active.length, alertsByType, trackRecord },
    };
  },
};

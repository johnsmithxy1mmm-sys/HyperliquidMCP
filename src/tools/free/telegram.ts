import { z } from "zod";
import type { ToolDef, ToolContext } from "../registry.js";
import { ToolError } from "../../core/errors.js";

function requireTelegram(ctx: ToolContext) {
  if (!ctx.telegram) {
    throw new ToolError("telegram_not_configured", "Telegram delivery is not enabled on this server.");
  }
  return ctx.telegram;
}

export const linkTelegram: ToolDef = {
  name: "hl_link_telegram",
  tier: "free",
  requiresSubject: true,
  title: "Link Telegram for alerts",
  description:
    "Get a one-time Telegram link (valid 15 minutes). Open it and press Start: this key's standing alerts are then " +
    "also pushed to that chat (up to 30 messages an hour; everything stays available via hl_poll_alerts).",
  inputSchema: {},
  outputSchema: { link: z.string(), expiresInMinutes: z.number() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  run: async (_args, ctx) => {
    const bot = requireTelegram(ctx);
    const link = await bot.linkFor(ctx.subject);
    return {
      summary: `Open ${link} and press Start within 15 minutes to receive this key's alerts in Telegram.`,
      data: { link, expiresInMinutes: 15 },
    };
  },
};

export const unlinkTelegram: ToolDef = {
  name: "hl_unlink_telegram",
  tier: "free",
  requiresSubject: true,
  title: "Unlink Telegram",
  description: "Stop pushing this key's alerts to Telegram (they remain available via hl_poll_alerts).",
  inputSchema: {},
  outputSchema: { unlinked: z.boolean() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run: async (_args, ctx) => {
    const unlinked = requireTelegram(ctx).unlink(ctx.subject);
    return { summary: unlinked ? "Telegram unlinked." : "No Telegram chat was linked.", data: { unlinked } };
  },
};

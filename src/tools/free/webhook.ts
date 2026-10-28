import { z } from "zod";
import type { ToolDef, ToolContext } from "../registry.js";
import { ToolError } from "../../core/errors.js";

function requireWebhooks(ctx: ToolContext) {
  if (!ctx.webhooks) throw new ToolError("webhooks_unavailable", "Webhook delivery is only available on the remote server.");
  return ctx.webhooks;
}

export const setWebhook: ToolDef = {
  name: "hl_set_webhook",
  tier: "free",
  requiresSubject: true,
  title: "Set alert webhook",
  description:
    "POST this key's fired alerts to an https URL (public addresses only), up to 30 an hour. Each body is signed: " +
    "header x-hypersignal-signature = sha256=HMAC-SHA256(secret, body). The secret is returned only once.",
  inputSchema: { url: z.string().describe("https URL that receives alert POSTs.") },
  outputSchema: { url: z.string(), secret: z.string() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  run: async (args, ctx) => {
    const url = String(args.url);
    const secret = await requireWebhooks(ctx).set(ctx.subject, url);
    return {
      summary: `Webhook set to ${url}. Store the signing secret now; it is not shown again.`,
      data: { url, secret },
    };
  },
};

export const deleteWebhook: ToolDef = {
  name: "hl_delete_webhook",
  tier: "free",
  requiresSubject: true,
  title: "Delete alert webhook",
  description: "Stop POSTing this key's alerts to its webhook (they remain available via hl_poll_alerts).",
  inputSchema: {},
  outputSchema: { deleted: z.boolean() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run: async (_args, ctx) => {
    const deleted = requireWebhooks(ctx).delete(ctx.subject);
    return { summary: deleted ? "Webhook deleted." : "No webhook was set.", data: { deleted } };
  },
};

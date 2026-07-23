/**
 * Programmatic single-tool runner. Lets thin wrappers (e.g. the Apify actor)
 * invoke a tool's logic directly without standing up an MCP transport. Billing
 * is the wrapper's responsibility (e.g. Apify pay-per-event), so authorization
 * is a no-op here.
 */
import { z } from "zod";
import { loadConfig } from "./config.js";
import { Core } from "./server-core.js";
import { ALL_TOOLS } from "./tools/index.js";
import type { ToolContext } from "./tools/registry.js";

let sharedCore: Core | undefined;

export async function runToolOnce(
  name: string,
  args: Record<string, unknown>,
): Promise<{ summary: string; data: unknown }> {
  const config = loadConfig();
  sharedCore ??= new Core(config);
  const def = ALL_TOOLS.find((t) => t.name === name);
  if (!def) throw new Error(`Unknown tool: ${name}. Known: ${ALL_TOOLS.map((t) => t.name).join(", ")}`);

  // The MCP SDK validates+defaults args before handlers run; this direct path
  // must do the same, or tools receive raw args without Zod defaults applied.
  const parsed = z.object(def.inputSchema).parse(args ?? {});

  const ctx: ToolContext = {
    config,
    hl: sharedCore.hl,
    mids: sharedCore.mids,
    snapshots: sharedCore.snapshots,
    store: sharedCore.store,
    signer: sharedCore.signer,
    subject: "apify",
    mode: "http",
    authorize: async () => undefined,
  };
  return def.run(parsed as Record<string, unknown>, ctx);
}

export const APIFY_EXPORTED_TOOLS = ["hl_whale_flow_alerts", "hl_funding_screener", "hl_portfolio_risk"] as const;

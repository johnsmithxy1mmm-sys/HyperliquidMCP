/**
 * Programmatic single-tool runner. Lets thin wrappers (e.g. the Apify actor)
 * invoke a tool's logic directly without standing up an MCP transport. Billing
 * is the wrapper's responsibility (e.g. Apify pay-per-event), so authorization
 * is a no-op here.
 */
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

  const ctx: ToolContext = {
    config,
    hl: sharedCore.hl,
    mids: sharedCore.mids,
    snapshots: sharedCore.snapshots,
    mode: "http",
    authorize: async () => undefined,
  };
  return def.run(args, ctx);
}

export const APIFY_EXPORTED_TOOLS = ["hl_whale_flow_alerts", "hl_funding_screener", "hl_portfolio_risk"] as const;

#!/usr/bin/env node
/**
 * Local stdio entrypoint: FREE + TRADING tiers (hard rule #2: trading is never
 * remote). Premium tools can be included locally & unmetered for the operator's
 * own use via HL_STDIO_INCLUDE_PREMIUM=true. stdout is reserved for JSON-RPC.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { Core, buildServer } from "./server-core.js";
import { TradingService } from "./trading/exchange.js";
import type { Tier } from "./tools/registry.js";
import { log } from "./logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const core = new Core(config);

  const tiers: Tier[] = ["free", "trading"];
  if (process.env.HL_STDIO_INCLUDE_PREMIUM === "true") tiers.push("premium");

  // Trading service always available locally so dry-run previews work without a key.
  const trading = new TradingService(config, core.hl);

  const server = buildServer(core, { tiers, mode: "stdio", trading });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("hypersignal-mcp stdio ready", {
    network: config.network,
    tiers,
    tradingEnabled: config.tradingEnabled,
    builder: config.builder.address ? "configured" : "none",
  });
}

main().catch((err) => {
  log.error("fatal", { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

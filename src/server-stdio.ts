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
import { ExecutionRunner } from "./execution/runner.js";
import { AlertEngine } from "./alerts/engine.js";
import { CohortRefresher } from "./hl/cohortRefresh.js";
import { ScoreSampler } from "./smartmoney/scoreSampler.js";
import type { Tier, ToolContext } from "./tools/registry.js";
import { log } from "./logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const core = new Core(config);

  const tiers: Tier[] = ["free", "trading"];
  if (process.env.HL_STDIO_INCLUDE_PREMIUM === "true") tiers.push("premium");

  // Trading service always available locally so dry-run previews work without a key.
  const trading = new TradingService(config, core.hl);
  const execution = new ExecutionRunner(trading);

  const server = buildServer(core, { tiers, mode: "stdio", subject: "local", trading, execution });

  // Keeps the whale cohort current (no-op unless HL_LEADERBOARD_URL is set).
  new CohortRefresher(config, core.store.cohort).start();

  // Standing-alert engine (evaluates local alerts + builds the track record).
  const cohortCtx = { config, hl: core.hl, store: core.store } as unknown as ToolContext;
  new AlertEngine(core.hl, core.store, core.signer, cohortCtx).start();

  // Daily score sample for the local calibration record. The first pass is
  // minutes out and the timers are unref'd, so a short stdio session never
  // triggers it; set HL_SCORE_SAMPLE_ENABLED=false to opt out entirely.
  new ScoreSampler(cohortCtx).start();

  // A live TWAP holds the process open until it completes. On shutdown the
  // already-submitted child orders are real positions, so report what was left
  // unfilled instead of exiting silently — the plan is in-memory and will not
  // survive the restart.
  const onShutdown = (signal: string): void => {
    const abandoned = execution.cancelAllPending();
    for (const p of abandoned) {
      log.warn("execution plan abandoned on shutdown", {
        signal,
        plan: p.id,
        coin: p.coin,
        side: p.side,
        submittedChildren: p.submitted,
        unfilledChildren: p.unfilled,
      });
    }
    process.exit(0);
  };
  process.once("SIGINT", () => onShutdown("SIGINT"));
  process.once("SIGTERM", () => onShutdown("SIGTERM"));

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

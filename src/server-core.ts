/**
 * Shared core wiring. Builds an McpServer for a given tier set + billing gate.
 * Both entrypoints (stdio, http) reuse the same singletons.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { HyperliquidClient } from "./core/hlClient.js";
import { MidsFeed } from "./core/ws.js";
import type { SnapshotStore } from "./core/snapshots.js";
import { Warehouse } from "./store/warehouse.js";
import { SignalSigner } from "./signals/signer.js";
import { registerTools } from "./tools/index.js";
import type { ToolContext, Tier } from "./tools/registry.js";
import type { TradingService } from "./trading/exchange.js";
import type { ExecutionRunner } from "./execution/runner.js";

export const SERVER_NAME = "hypersignal-mcp";
export const SERVER_VERSION = "1.0.1";

/** Long-lived singletons shared across requests. */
export class Core {
  readonly hl: HyperliquidClient;
  readonly mids: MidsFeed;
  readonly store: Warehouse;
  readonly snapshots: SnapshotStore;
  readonly signer: SignalSigner;

  constructor(readonly config: Config) {
    this.hl = new HyperliquidClient(config);
    this.mids = new MidsFeed(config, this.hl);
    this.store = new Warehouse(config);
    this.snapshots = this.store.snapshots; // persistent (SQLite-backed)
    this.signer = new SignalSigner(process.env.SIGNAL_SIGNING_KEY?.trim() || undefined);
  }
}

export interface BuildServerOptions {
  tiers: Tier[];
  mode: "stdio" | "http";
  /** Owner identity for per-subject resources (alerts). stdio => "local". */
  subject?: string;
  authorize?: (toolName: string) => Promise<void>;
  trading?: TradingService;
  execution?: ExecutionRunner;
}

const NO_AUTH = async (): Promise<void> => {
  /* unmetered (stdio / local) */
};

export function buildServer(core: Core, opts: BuildServerOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "HyperSignal MCP — Hyperliquid analytics & signals. Free tools give market data; premium tools give " +
        "whale/liquidation/funding/risk analytics, standing alerts, and a verifiable signal track record (metered " +
        "in remote mode). Call hl_get_markets to discover coins. Analytics only, not investment advice.",
    },
  );

  const ctx: ToolContext = {
    config: core.config,
    hl: core.hl,
    mids: core.mids,
    snapshots: core.snapshots,
    store: core.store,
    signer: core.signer,
    subject: opts.subject ?? "local",
    mode: opts.mode,
    authorize: opts.authorize ?? NO_AUTH,
    trading: opts.trading,
    execution: opts.execution,
  };

  registerTools(server, ctx, opts.tiers);
  return server;
}

/**
 * Declarative tool definition + registration onto an McpServer.
 *
 * Each tool declares its tier, Zod input/output shapes, annotations, and a thin
 * `run` that returns `{ summary, data }`. The registrar wires validation,
 * premium billing gates, structuredContent, and actionable error conversion so
 * individual tool files stay focused on logic.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";
import type { Config } from "../config.js";
import type { HyperliquidClient } from "../core/hlClient.js";
import type { MidsFeed } from "../core/ws.js";
import type { SnapshotStore } from "../core/snapshots.js";
import type { Warehouse } from "../store/warehouse.js";
import type { SignalSigner } from "../signals/signer.js";
import type { TradingService } from "../trading/exchange.js";
import type { ExecutionRunner } from "../execution/runner.js";
import { ToolError } from "../core/errors.js";
import { log } from "../logger.js";

export type Tier = "free" | "premium" | "trading";

export interface ToolContext {
  config: Config;
  hl: HyperliquidClient;
  mids: MidsFeed;
  snapshots: SnapshotStore;
  /** Persistent SQLite-backed stores (snapshots, alerts, signals). */
  store: Warehouse;
  /** Signs emitted signals for a verifiable track record. */
  signer: SignalSigner;
  /** Owner identity for per-subject resources (alerts). "local" in stdio. */
  subject: string;
  mode: "stdio" | "http";
  /** Premium billing gate. Free/trading tools ignore it; premium tools await it first. */
  authorize: (toolName: string) => Promise<void>;
  /** Present only in stdio mode when trading is enabled. */
  trading?: TradingService;
  /** Background execution runner (stdio trading only). */
  execution?: ExecutionRunner;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  title?: string;
}

export interface ToolDef {
  name: string;
  tier: Tier;
  title: string;
  description: string;
  inputSchema: ZodRawShape;
  outputSchema?: ZodRawShape;
  annotations: ToolAnnotations;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<{ summary: string; data: unknown }>;
}

/** Register a single tool onto the server, wrapping billing + error handling. */
export function registerTool(server: McpServer, def: ToolDef, ctx: ToolContext): void {
  server.registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.inputSchema,
      ...(def.outputSchema ? { outputSchema: def.outputSchema } : {}),
      annotations: { title: def.title, ...def.annotations },
    },
    // The SDK validates args against inputSchema before calling us.
    async (args: Record<string, unknown>) => {
      try {
        if (def.tier === "premium") await ctx.authorize(def.name);
        const { summary, data } = await def.run(args ?? {}, ctx);
        return {
          content: [{ type: "text" as const, text: summary }],
          structuredContent: data as Record<string, unknown>,
        };
      } catch (err) {
        return toErrorResult(err, def.name);
      }
    },
  );
}

function toErrorResult(err: unknown, toolName: string) {
  if (err instanceof ToolError) {
    const payload = { error: err.code, message: err.message, ...(err.details ?? {}) };
    log.warn("tool error", { tool: toolName, code: err.code });
    return {
      content: [{ type: "text" as const, text: `${err.message}` }],
      structuredContent: payload,
      isError: true,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  log.error("tool unexpected error", { tool: toolName, message });
  return {
    content: [{ type: "text" as const, text: `Internal error in ${toolName}: ${message}` }],
    structuredContent: { error: "internal_error", message },
    isError: true,
  };
}

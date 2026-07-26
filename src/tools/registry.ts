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

/**
 * The slice of BillingService tools may use. Declared structurally so the tool
 * layer does not depend on the billing module (which owns the SQLite handle).
 */
export interface BillingLike {
  issueFreeKey(fingerprint: string): { rawKey: string; monthlyPremiumCalls: number; reissued: boolean };
  freeKeyUsage(fingerprint: string): number | null;
}

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
  /**
   * Client IP, http mode only. Used solely to rate-bound self-serve free keys;
   * it is hashed before storage and never logged raw. Requires TRUST_PROXY
   * behind a reverse proxy, otherwise every client shares the proxy's address.
   */
  clientIp?: string;
  /** Billing service, http mode only (self-serve key issuance). */
  billing?: BillingLike;
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
  /**
   * Tool stores per-user state and needs a stable identity (API key). Checked
   * BEFORE the billing gate so an x402 pay-per-call user is never charged for
   * a call that would then be refused for lack of identity.
   */
  requiresSubject?: boolean;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<{ summary: string; data: unknown }>;
}

/**
 * Prefix premium descriptions with their access requirement.
 *
 * An agent picks a tool by reading its description. Without this, 16 of 25
 * tools look free, the agent picks one, and its first real call is a refusal —
 * which is where new users were being lost. Applied centrally so a tool cannot
 * be added later and silently miss the label.
 *
 * stdio never meters, so the label would be a lie there and is omitted.
 */
function describeFor(def: ToolDef, ctx: ToolContext): string {
  if (def.tier !== "premium" || ctx.mode !== "http") return def.description;
  return (
    "[PREMIUM — needs an API key: call hl_request_free_key first for a free key, " +
    "or pay per call via x402] " +
    def.description
  );
}

/** Register a single tool onto the server, wrapping billing + error handling. */
export function registerTool(server: McpServer, def: ToolDef, ctx: ToolContext): void {
  server.registerTool(
    def.name,
    {
      title: def.title,
      description: describeFor(def, ctx),
      inputSchema: def.inputSchema,
      ...(def.outputSchema ? { outputSchema: def.outputSchema } : {}),
      annotations: { title: def.title, ...def.annotations },
    },
    // The SDK validates args against inputSchema before calling us.
    async (args: Record<string, unknown>) => {
      try {
        if (def.requiresSubject && (!ctx.subject || ctx.subject === "anon")) {
          throw new ToolError(
            "auth_required",
            `Tool "${def.name}" stores per-user state and requires an API key (X-API-Key header). ` +
              `Pay-per-call x402 has no stable identity, so it cannot own alerts.`,
          );
        }
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

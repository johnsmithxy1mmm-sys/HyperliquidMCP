#!/usr/bin/env node
/**
 * Remote HTTP entrypoint: FREE + PREMIUM tiers only. Trading tools are NEVER
 * exposed here (hard rule #2). Streamable HTTP in stateless JSON mode — a new
 * server+transport is created per request (no sessions, no SSE streaming).
 * Premium calls are metered by the billing layer (API key or x402).
 *
 * Hardening: per-IP rate limit (protects our Hyperliquid weight budget from
 * anonymous hammering), JSON-RPC parse errors instead of HTML, opt-in CORS,
 * TRUST_PROXY for correct client IPs behind Fly/Nginx, no x-powered-by.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { Core, buildServer, SERVER_NAME, SERVER_VERSION } from "./server-core.js";
import { BillingService } from "./billing/service.js";
import { log } from "./logger.js";

function envFlag(name: string): boolean {
  return ["1", "true", "yes", "on"].includes((process.env[name] ?? "").trim().toLowerCase());
}

/** Minimal in-memory per-IP limiter: sliding one-minute windows, capped map. */
function ipLimiter(maxPerMinute: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const MAX_ENTRIES = 10_000;
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const ip = req.ip ?? "unknown";
    let entry = hits.get(ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + 60_000 };
      hits.set(ip, entry);
    }
    entry.count += 1;
    // Bound memory even under spoofed-IP floods.
    while (hits.size > MAX_ENTRIES) {
      const oldest = hits.keys().next().value;
      if (oldest === undefined) break;
      hits.delete(oldest);
    }
    if (entry.count > maxPerMinute) {
      res
        .status(429)
        .json({ jsonrpc: "2.0", error: { code: -32000, message: "Rate limit exceeded; retry in under a minute." }, id: null });
      return;
    }
    next();
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const core = new Core(config);
  const billing = new BillingService(config);

  const app = express();
  app.disable("x-powered-by");
  // Behind Fly/Nginx/Caddy the client IP arrives in X-Forwarded-For; only
  // trust it when explicitly deployed behind a proxy.
  if (envFlag("TRUST_PROXY")) app.set("trust proxy", true);

  app.use(express.json({ limit: "2mb" }));

  // Opt-in CORS for browser-based MCP clients.
  const corsOrigin = process.env.MCP_CORS_ORIGIN?.trim();
  if (corsOrigin) {
    app.use(config.httpPath, (req: Request, res: Response, next: NextFunction) => {
      res.setHeader("Access-Control-Allow-Origin", corsOrigin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "content-type, authorization, x-api-key, x-payment, mcp-protocol-version, mcp-session-id",
      );
      if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
      }
      next();
    });
  }

  const maxPerMinute = Math.max(1, Number(process.env.HTTP_RATE_LIMIT_PER_MIN ?? 120) || 120);
  app.use(config.httpPath, ipLimiter(maxPerMinute));

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true, server: SERVER_NAME, version: SERVER_VERSION, network: config.network });
  });

  app.post(config.httpPath, async (req: Request, res: Response) => {
    const apiKey = headerStr(req, "x-api-key") ?? bearer(req);
    const xPayment = headerStr(req, "x-payment");
    const authorize = billing.authorizerFor({ apiKey, xPayment });

    // Stateless: fresh server + transport per request.
    const server = buildServer(core, { tiers: ["free", "premium"], mode: "http", authorize });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error("http request failed", { err: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  // Stateless mode: no server-initiated streams or session teardown.
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)." }, id: null });
  };
  app.get(config.httpPath, methodNotAllowed);
  app.delete(config.httpPath, methodNotAllowed);

  // Malformed JSON bodies -> JSON-RPC parse error, not an HTML error page.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(400).json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  });

  app.listen(config.httpPort, () => {
    log.info("hypersignal-mcp http ready", {
      port: config.httpPort,
      path: config.httpPath,
      network: config.network,
      x402: config.x402.enabled,
      rateLimitPerMin: maxPerMinute,
      trustProxy: envFlag("TRUST_PROXY"),
    });
  });
}

function headerStr(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function bearer(req: Request): string | undefined {
  const auth = headerStr(req, "authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return undefined;
}

main().catch((err) => {
  log.error("fatal", { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

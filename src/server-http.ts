#!/usr/bin/env node
/**
 * Remote HTTP entrypoint: FREE + PREMIUM tiers only. Trading tools are NEVER
 * exposed here (hard rule #2). Streamable HTTP in stateless JSON mode — a new
 * server+transport is created per request (no sessions, no SSE streaming).
 * Premium calls are metered by the billing layer (API key or x402).
 */
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { Core, buildServer, SERVER_NAME, SERVER_VERSION } from "./server-core.js";
import { BillingService } from "./billing/service.js";
import { log } from "./logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const core = new Core(config);
  const billing = new BillingService(config);

  const app = express();
  app.use(express.json({ limit: "2mb" }));

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

  app.listen(config.httpPort, () => {
    log.info("hypersignal-mcp http ready", {
      port: config.httpPort,
      path: config.httpPath,
      network: config.network,
      x402: config.x402.enabled,
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

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
import { AlertEngine } from "./alerts/engine.js";
import { CohortRefresher } from "./hl/cohortRefresh.js";
import { ScoreSampler } from "./smartmoney/scoreSampler.js";
import type { ToolContext } from "./tools/registry.js";
import { log } from "./logger.js";
import { TRUST_PROXY_SETTING } from "./core/clientIp.js";
import { adminStats } from "./tools/free/adminStats.js";
import { ensureHouseAlerts } from "./alerts/house.js";
import { buildPublicProof, renderProofHtml } from "./public/proof.js";
import { TelegramBot } from "./telegram/bot.js";
import { TelegramStore } from "./telegram/store.js";
import { getDb } from "./billing/db.js";
import { ToolError } from "./core/errors.js";

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

  // Keeps the whale cohort current without manual curation (no-op unless
  // HL_LEADERBOARD_URL is set).
  new CohortRefresher(config, core.store.cohort).start();

  // Standing-alert engine: evaluates alerts server-side and builds the track record.
  const cohortCtx = { config, hl: core.hl, store: core.store } as unknown as ToolContext;
  // Telegram delivery is optional: without a token the server behaves as before.
  const telegram = config.telegram.botToken
    ? new TelegramBot(config.telegram.botToken, new TelegramStore(getDb(config.dbPath)), {
        channelId: config.telegram.channelId,
        publicBaseUrl: config.telegram.publicBaseUrl,
      })
    : undefined;
  telegram?.start();

  const engine = new AlertEngine(core.hl, core.store, core.signer, cohortCtx, telegram ? (subject, message) => void telegram.notify(subject, message) : undefined);
  engine.start();

  // The server's own alerts keep the published track record growing without customers.
  const refreshHouseAlerts = () =>
    ensureHouseAlerts(core.hl, core.store.alerts).catch((err) =>
      log.warn("house alerts refresh failed", { err: String(err) }),
    );
  void refreshHouseAlerts();
  setInterval(() => void refreshHouseAlerts(), 24 * 3_600_000).unref();

  // Samples the server-selected cohort daily so the score calibration keeps
  // accumulating evidence instead of waiting on customer traffic.
  new ScoreSampler(cohortCtx).start();

  const app = express();
  app.disable("x-powered-by");
  // Behind Fly/Nginx/Caddy the client IP arrives in X-Forwarded-For; only
  // trust it when explicitly deployed behind a proxy.
  if (envFlag("TRUST_PROXY")) app.set("trust proxy", TRUST_PROXY_SETTING);

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

  // Behind a proxy without TRUST_PROXY, every client presents the proxy's
  // address. Self-serve free keys are bounded per client IP and re-issuing
  // revokes the previous key for that IP — so a shared address means each new
  // requester silently revokes the last one's key. Loud, because the symptom
  // (keys mysteriously stop working) points nowhere near the cause.
  if (!envFlag("TRUST_PROXY")) {
    log.warn(
      "TRUST_PROXY is off: if this server sits behind Fly/Nginx/Caddy, all clients share one IP, " +
        "so self-serve free keys will revoke each other. Set TRUST_PROXY=true when deployed behind a proxy.",
    );
  }

  const maxPerMinute = Math.max(1, Number(process.env.HTTP_RATE_LIMIT_PER_MIN ?? 120) || 120);
  app.use(config.httpPath, ipLimiter(maxPerMinute));

  // Always 200 (a Hyperliquid hiccup must not make Fly restart the machine);
  // `engine` shows background work that otherwise fails silently.
  // Public, key-free proof: house-signal track record, calibration, signing key.
  app.get("/track-record.json", ipLimiter(60), (_req: Request, res: Response) => {
    res.json(buildPublicProof(core.store, core.signer, SERVER_VERSION));
  });
  app.get("/track-record", ipLimiter(60), (_req: Request, res: Response) => {
    res.type("html").send(renderProofHtml(buildPublicProof(core.store, core.signer, SERVER_VERSION)));
  });

  // Operator report (formerly the hl_admin_stats tool): the secret travels in a
  // header, not through an agent's context. Hidden entirely when no secret is set.
  app.get("/admin/stats", ipLimiter(10), async (req: Request, res: Response) => {
    if (!process.env.HYPERSIGNAL_ADMIN_SECRET) {
      res.status(404).end();
      return;
    }
    try {
      const period = typeof req.query.period === "string" ? req.query.period : undefined;
      const { data } = await adminStats.run({ adminSecret: bearer(req) ?? "", period }, cohortCtx);
      res.json(data);
    } catch (err) {
      const unauthorized = err instanceof ToolError && err.code === "unauthorized";
      if (!unauthorized) log.error("admin stats failed", { err: String(err) });
      res.status(unauthorized ? 401 : 500).json({ error: unauthorized ? "unauthorized" : "internal_error" });
    }
  });

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      server: SERVER_NAME,
      version: SERVER_VERSION,
      network: config.network,
      // "ephemeral" means SIGNAL_SIGNING_KEY is unset: signatures stop verifying after a restart.
      signingKey: core.signer.ephemeral ? "ephemeral" : "persistent",
      engine: {
        ...engine.status(),
        scores: { ...core.store.scores.counts(), abandoned: core.store.scores.abandoned() },
      },
    });
  });

  // Friendly landing on the root so platform health checks / browsers get a
  // 200 with orientation instead of a bare 404 (the MCP endpoint is POST /mcp).
  app.get("/", (_req: Request, res: Response) => {
    res.json({
      server: SERVER_NAME,
      version: SERVER_VERSION,
      status: "ok",
      description: "Monetized MCP server for Hyperliquid analytics & signals.",
      endpoints: { health: "GET /healthz", mcp: `POST ${config.httpPath}`, trackRecord: "GET /track-record" },
      hint: "Connect an MCP client to the /mcp endpoint (Streamable HTTP). Free tools need no key; premium tools require X-API-Key or x402.",
    });
  });

  app.post(config.httpPath, async (req: Request, res: Response) => {
    const apiKey = headerStr(req, "x-api-key") ?? bearer(req);
    const xPayment = headerStr(req, "x-payment");
    const authorize = billing.authorizerFor({ apiKey, xPayment });
    const subject = billing.subjectFor({ apiKey, xPayment });

    // Stateless: fresh server + transport per request.
    const server = buildServer(core, {
      telegram,
      tiers: ["free", "premium"],
      mode: "http",
      subject,
      authorize,
      clientIp: req.ip,
      billing,
    });
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

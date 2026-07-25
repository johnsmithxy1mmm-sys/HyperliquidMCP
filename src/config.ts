/**
 * Central configuration. ALL secrets and tunables come from environment variables
 * (see .env.example). Never hardcode secrets. `loadConfig()` is pure and cached.
 */

export type Network = "mainnet" | "testnet";

export interface BuilderConfig {
  /** Builder address that receives builder-code fees on trading-tier orders. */
  address: string | undefined;
  /** Builder fee in tenths of a basis point (f=10 => 1 bp). Hyperliquid perp cap is 100 (10 bp). */
  feeTenthsBps: number;
}

export interface Config {
  network: Network;
  infoBaseUrl: string;
  exchangeBaseUrl: string;
  wsUrl: string;

  /** Per-request HTTP timeout for Hyperliquid calls (ms). */
  requestTimeoutMs: number;
  /** Max retries for transient failures (per hard rule #4: 3, exponential). */
  maxRetries: number;
  /** Aggregated request-weight budget per minute (rate limiter). */
  rateWeightPerMin: number;

  /** Enable the live WebSocket mids feed (falls back to REST if disabled/unavailable). */
  wsEnabled: boolean;

  /** SQLite file path for billing keys + counters. */
  dbPath: string;

  /** HTTP server. */
  httpPort: number;
  httpPath: string;

  builder: BuilderConfig;

  /** Trading tier master switch. Even when true, remote HTTP mode NEVER exposes trading tools. */
  tradingEnabled: boolean;
  /** Agent-wallet private key — ONLY from env, ONLY used in local stdio mode. */
  agentPrivateKey: string | undefined;

  /** Whale-cohort default address list (comma-separated env), used when a tool omits `cohort`. */
  whaleAddresses: string[];
  /** Optional best-effort public leaderboard endpoint (unofficial frontend data). */
  leaderboardUrl: string | undefined;

  /** x402 payment config. */
  x402: {
    enabled: boolean;
    payTo: string | undefined;
    network: string;
    asset: string;
    facilitatorUrl: string | undefined;
    pricePerCallUsdc: number;
  };

  /** Polymarket cross-market analytics. */
  polymarket: {
    gammaUrl: string;
  };
}

const MAINNET = "https://api.hyperliquid.xyz";
const TESTNET = "https://api.hyperliquid-testnet.xyz";

function envBool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

function envNum(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/**
 * envNum with sanity bounds. A typo'd HL_REQUEST_TIMEOUT_MS=0 would abort every
 * request instantly and a negative HL_MAX_RETRIES would skip the request loop
 * entirely — misconfiguration should degrade to a working default, not take the
 * server down in a way that looks like a Hyperliquid outage.
 */
function envNumClamped(name: string, def: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, envNum(name, def)));
}

function envList(name: string): string[] {
  const v = process.env[name];
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) return cached;

  const network: Network = (process.env.HL_NETWORK as Network) === "testnet" ? "testnet" : "mainnet";
  const base = network === "testnet" ? TESTNET : MAINNET;
  const wsUrl =
    process.env.HL_WS_URL ??
    (network === "testnet" ? "wss://api.hyperliquid-testnet.xyz/ws" : "wss://api.hyperliquid.xyz/ws");

  const feeTenthsBps = clampFee(envNum("HL_BUILDER_FEE_TENTHS_BPS", 5));

  cached = {
    network,
    infoBaseUrl: `${base}/info`,
    exchangeBaseUrl: `${base}/exchange`,
    wsUrl,

    requestTimeoutMs: envNumClamped("HL_REQUEST_TIMEOUT_MS", 10_000, 500, 120_000),
    maxRetries: envNumClamped("HL_MAX_RETRIES", 3, 0, 10),
    rateWeightPerMin: envNumClamped("HL_RATE_WEIGHT_PER_MIN", 1_100, 10, 100_000),

    wsEnabled: envBool("HL_WS_ENABLED", true),

    dbPath: process.env.HYPERSIGNAL_DB_PATH ?? "./data/hypersignal.db",

    httpPort: envNumClamped("PORT", 8080, 1, 65_535),
    httpPath: process.env.MCP_HTTP_PATH ?? "/mcp",

    builder: {
      address: process.env.HL_BUILDER_ADDRESS?.trim() || undefined,
      feeTenthsBps,
    },

    tradingEnabled: envBool("HL_ENABLE_TRADING", false),
    agentPrivateKey: process.env.HL_AGENT_PRIVATE_KEY?.trim() || undefined,

    whaleAddresses: envList("HL_WHALE_ADDRESSES"),
    leaderboardUrl: process.env.HL_LEADERBOARD_URL?.trim() || undefined,

    x402: {
      enabled: envBool("X402_ENABLED", false),
      payTo: process.env.X402_PAY_TO?.trim() || undefined,
      network: process.env.X402_NETWORK ?? "base",
      asset: process.env.X402_ASSET ?? "USDC",
      facilitatorUrl: process.env.X402_FACILITATOR_URL?.trim() || undefined,
      pricePerCallUsdc: envNum("X402_PRICE_PER_CALL_USDC", 0.01),
    },

    polymarket: {
      gammaUrl: process.env.POLYMARKET_GAMMA_URL?.trim() || "https://gamma-api.polymarket.com",
    },
  };
  return cached;
}

/** Clamp builder fee to the Hyperliquid perp cap (10 bp = 100 tenths-of-bp) and non-negative. */
export function clampFee(f: number): number {
  if (!Number.isFinite(f) || f < 0) return 0;
  return Math.min(Math.floor(f), 100);
}

/** For tests: reset the memoized config. */
export function _resetConfigForTests(): void {
  cached = undefined;
}

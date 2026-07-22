/**
 * Minimal structured logger. Writes to stderr so it never corrupts the stdio
 * JSON-RPC stream (stdout is reserved for the MCP transport in stdio mode).
 *
 * Secret hygiene (hard rule #1): `redact()` masks anything that looks like a
 * private key / bearer token before it can reach the logs.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;

const SECRET_RE = /\b(0x)?[0-9a-fA-F]{64}\b/g; // 32-byte hex (private keys, hashes)

export function redact(value: unknown): unknown {
  if (typeof value === "string") return value.replace(SECRET_RE, "«redacted»");
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/key|secret|token|password|mnemonic|private/i.test(k)) out[k] = "«redacted»";
      else out[k] = redact(v);
    }
    return out;
  }
  return value;
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const line = {
    t: new Date().toISOString(),
    level,
    msg,
    ...(meta ? (redact(meta) as Record<string, unknown>) : {}),
  };
  process.stderr.write(JSON.stringify(line) + "\n");
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};

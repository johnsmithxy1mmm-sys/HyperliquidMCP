/**
 * Low-level JSON POST with timeout + exponential backoff retries.
 * Hard rule #4: every external call has a timeout and 3 exponential retries.
 */
import { UpstreamError } from "./errors.js";
import { log } from "../logger.js";

export interface PostOptions {
  timeoutMs: number;
  maxRetries: number;
  /** Extra headers (e.g. for signed exchange calls). */
  headers?: Record<string, string>;
}

const RETRIABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function postJson<T>(url: string, body: unknown, opts: PostOptions): Promise<T> {
  const payload = JSON.stringify(body);
  let lastErr: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
        body: payload,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (RETRIABLE_STATUS.has(res.status) && attempt < opts.maxRetries) {
          const backoff = backoffMs(attempt, res.status === 429);
          log.warn("http retry", { url, status: res.status, attempt, backoff });
          await sleep(backoff);
          continue;
        }
        throw new UpstreamError(`Hyperliquid returned HTTP ${res.status}`, {
          status: res.status,
          bodyPreview: text.slice(0, 300),
        });
      }

      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) return (await res.json()) as T;
      const raw = await res.text();
      try {
        return JSON.parse(raw) as T;
      } catch {
        throw new UpstreamError("Expected JSON from Hyperliquid but got non-JSON body", {
          bodyPreview: raw.slice(0, 300),
        });
      }
    } catch (err) {
      lastErr = err;
      const aborted = err instanceof Error && err.name === "AbortError";
      const isUpstream = err instanceof UpstreamError;
      // Non-retriable UpstreamError (already exhausted or 4xx) bubbles up.
      if (isUpstream && !aborted) throw err;
      if (attempt < opts.maxRetries) {
        const backoff = backoffMs(attempt, false);
        log.warn("http network retry", { url, attempt, backoff, aborted });
        await sleep(backoff);
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw new UpstreamError("Hyperliquid request failed after retries", {
    cause: lastErr instanceof Error ? lastErr.message : String(lastErr),
  });
}

function backoffMs(attempt: number, rateLimited: boolean): number {
  const base = rateLimited ? 1_000 : 400;
  const exp = base * 2 ** attempt;
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(exp + jitter, 16_000);
}

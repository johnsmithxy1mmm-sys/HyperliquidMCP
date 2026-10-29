/**
 * x402 (HTTP 402 Payment Required) support for pay-per-call premium access.
 * Structured to the x402 spec: a `402` carries `accepts[]` payment requirements;
 * the client retries with an `X-PAYMENT` header we verify (via a configured
 * facilitator) and record for replay protection.
 *
 * Fail-closed: without a facilitator we cannot verify settlement, so payment is
 * treated as unverified (access denied) rather than fabricating success.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { consumePaymentId, releasePaymentId } from "./db.js";
import { log } from "../logger.js";
import { PaymentRequiredError } from "../core/errors.js";

/** Base mainnet USDC (6 decimals). Override via X402_ASSET_ADDRESS if needed. */
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** Circle's USDC on Base Sepolia: the token for testing the whole payment flow. */
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

export interface PaymentRequirements {
  x402Version: number;
  accepts: Array<{
    scheme: string;
    network: string;
    maxAmountRequired: string;
    resource: string;
    description: string;
    mimeType: string;
    payTo: string;
    maxTimeoutSeconds: number;
    asset: string;
    extra: Record<string, unknown>;
  }>;
}

export function buildPaymentRequirements(config: Config, toolName: string): PaymentRequirements {
  const priceAtomic = Math.max(0, Math.round(config.x402.pricePerCallUsdc * 1_000_000)).toString();
  const asset = process.env.X402_ASSET_ADDRESS ?? (config.x402.network === "base-sepolia" ? BASE_SEPOLIA_USDC : BASE_USDC);
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: config.x402.network,
        maxAmountRequired: priceAtomic,
        resource: `mcp://hypersignal/${toolName}`,
        description: `HyperSignal premium call: ${toolName}`,
        mimeType: "application/json",
        payTo: config.x402.payTo ?? "0x0000000000000000000000000000000000000000",
        maxTimeoutSeconds: 60,
        asset,
        // The EIP-712 domain of the token: standard x402 clients sign
        // transferWithAuthorization against it, so a wrong or missing name or
        // version makes every payment fail verification.
        extra: { name: eip712Name(config.x402.network), version: process.env.X402_EIP712_VERSION ?? "2", decimals: 6 },
      },
    ],
  };
}

/** USDC's EIP-712 domain name: "USD Coin" on Base mainnet, "USDC" on Base Sepolia. */
function eip712Name(network: string): string {
  return process.env.X402_EIP712_NAME ?? (network === "base-sepolia" ? "USDC" : "USD Coin");
}

/**
 * A verified, reserved payment that has not been settled yet. Settled only once
 * the tool has delivered, so a call that fails costs the payer nothing.
 */
export interface X402Charge {
  /** Settle on-chain. Throws PaymentRequiredError when the payment did not settle. */
  settle(): Promise<void>;
  /** Free the reservation after a failed call, unless settlement may already have happened. */
  release(): void;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  charge?: X402Charge;
}

/**
 * Verify an X-PAYMENT header. Decodes the base64 payload, asks the facilitator
 * to verify it, and reserves the payment id to block replays. Settlement is
 * left to the returned charge.
 */
export async function verifyPayment(
  config: Config,
  db: Database.Database,
  xPaymentHeader: string | undefined,
  requirements: PaymentRequirements,
): Promise<VerifyResult> {
  if (!xPaymentHeader) return { ok: false, reason: "missing_payment" };

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(xPaymentHeader, "base64").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed_payment_header" };
  }

  if (!config.x402.facilitatorUrl) {
    log.warn("x402 payment received but no facilitator configured; failing closed");
    return { ok: false, reason: "no_facilitator_configured" };
  }

  const auth = authorizationOf(payload);
  // The tool runs between verify and settle; an authorization that expires
  // first can never settle, so the call would run for nothing.
  if (auth?.validBefore !== undefined && Number(auth.validBefore) * 1000 < Date.now() + EXPIRY_MARGIN_MS) {
    return { ok: false, reason: "authorization_expiring" };
  }
  // /verify checks each authorization's balance on its own, so one small
  // wallet could start any number of runs with distinct nonces before one
  // settles. Bound how many may be in flight per payer.
  const payer = typeof auth?.from === "string" ? auth.from.toLowerCase() : undefined;
  if (payer && (pendingByPayer.get(payer) ?? 0) >= MAX_PENDING_PER_PAYER) {
    return { ok: false, reason: "too_many_pending_payments" };
  }

  const base = config.x402.facilitatorUrl.replace(/\/$/, "");
  const body = JSON.stringify({ x402Version: 1, paymentPayload: payload, paymentRequirements: requirements.accepts[0] });

  try {
    const verifyRes = await postWithTimeout(`${base}/verify`, body, VERIFY_TIMEOUT_MS);
    const verifyBody = (verifyRes.body ?? {}) as { isValid?: boolean; invalidReason?: string };
    if (!verifyRes.ok || !verifyBody.isValid) {
      return { ok: false, reason: verifyBody.invalidReason ?? `verify_failed_${verifyRes.status}` };
    }

    // Reserve BEFORE settling. Settling first and checking for a replay
    // afterwards means a caller whose payload we have already seen gets charged
    // again and then refused — taking money for a call we do not serve.
    const reservationId = deriveId(payload);
    if (!consumePaymentId(db, reservationId)) return { ok: false, reason: "payment_replayed" };
    if (payer) pendingByPayer.set(payer, (pendingByPayer.get(payer) ?? 0) + 1);
    return { ok: true, charge: reservedCharge(db, base, body, reservationId, payer, requirements) };
  } catch (err) {
    log.warn("x402 verify error", { err: String(err) });
    return { ok: false, reason: "facilitator_unreachable" };
  }
}

/** An authorization must outlive the call by this much to be worth running. */
const EXPIRY_MARGIN_MS = 15_000;
/** Verified-but-unfinished payments one payer may hold at once. */
const MAX_PENDING_PER_PAYER = 3;
const VERIFY_TIMEOUT_MS = 10_000;
/** Settlement waits for the chain; Base can take longer than a verify. */
const SETTLE_TIMEOUT_MS = 30_000;
// shortcut: per-process count; a multi-instance deployment would need it in the shared DB.
const pendingByPayer = new Map<string, number>();

function reservedCharge(
  db: Database.Database,
  base: string,
  body: string,
  reservationId: string,
  payer: string | undefined,
  requirements: PaymentRequirements,
): X402Charge {
  let state: "reserved" | "settled" | "unknown" | "released" = "reserved";
  const finish = (next: typeof state): void => {
    state = next;
    if (!payer) return;
    const left = (pendingByPayer.get(payer) ?? 1) - 1;
    if (left > 0) pendingByPayer.set(payer, left);
    else pendingByPayer.delete(payer);
  };
  const release = (): void => {
    if (state !== "reserved") return;
    releasePaymentId(db, reservationId);
    finish("released");
  };
  const unknownOutcome = (detail: Record<string, unknown>): never => {
    // The transfer may already be on-chain. Keep the reservation: releasing it
    // or re-running settle could charge twice.
    finish("unknown");
    log.warn("x402 settle outcome unknown; reservation kept", detail);
    throw new PaymentRequiredError(
      "Payment settlement could not be confirmed and may still complete. Do not pay again for this call.",
      { reason: "settlement_unconfirmed" },
    );
  };
  const settle = async (): Promise<void> => {
    let settleRes: { ok: boolean; status: number; body: unknown };
    try {
      settleRes = await postWithTimeout(`${base}/settle`, body, SETTLE_TIMEOUT_MS);
    } catch (err) {
      return unknownOutcome({ err: String(err) });
    }
    const settleBody = settleRes.body as { success?: boolean; transaction?: string } | undefined;
    if (settleBody?.success === true) {
      finish("settled");
      log.info("x402 payment settled", { transaction: settleBody.transaction });
      return;
    }
    // Only an explicit, parsed refusal with no transaction means nothing moved;
    // a gateway 5xx/429 or an unreadable body says nothing about the chain.
    if (settleBody?.success === false && !settleBody.transaction) {
      release();
      throw new PaymentRequiredError("Payment did not settle; it was not charged. Pay again to retry.", {
        reason: "settlement_failed",
        x402: requirements,
      });
    }
    return unknownOutcome({ status: settleRes.status });
  };
  return { settle, release };
}

function authorizationOf(
  payload: Record<string, unknown>,
): { from?: unknown; nonce?: unknown; validBefore?: unknown } | undefined {
  return (payload.payload as { authorization?: { from?: unknown; nonce?: unknown; validBefore?: unknown } } | undefined)
    ?.authorization;
}

/**
 * Replay key for a payment: the EIP-3009 authorization's (from, nonce), which
 * the token contract itself treats as single-use. Hashing the serialized JSON
 * let one payment be re-encoded (key order, extra fields) into many distinct
 * ids, each passing /verify before the first settle landed.
 */
function deriveId(payload: Record<string, unknown>): string {
  const auth = authorizationOf(payload);
  if (typeof auth?.from === "string" && typeof auth?.nonce === "string") {
    return `eip3009:${auth.from.toLowerCase()}:${auth.nonce.toLowerCase()}`;
  }
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * Facilitator calls must never hang a request. The timeout covers the body
 * too: clearing it once headers arrive let a stalled body hang forever.
 * `body` is undefined when the response is not JSON.
 */
async function postWithTimeout(
  url: string,
  body: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return { ok: res.ok, status: res.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

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
  const asset = process.env.X402_ASSET_ADDRESS ?? BASE_USDC;
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

  const base = config.x402.facilitatorUrl.replace(/\/$/, "");
  const body = JSON.stringify({ x402Version: 1, paymentPayload: payload, paymentRequirements: requirements.accepts[0] });

  try {
    const verifyRes = await postWithTimeout(`${base}/verify`, body);
    const verifyBody = (await verifyRes.json().catch(() => ({}))) as { isValid?: boolean; invalidReason?: string };
    if (!verifyRes.ok || !verifyBody.isValid) {
      return { ok: false, reason: verifyBody.invalidReason ?? `verify_failed_${verifyRes.status}` };
    }

    // Reserve BEFORE settling. Settling first and checking for a replay
    // afterwards means a caller whose payload we have already seen gets charged
    // again and then refused — taking money for a call we do not serve.
    const reservationId = deriveId(payload);
    if (!consumePaymentId(db, reservationId)) return { ok: false, reason: "payment_replayed" };
    return { ok: true, charge: reservedCharge(db, base, body, reservationId) };
  } catch (err) {
    log.warn("x402 verify error", { err: String(err) });
    return { ok: false, reason: "facilitator_unreachable" };
  }
}

function reservedCharge(db: Database.Database, base: string, body: string, reservationId: string): X402Charge {
  let state: "reserved" | "settled" | "unknown" | "released" = "reserved";
  const release = (): void => {
    if (state !== "reserved") return;
    releasePaymentId(db, reservationId);
    state = "released";
  };
  const settle = async (): Promise<void> => {
    let settleRes: Response;
    try {
      settleRes = await postWithTimeout(`${base}/settle`, body);
    } catch (err) {
      // Outcome unknown (timeout, network). Keep the reservation: re-running
      // settle on the same payload could double-charge, which is worse than
      // making the caller retry with a fresh payment.
      state = "unknown";
      log.warn("x402 settle error; reservation kept", { err: String(err) });
      throw new PaymentRequiredError("Payment settlement could not be confirmed; retry with a new payment.", {
        reason: "settlement_unconfirmed",
      });
    }
    const settleBody = (await settleRes.json().catch(() => ({}))) as { success?: boolean; transaction?: string };
    if (!settleRes.ok || !settleBody.success) {
      release();
      throw new PaymentRequiredError("Payment did not settle.", { reason: "settlement_failed" });
    }
    state = "settled";
    log.info("x402 payment settled", { transaction: settleBody.transaction });
  };
  return { settle, release };
}

/**
 * Replay key for a payment: the EIP-3009 authorization's (from, nonce), which
 * the token contract itself treats as single-use. Hashing the serialized JSON
 * let one payment be re-encoded (key order, extra fields) into many distinct
 * ids, each passing /verify before the first settle landed.
 */
function deriveId(payload: Record<string, unknown>): string {
  const auth = (payload.payload as { authorization?: { from?: unknown; nonce?: unknown } } | undefined)?.authorization;
  if (typeof auth?.from === "string" && typeof auth?.nonce === "string") {
    return `eip3009:${auth.from.toLowerCase()}:${auth.nonce.toLowerCase()}`;
  }
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Facilitator calls must never hang a request: hard 10s timeout per call. */
async function postWithTimeout(url: string, body: string, timeoutMs = 10_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

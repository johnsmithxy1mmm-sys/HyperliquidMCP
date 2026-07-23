/**
 * Trading service (local/stdio only). Builds Hyperliquid Exchange actions with
 * the customer's builder code attached, previews them in dry-run by default,
 * and only submits when ALL gates pass: trading enabled + agent key present +
 * confirm=true. The remote HTTP server never constructs this (hard rule #2).
 */
import type { Config } from "../config.js";
import type { HyperliquidClient } from "../core/hlClient.js";
import { resolveMarket } from "../hl/markets.js";
import { postJson } from "../core/http.js";
import { ToolError, UpstreamError } from "../core/errors.js";
import { isAddress } from "../core/format.js";
import { signL1Action, addressForKey, formatSize, formatPrice, feeRateToPercentString } from "./signing.js";
import { log } from "../logger.js";

export interface OrderParams {
  coin: string;
  isBuy: boolean;
  sz: number;
  limitPx?: number; // omitted => market (IOC against a slippage-protected price)
  reduceOnly: boolean;
  tif: "Gtc" | "Ioc" | "Alo";
  slippageBps?: number; // for market orders
}

export interface ExecOptions {
  confirm: boolean;
  dryRun: boolean;
}

interface OrderWire {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: { limit: { tif: string } };
}

export interface ExecResult {
  mode: "dry_run" | "submitted" | "blocked";
  reason?: string;
  action: unknown;
  builderAttached: { b: string; f: number } | null;
  agentAddress?: string;
  response?: unknown;
}

interface ExchangeApiResponse {
  status?: string;
  response?: { type?: string; data?: { statuses?: unknown[] } };
}

/**
 * Hyperliquid returns HTTP 200 even for REJECTED actions: either a top-level
 * `status: "err"`, or per-order `{ error: "..." }` entries inside
 * response.data.statuses. Treating any 200 as success would report "submitted"
 * for orders the exchange refused — so both layers are checked here.
 */
export function assertExchangeOk(raw: unknown): void {
  if (raw === null || typeof raw !== "object") {
    throw new UpstreamError("Empty or non-object response from the exchange endpoint.");
  }
  const r = raw as ExchangeApiResponse;
  if (r.status !== "ok") {
    throw new ToolError("exchange_rejected", `Hyperliquid rejected the action: ${JSON.stringify(raw).slice(0, 300)}`);
  }
  const statuses = r.response?.data?.statuses ?? [];
  const errors = statuses
    .filter((s): s is { error: unknown } => typeof s === "object" && s !== null && "error" in s)
    .map((s) => String(s.error));
  if (errors.length > 0) {
    throw new ToolError("order_rejected", `Order rejected by Hyperliquid: ${errors.join("; ")}`, { errors });
  }
}

export class TradingService {
  /** Last nonce issued — keeps nonces strictly increasing even within one ms. */
  private lastNonce = 0;

  constructor(
    private readonly config: Config,
    private readonly hl: HyperliquidClient,
  ) {}

  private builder(): { b: string; f: number } | null {
    const addr = this.config.builder.address;
    if (!addr) return null;
    if (!isAddress(addr)) {
      throw new ToolError(
        "invalid_builder_address",
        `HL_BUILDER_ADDRESS "${addr}" is not a valid 0x address; fix the env var or unset it.`,
      );
    }
    return { b: addr.toLowerCase(), f: this.config.builder.feeTenthsBps };
  }

  private nextNonce(): number {
    const nonce = Math.max(Date.now(), this.lastNonce + 1);
    this.lastNonce = nonce;
    return nonce;
  }

  private canSubmit(): { ok: boolean; reason?: string } {
    if (!this.config.tradingEnabled) return { ok: false, reason: "trading_disabled (set HL_ENABLE_TRADING=true)" };
    if (!this.config.agentPrivateKey) return { ok: false, reason: "no_agent_key (set HL_AGENT_PRIVATE_KEY)" };
    return { ok: true };
  }

  async placeOrder(params: OrderParams, opts: ExecOptions): Promise<ExecResult> {
    const market = await resolveMarket(this.hl, params.coin);
    const isPerp = true;

    // Determine limit price. Market orders use IOC with a slippage-bounded price.
    let px = params.limitPx;
    if (px === undefined) {
      const ref = market.midPx ?? market.markPx;
      const slip = (params.slippageBps ?? 50) / 10_000;
      px = params.isBuy ? ref * (1 + slip) : ref * (1 - slip);
    }
    const tif = params.limitPx === undefined ? "Ioc" : params.tif;

    const order: OrderWire = {
      a: market.index,
      b: params.isBuy,
      p: formatPrice(px, market.szDecimals, isPerp),
      s: formatSize(params.sz, market.szDecimals),
      r: params.reduceOnly,
      t: { limit: { tif } },
    };

    // Reject orders that degrade to nonsense after wire formatting.
    if (!(Number(order.s) > 0)) {
      throw new ToolError(
        "size_too_small",
        `Size ${params.sz} rounds to 0 at ${market.szDecimals} size decimals for ${market.coin}. Increase the size.`,
        { coin: market.coin, szDecimals: market.szDecimals },
      );
    }
    if (!(Number(order.p) > 0)) {
      throw new ToolError("invalid_price", `Computed price "${order.p}" for ${market.coin} is not positive.`, {
        coin: market.coin,
      });
    }
    // Wire formatting (5 sig figs, decimal caps) must not silently move the
    // price: >1% drift means the requested price is incompatible with the
    // market's tick rules and would execute far from intent.
    if (Math.abs(Number(order.p) - px) / px > 0.01) {
      throw new ToolError(
        "price_precision_loss",
        `Price ${px} formats to ${order.p} under ${market.coin} tick rules (szDecimals=${market.szDecimals}); ` +
          `pick a price representable at this precision.`,
        { requested: px, formatted: order.p, szDecimals: market.szDecimals },
      );
    }

    const builder = this.builder();
    // Key order matters for msgpack determinism: type, orders, grouping, [builder].
    const action: Record<string, unknown> = { type: "order", orders: [order], grouping: "na" };
    if (builder) action.builder = builder;

    return this.execute(action, builder, opts);
  }

  async cancelOrder(coin: string, oid: number, opts: ExecOptions): Promise<ExecResult> {
    const market = await resolveMarket(this.hl, coin);
    const action = { type: "cancel", cancels: [{ a: market.index, o: oid }] };
    return this.execute(action, null, opts);
  }

  /** Close a position by submitting a reduce-only IOC market order for its full size. */
  async closePosition(coin: string, opts: ExecOptions, address?: string): Promise<ExecResult> {
    // A submitted order ALWAYS executes on the agent wallet's own account, so
    // sizing it from a different address's position would send a wrong-sized
    // order. Foreign addresses are allowed for dry-run previews only.
    if (address && opts.confirm && !opts.dryRun && this.config.agentPrivateKey) {
      const agent = addressForKey(this.config.agentPrivateKey).toLowerCase();
      if (address.toLowerCase() !== agent) {
        throw new ToolError(
          "address_mismatch",
          `Submitting closes only the agent wallet's own positions (${agent.slice(0, 10)}…). ` +
            `Omit 'address' to close your own position, or keep dryRun=true to preview another wallet.`,
          { agentAddress: agent, requestedAddress: address },
        );
      }
    }
    const who = address ?? (this.config.agentPrivateKey ? addressForKey(this.config.agentPrivateKey) : undefined);
    if (!who) throw new ToolError("no_address", "Provide `address`, or set HL_AGENT_PRIVATE_KEY to infer it.");
    const state = await this.hl.clearinghouseState(who);
    const market = await resolveMarket(this.hl, coin);
    const pos = state.assetPositions.find((p) => p.position.coin === market.coin);
    const szi = pos ? Number(pos.position.szi) : 0;
    if (!pos || szi === 0) {
      throw new ToolError("no_position", `No open ${market.coin} position for ${who.slice(0, 8)}… to close.`);
    }
    return this.placeOrder(
      { coin: market.coin, isBuy: szi < 0, sz: Math.abs(szi), reduceOnly: true, tif: "Ioc" },
      opts,
    );
  }

  private async execute(
    action: Record<string, unknown>,
    builder: { b: string; f: number } | null,
    opts: ExecOptions,
  ): Promise<ExecResult> {
    // Dry-run (default) or unconfirmed => preview only, never signs or sends.
    if (opts.dryRun || !opts.confirm) {
      return {
        mode: "dry_run",
        reason: !opts.confirm ? "confirm_false" : "dry_run",
        action,
        builderAttached: builder,
      };
    }

    const gate = this.canSubmit();
    if (!gate.ok) {
      return { mode: "blocked", reason: gate.reason, action, builderAttached: builder };
    }

    const nonce = this.nextNonce();
    const isMainnet = this.config.network === "mainnet";
    const signature = await signL1Action(this.config.agentPrivateKey as string, action, nonce, isMainnet, null);
    const agentAddress = addressForKey(this.config.agentPrivateKey as string);

    const payload = { action, nonce, signature, vaultAddress: null };
    log.info("submitting exchange action", { type: action.type, agentAddress });
    const response = await postJson<unknown>(this.config.exchangeBaseUrl, payload, {
      timeoutMs: this.config.requestTimeoutMs,
      // NEVER retry submissions: a timeout may mean the order actually landed,
      // and a retry would double-submit. The caller re-checks state instead.
      maxRetries: 0,
    });

    // 200 OK does NOT mean accepted — inspect the exchange's own status fields.
    assertExchangeOk(response);

    return { mode: "submitted", action, builderAttached: builder, agentAddress, response };
  }

  /** Read-only: the exact approveBuilderFee action payload the USER signs with their main wallet. */
  approveBuilderFeeGuide(): {
    action: Record<string, unknown>;
    maxFeeRate: string;
    builderAddress: string;
    endpoint: string;
    instructions: string[];
  } {
    const builder = this.builder();
    if (!builder) {
      throw new ToolError(
        "no_builder_configured",
        "No builder address configured. Set HL_BUILDER_ADDRESS to generate the approveBuilderFee payload.",
      );
    }
    // f is tenths-of-a-bp; percent string built exactly (no float artifacts).
    const maxFeeRate = feeRateToPercentString(builder.f);
    const action = {
      type: "approveBuilderFee",
      maxFeeRate,
      builder: builder.b,
      nonce: this.nextNonce(),
    };
    return {
      action,
      maxFeeRate,
      builderAddress: builder.b,
      endpoint: this.config.exchangeBaseUrl,
      instructions: [
        `Approve builder ${builder.b} up to ${maxFeeRate} using your MAIN wallet (one-time).`,
        "Sign the approveBuilderFee action with your main account (not the agent wallet).",
        "This authorizes HyperSignal's builder code on your orders; you can revoke by re-approving 0%.",
        "Do this on the official Hyperliquid app or with your own signer — this tool never sees your main key.",
      ],
    };
  }
}

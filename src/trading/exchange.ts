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
import { ToolError } from "../core/errors.js";
import { signL1Action, addressForKey, formatSize, formatPrice } from "./signing.js";
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

export class TradingService {
  constructor(
    private readonly config: Config,
    private readonly hl: HyperliquidClient,
  ) {}

  private builder(): { b: string; f: number } | null {
    if (!this.config.builder.address) return null;
    return { b: this.config.builder.address.toLowerCase(), f: this.config.builder.feeTenthsBps };
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

    const nonce = Date.now();
    const isMainnet = this.config.network === "mainnet";
    const signature = await signL1Action(this.config.agentPrivateKey as string, action, nonce, isMainnet, null);
    const agentAddress = addressForKey(this.config.agentPrivateKey as string);

    const payload = { action, nonce, signature, vaultAddress: null };
    log.info("submitting exchange action", { type: action.type, agentAddress });
    const response = await postJson<unknown>(this.config.exchangeBaseUrl, payload, {
      timeoutMs: this.config.requestTimeoutMs,
      maxRetries: 1, // do not blindly retry order submission
    });

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
    // f is tenths-of-a-bp; percent = f * 0.001.
    const maxFeeRate = `${builder.f * 0.001}%`;
    const action = {
      type: "approveBuilderFee",
      maxFeeRate,
      builder: builder.b,
      nonce: Date.now(),
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

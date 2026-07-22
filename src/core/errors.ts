/**
 * Typed errors. Tool handlers throw these; the registry converts them into
 * MCP `{ isError: true }` results with actionable, agent-readable messages
 * (hard rule: "монета не найдена — вызови hl_get_markets для списка").
 */

export class ToolError extends Error {
  /** Machine-readable code for clients. */
  readonly code: string;
  /** Optional structured hint payload surfaced to the agent. */
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
  }
}

/** The requested coin/market does not exist — tell the agent how to discover valid ones. */
export function unknownCoin(coin: string): ToolError {
  return new ToolError(
    "unknown_coin",
    `Coin "${coin}" not found on Hyperliquid. Call hl_get_markets to list valid coin symbols, then retry.`,
    { coin },
  );
}

/** Invalid address input. */
export function invalidAddress(address: string): ToolError {
  return new ToolError(
    "invalid_address",
    `"${address}" is not a valid 0x EVM address (expected 42 hex chars). Provide a checksummed or lowercase 0x address.`,
    { address },
  );
}

/** Payment / quota gate for premium tools (HTTP mode). Carries x402 requirements. */
export class PaymentRequiredError extends ToolError {
  constructor(message: string, details: Record<string, unknown>) {
    super("payment_required", message, details);
    this.name = "PaymentRequiredError";
  }
}

/** Upstream Hyperliquid failure after retries. */
export class UpstreamError extends ToolError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("upstream_error", message, details);
    this.name = "UpstreamError";
  }
}

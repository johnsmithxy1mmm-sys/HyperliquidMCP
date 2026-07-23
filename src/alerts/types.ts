/**
 * Standing-alert domain types. Alerts are persistent conditions the server
 * evaluates on a schedule; fired events are stored for the agent to poll
 * (stateless HTTP can't push). This turns the server from an API into an agent
 * that watches the market for you.
 */

export type AlertType = "funding_apr" | "price_move" | "whale_net_flip";

export interface AlertParams {
  coin?: string;
  /** funding_apr: fire when |annualized funding| crosses this fraction (0.5 = 50% APR). */
  aprThreshold?: number;
  /** price_move: fire when |return| over the window exceeds this fraction. */
  movePct?: number;
  windowMinutes?: number;
  /** whale_net_flip: cohort of 0x addresses (or empty to use HL_WHALE_ADDRESSES). */
  cohort?: string[];
}

export interface AlertRecord {
  id: string;
  subject: string;
  type: AlertType;
  params: AlertParams;
  enabled: boolean;
  cooldownMinutes: number;
  lastFiredAt: number | null;
  lastState: unknown;
  createdAt: number;
}

export interface FiredEvent {
  id: number;
  alertId: string;
  subject: string;
  at: number;
  message: string;
  payload: Record<string, unknown>;
}

/** Result of evaluating an alert against current market context. */
export interface EvalResult {
  fired: boolean;
  message?: string;
  /** New persisted state (crossing detection). */
  state?: unknown;
  /** Signal payload recorded to the track record when fired. */
  signal?: { type: string; coin: string; direction: "long" | "short" | "neutral"; refPx: number };
}

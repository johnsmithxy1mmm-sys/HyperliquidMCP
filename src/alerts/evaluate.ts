/**
 * Pure alert evaluators — no I/O, fully unit-testable. Each takes the alert plus
 * the precomputed market context it needs and returns whether it fired, a
 * message, the new persisted state (for crossing detection), and a signal
 * payload for the track record.
 */
import type { AlertRecord, EvalResult } from "./types.js";

export interface EvalInputs {
  now: number;
  /** Current market data for the alert's coin. */
  markPx?: number;
  fundingApr?: number;
  /** Price ~windowMinutes ago (price_move). */
  priorPx?: number;
  /** Current whale net notional USD for the cohort+coin (whale_net_flip). */
  whaleNetNtlUsd?: number;
}

export function evaluateAlert(alert: AlertRecord, inp: EvalInputs): EvalResult {
  switch (alert.type) {
    case "funding_apr":
      return evalFundingApr(alert, inp);
    case "price_move":
      return evalPriceMove(alert, inp);
    case "whale_net_flip":
      return evalWhaleFlip(alert, inp);
    default:
      return { fired: false };
  }
}

function evalFundingApr(alert: AlertRecord, inp: EvalInputs): EvalResult {
  const threshold = alert.params.aprThreshold ?? 0.5;
  const coin = alert.params.coin ?? "?";
  if (inp.fundingApr === undefined || inp.markPx === undefined) return { fired: false };
  const over = Math.abs(inp.fundingApr) >= threshold;
  const prevOver = (alert.lastState as { over?: boolean } | null)?.over === true;
  const state = { over };
  // Fire only on the rising edge (crossing into "over").
  if (over && !prevOver) {
    // Carry direction: positive funding => shorts receive => "short"; else "long".
    const direction: "long" | "short" = inp.fundingApr > 0 ? "short" : "long";
    return {
      fired: true,
      message: `${coin} funding at ${(inp.fundingApr * 100).toFixed(1)}% APR crossed |${(threshold * 100).toFixed(0)}%| — carry favors ${direction}.`,
      state,
      signal: { type: "funding_apr", coin, direction, refPx: inp.markPx },
    };
  }
  return { fired: false, state };
}

function evalPriceMove(alert: AlertRecord, inp: EvalInputs): EvalResult {
  const movePct = alert.params.movePct ?? 0.05;
  const coin = alert.params.coin ?? "?";
  if (inp.markPx === undefined || inp.priorPx === undefined || inp.priorPx <= 0) return { fired: false };
  const ret = (inp.markPx - inp.priorPx) / inp.priorPx;
  if (Math.abs(ret) >= movePct) {
    const direction: "long" | "short" = ret > 0 ? "long" : "short";
    return {
      fired: true,
      message: `${coin} moved ${(ret * 100).toFixed(2)}% over the window (≥ ${(movePct * 100).toFixed(1)}%).`,
      signal: { type: "price_move", coin, direction, refPx: inp.markPx },
    };
  }
  return { fired: false };
}

function evalWhaleFlip(alert: AlertRecord, inp: EvalInputs): EvalResult {
  const coin = alert.params.coin ?? "?";
  if (inp.whaleNetNtlUsd === undefined || inp.markPx === undefined) return { fired: false };
  const sign = inp.whaleNetNtlUsd > 0 ? 1 : inp.whaleNetNtlUsd < 0 ? -1 : 0;
  const prevSign = (alert.lastState as { sign?: number } | null)?.sign ?? 0;
  const state = { sign };
  // Fire on a genuine long<->short flip (ignore flips through/into flat).
  if (sign !== 0 && prevSign !== 0 && sign !== prevSign) {
    const direction: "long" | "short" = sign > 0 ? "long" : "short";
    return {
      fired: true,
      message: `${coin} whale cohort net position flipped ${prevSign > 0 ? "long→short" : "short→long"} ($${Math.round(inp.whaleNetNtlUsd).toLocaleString()} net).`,
      state,
      signal: { type: "whale_net_flip", coin, direction, refPx: inp.markPx },
    };
  }
  return { fired: false, state };
}

/**
 * Pure probability math for Hyperliquid↔Polymarket divergence. Given Hyperliquid
 * price + realized volatility, estimate the probability of a price-threshold
 * event and compare it to the prediction-market's implied odds. No I/O.
 *
 * These are lognormal, driftless-by-default estimates (you can pass funding as
 * drift) — an analytical edge signal, not a guarantee.
 */

/** Standard normal CDF via Abramowitz-Stegun 7.1.26 (erf approximation). */
export function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

/** Annualized volatility from close prices (log returns * sqrt(periods/year)). */
export function annualizedVol(closes: number[], periodsPerYear: number): number {
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < 2) return 0;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(periodsPerYear);
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** P(S_T ≥ K) at expiry under lognormal dynamics (European "above at resolution"). */
export function probAboveAtExpiry(S: number, K: number, tYears: number, sigma: number, drift = 0): number {
  if (!(S > 0) || !(K > 0)) return 0;
  if (tYears <= 0 || sigma <= 0) return S >= K ? 1 : 0;
  const d2 = (Math.log(S / K) + (drift - (sigma * sigma) / 2) * tYears) / (sigma * Math.sqrt(tYears));
  return clamp01(normCdf(d2));
}

/** P(S_T ≤ K) at expiry = 1 - P(above). */
export function probBelowAtExpiry(S: number, K: number, tYears: number, sigma: number, drift = 0): number {
  return clamp01(1 - probAboveAtExpiry(S, K, tYears, sigma, drift));
}

/**
 * P(price touches K at ANY time before T) — one-touch upper barrier, driftless
 * (reflection principle): 2·Φ(−|ln(K/S)|/(σ√T)). For "reach/hit by date" markets.
 */
export function probTouchAbove(S: number, K: number, tYears: number, sigma: number): number {
  if (!(S > 0) || !(K > 0)) return 0;
  if (S >= K) return 1;
  if (tYears <= 0 || sigma <= 0) return 0;
  const b = Math.log(K / S); // > 0
  return clamp01(2 * normCdf(-b / (sigma * Math.sqrt(tYears))));
}

/** Hyperliquid-implied probability of a parsed threshold event ("Yes" side). */
export function impliedProbForMode(
  mode: "above" | "below" | "touch",
  S: number,
  K: number,
  tYears: number,
  sigma: number,
  drift = 0,
): number {
  switch (mode) {
    case "below":
      return probBelowAtExpiry(S, K, tYears, sigma, drift);
    case "touch":
      return probTouchAbove(S, K, tYears, sigma);
    case "above":
    default:
      return probAboveAtExpiry(S, K, tYears, sigma, drift);
  }
}

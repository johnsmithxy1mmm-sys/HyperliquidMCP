/**
 * Score calibration — pure math for answering the only question that matters
 * about a score: **do higher-scored wallets actually do better afterwards?**
 *
 * Until this returns a positive, significant result over a real sample, the
 * score is a screening heuristic, not a prediction — and the tools say so.
 *
 * Spearman (rank) correlation is used rather than Pearson: we care whether the
 * ORDER is right, not whether the relationship is linear, and PnL outcomes are
 * heavy-tailed enough that a single whale would dominate a linear fit.
 */

export interface ScoredOutcome {
  score: number;
  /** Realized PnL over the forward window (deposit-immune, from fills). */
  forwardPnl: number;
}

export interface CalibrationReport {
  /** Observations with a resolved outcome. */
  n: number;
  /** Spearman rank correlation in [-1, 1]; null when n < 4. */
  spearman: number | null;
  /** Two-sided p-value approximation; null when n < 10. */
  pValue: number | null;
  /** Mean forward PnL per score quartile, lowest first. */
  quartiles: Array<{ quartile: number; scoreRange: [number, number]; meanForwardPnl: number; n: number }>;
  /** Plain-language verdict for API consumers. */
  verdict: "insufficient_data" | "no_evidence" | "weak_positive" | "positive";
}

/** Fractional ranks with ties averaged (required for a correct Spearman). */
export function rankWithTies(xs: number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
    const avg = (i + j) / 2 + 1; // ranks are 1-based
    for (let k = i; k <= j; k++) ranks[idx[k].i] = avg;
    i = j + 1;
  }
  return ranks;
}

export function spearman(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length < 4) return null;
  const ra = rankWithTies(a);
  const rb = rankWithTies(b);
  const n = ra.length;
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const ma = mean(ra);
  const mb = mean(rb);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = ra[i] - ma;
    const xb = rb[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

/**
 * Two-sided p-value for Spearman via the t approximation
 * t = r * sqrt((n-2)/(1-r^2)), valid for n >= 10.
 */
export function spearmanPValue(r: number, n: number): number | null {
  if (n < 10) return null;
  if (Math.abs(r) >= 1) return 0;
  const t = Math.abs(r) * Math.sqrt((n - 2) / (1 - r * r));
  return 2 * (1 - studentTCdf(t, n - 2));
}

/** Student-t CDF via the incomplete beta function. */
function studentTCdf(t: number, df: number): number {
  const x = df / (df + t * t);
  return 1 - 0.5 * incompleteBeta(x, df / 2, 0.5);
}

/** Regularized incomplete beta I_x(a,b) — continued fraction (Lentz). */
function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;

  let f = 1;
  let c = 1;
  let d = 0;
  for (let i = 0; i <= 200; i++) {
    const m = Math.floor(i / 2);
    let numerator: number;
    if (i === 0) numerator = 1;
    else if (i % 2 === 0) numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    else numerator = (-((a + m) * (a + b + m)) * x) / ((a + 2 * m) * (a + 2 * m + 1));

    d = 1 + numerator * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    d = 1 / d;
    c = 1 + numerator / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    const cd = c * d;
    f *= cd;
    if (Math.abs(1 - cd) < 1e-10) break;
  }
  const result = front * (f - 1);
  return a > (a + b) / 2 ? 1 - result : result;
}

/** Lanczos approximation of log Γ(x). */
function logGamma(x: number): number {
  const g = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2,
    -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

export function calibrate(observations: ScoredOutcome[]): CalibrationReport {
  const usable = observations.filter(
    (o) => Number.isFinite(o.score) && Number.isFinite(o.forwardPnl),
  );
  const n = usable.length;
  if (n < 4) {
    return { n, spearman: null, pValue: null, quartiles: [], verdict: "insufficient_data" };
  }

  const r = spearman(
    usable.map((o) => o.score),
    usable.map((o) => o.forwardPnl),
  );
  const p = r === null ? null : spearmanPValue(r, n);

  // Quartiles by score, lowest first.
  const sorted = [...usable].sort((a, b) => a.score - b.score);
  const quartiles: CalibrationReport["quartiles"] = [];
  const size = Math.floor(sorted.length / 4);
  if (size >= 1) {
    for (let q = 0; q < 4; q++) {
      const slice = q === 3 ? sorted.slice(q * size) : sorted.slice(q * size, (q + 1) * size);
      if (slice.length === 0) continue;
      quartiles.push({
        quartile: q + 1,
        scoreRange: [slice[0].score, slice[slice.length - 1].score],
        meanForwardPnl: slice.reduce((s, o) => s + o.forwardPnl, 0) / slice.length,
        n: slice.length,
      });
    }
  }

  let verdict: CalibrationReport["verdict"] = "insufficient_data";
  if (n >= 30 && r !== null) {
    if (p !== null && p < 0.05 && r > 0.2) verdict = "positive";
    else if (r > 0.1) verdict = "weak_positive";
    else verdict = "no_evidence";
  }

  return { n, spearman: r, pValue: p, quartiles, verdict };
}

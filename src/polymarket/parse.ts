/**
 * Pure heuristic parser: turn a Polymarket crypto question into a structured
 * price-threshold event we can price from Hyperliquid. Returns null for
 * questions that aren't a recognizable single-asset price threshold.
 */

export type ThresholdMode = "above" | "below" | "touch" | "touch_below";

export interface ParsedThreshold {
  asset: string; // display name matched
  coin: string; // Hyperliquid perp symbol
  thresholdUsd: number;
  mode: ThresholdMode;
}

/** Common Polymarket asset phrasings -> Hyperliquid perp symbol. */
const ASSET_MAP: Array<{ re: RegExp; coin: string; name: string }> = [
  { re: /\b(bitcoin|btc)\b/i, coin: "BTC", name: "Bitcoin" },
  { re: /\b(ethereum|ether|eth)\b/i, coin: "ETH", name: "Ethereum" },
  { re: /\b(solana|sol)\b/i, coin: "SOL", name: "Solana" },
  { re: /\b(dogecoin|doge)\b/i, coin: "DOGE", name: "Dogecoin" },
  { re: /\b(ripple|xrp)\b/i, coin: "XRP", name: "XRP" },
  { re: /\b(cardano|ada)\b/i, coin: "ADA", name: "Cardano" },
  { re: /\b(avalanche|avax)\b/i, coin: "AVAX", name: "Avalanche" },
  { re: /\b(chainlink|link)\b/i, coin: "LINK", name: "Chainlink" },
  { re: /\b(litecoin|ltc)\b/i, coin: "LTC", name: "Litecoin" },
  { re: /\b(hyperliquid|hype)\b/i, coin: "HYPE", name: "Hyperliquid" },
];

const TOUCH_WORDS = /\b(reach|hit|touch|surpass|rise to|get to|all-?time high|ath)\b/i;
/** Downward reach-verbs: "drop to $X" resolves YES on ANY touch, not just at expiry. */
const TOUCH_BELOW_WORDS = /\b(drop to|fall to|dip to|crash to|decline to)\b/i;
const ABOVE_WORDS = /\b(above|over|exceed|greater than|more than|≥|>=|at or above)\b/i;
const BELOW_WORDS = /\b(below|under|less than|≤|<=)\b/i;

/**
 * Phrases that mean the number in the question is NOT a USD price of the
 * asset. "Bitcoin dominance above 60%" parses as a $60 BTC threshold and, with
 * BTC near $90,000, yields P=1.0 and a ~50pp "edge" that outranks every real
 * opportunity. Sorting by |edge| means the worst misreads surface first, so
 * these must be refused outright rather than scored.
 */
const NON_PRICE_SUBJECTS =
  /\b(dominance|market\s?cap|marketcap|supply|hashrate|hash\s?rate|difficulty|fees?|gas|volume|tvl|apy|apr|inflation|holders?|addresses|transactions|nodes?|staked?|percent|%)\b/i;

/** Two thresholds in one question: a range or a compound bet, not a single event. */
const COMPOUND = /\b(and|or)\b/i;

export function parseThresholdMarket(question: string): ParsedThreshold | null {
  if (!question) return null;
  const asset = ASSET_MAP.find((a) => a.re.test(question));
  if (!asset) return null;

  // A question about dominance/market cap/supply is not a price threshold, and
  // pricing it as one produces a confident, completely fictitious edge.
  if (NON_PRICE_SUBJECTS.test(question)) return null;

  // More than one asset mentioned => we cannot tell which the threshold belongs
  // to. Picking one silently discards the other half of the question.
  const assetsMentioned = ASSET_MAP.filter((a) => a.re.test(question)).length;
  if (assetsMentioned > 1) return null;

  const thresholdUsd = parseThresholdUsd(question);
  if (thresholdUsd === null) return null;

  // "above $90k and below $100k" is a range; a single-threshold model prices it
  // wrongly in a way no disclaimer covers.
  if (COMPOUND.test(question) && countThresholdCandidates(question) > 1) return null;

  let mode: ThresholdMode;
  if (TOUCH_BELOW_WORDS.test(question)) mode = "touch_below";
  else if (BELOW_WORDS.test(question)) mode = "below";
  else if (TOUCH_WORDS.test(question)) mode = "touch";
  else if (ABOVE_WORDS.test(question)) mode = "above";
  else mode = "above"; // default reading for "$X by date"

  return { asset: asset.name, coin: asset.coin, thresholdUsd, mode };
}

/**
 * Extract the monetary threshold. Scans ALL number candidates and prefers
 * $-prefixed or k/m/bn-suffixed ones, skipping bare 1900–2100 integers (years):
 * "ETF approval in 2024 push BTC above $50k" must yield 50000, not 2024.
 * Tie-break: larger value (a date's day-number never beats a price).
 */
export function parseThresholdUsd(text: string): number | null {
  const re = /(\$)?\s*([\d]{1,3}(?:,[\d]{3})+|[\d]+(?:\.[\d]+)?)\s*(k|thousand|m|mm|million|bn|billion)?\b/gi;
  let best: { value: number; score: number } | null = null;
  for (const m of text.matchAll(re)) {
    const hasDollar = m[1] === "$";
    let value = Number(m[2].replace(/,/g, ""));
    if (!Number.isFinite(value) || value <= 0) continue;
    const suffix = (m[3] ?? "").toLowerCase();
    const hasSuffix = suffix.length > 0;
    if (suffix === "k" || suffix === "thousand") value *= 1_000;
    else if (suffix === "m" || suffix === "mm" || suffix === "million") value *= 1_000_000;
    else if (suffix === "bn" || suffix === "billion") value *= 1_000_000_000;
    // A bare 1900-2100 integer is almost certainly a year, not a price.
    if (!hasDollar && !hasSuffix && Number.isInteger(value) && value >= 1900 && value <= 2100) continue;
    const score = (hasDollar ? 2 : 0) + (hasSuffix ? 1 : 0);
    if (!best || score > best.score || (score === best.score && value > best.value)) {
      best = { value, score };
    }
  }
  return best?.value ?? null;
}

/** How many distinct price-like numbers the question contains. */
function countThresholdCandidates(text: string): number {
  const re = /(\$)\s*([\d]{1,3}(?:,[\d]{3})+|[\d]+(?:\.[\d]+)?)\s*(k|thousand|m|mm|million|bn|billion)?\b/gi;
  const seen = new Set<string>();
  for (const m of text.matchAll(re)) seen.add(`${m[2]}${(m[3] ?? "").toLowerCase()}`);
  return seen.size;
}

/**
 * Is a parsed threshold plausibly a price for an asset trading at `spot`?
 *
 * A threshold orders of magnitude away from spot is almost always a misparse
 * (a percentage, a count, a year), and it is precisely the misparses that
 * produce probabilities of exactly 0 or 1 — the largest possible |edge| — and
 * therefore rank first. Real threshold markets sit within a few multiples of
 * spot; this rejects the rest.
 */
export function isPlausibleThreshold(thresholdUsd: number, spot: number, maxRatio = 20): boolean {
  if (!(thresholdUsd > 0) || !(spot > 0)) return false;
  const ratio = thresholdUsd > spot ? thresholdUsd / spot : spot / thresholdUsd;
  return ratio <= maxRatio;
}

/** Years to expiry from an ISO/epoch end date; clamped ≥ 0. */
export function yearsToExpiry(endDate: string | number | undefined, now = Date.now()): number {
  if (endDate === undefined) return 0;
  const end = typeof endDate === "number" ? endDate : Date.parse(endDate);
  if (!Number.isFinite(end)) return 0;
  return Math.max(0, (end - now) / (365 * 86_400_000));
}

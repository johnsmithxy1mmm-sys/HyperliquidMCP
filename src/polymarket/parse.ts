/**
 * Pure heuristic parser: turn a Polymarket crypto question into a structured
 * price-threshold event we can price from Hyperliquid. Returns null for
 * questions that aren't a recognizable single-asset price threshold.
 */

export type ThresholdMode = "above" | "below" | "touch";

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
const ABOVE_WORDS = /\b(above|over|exceed|greater than|more than|≥|>=|at or above)\b/i;
const BELOW_WORDS = /\b(below|under|less than|drop to|fall to|dip to|≤|<=)\b/i;

export function parseThresholdMarket(question: string): ParsedThreshold | null {
  if (!question) return null;
  const asset = ASSET_MAP.find((a) => a.re.test(question));
  if (!asset) return null;

  const thresholdUsd = parseThresholdUsd(question);
  if (thresholdUsd === null) return null;

  let mode: ThresholdMode;
  if (BELOW_WORDS.test(question)) mode = "below";
  else if (TOUCH_WORDS.test(question)) mode = "touch";
  else if (ABOVE_WORDS.test(question)) mode = "above";
  else mode = "above"; // default reading for "$X by date"

  return { asset: asset.name, coin: asset.coin, thresholdUsd, mode };
}

/** Extract the first monetary threshold, honoring k/m/bn suffixes and commas. */
export function parseThresholdUsd(text: string): number | null {
  // e.g. "$100,000", "$120k", "150K", "$1.2M", "100000"
  const m = text.match(/\$?\s*([\d]{1,3}(?:,[\d]{3})+|[\d]+(?:\.[\d]+)?)\s*(k|thousand|m|mm|million|bn|billion)?/i);
  if (!m) return null;
  let value = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  const suffix = (m[2] ?? "").toLowerCase();
  if (suffix === "k" || suffix === "thousand") value *= 1_000;
  else if (suffix === "m" || suffix === "mm" || suffix === "million") value *= 1_000_000;
  else if (suffix === "bn" || suffix === "billion") value *= 1_000_000_000;
  // Ignore obviously non-price small integers (e.g. years handled by caller).
  return value > 0 ? value : null;
}

/** Years to expiry from an ISO/epoch end date; clamped ≥ 0. */
export function yearsToExpiry(endDate: string | number | undefined, now = Date.now()): number {
  if (endDate === undefined) return 0;
  const end = typeof endDate === "number" ? endDate : Date.parse(endDate);
  if (!Number.isFinite(end)) return 0;
  return Math.max(0, (end - now) / (365 * 86_400_000));
}

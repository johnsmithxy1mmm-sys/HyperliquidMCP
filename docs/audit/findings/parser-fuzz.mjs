const { parseThresholdUsd, parseThresholdMarket, yearsToExpiry } = await import(
  "/home/user/Polymarket-Mint-Bot/hypersignal-mcp/dist/polymarket/parse.js"
);

// --- ReDoS probe: pathological inputs, structure-aware (mutate a valid sample) ---
const probes = {
  "commas x5k": "BTC above $" + "1,234".repeat(5000),
  "digits x50k": "BTC above $" + "9".repeat(50000),
  "dollar+space x20k": "BTC above " + "$ ".repeat(20000) + "1",
  "decimals x20k": "BTC above $" + "1.".repeat(20000) + "1",
  "mixed x10k": "BTC " + "$1,234.5k ".repeat(10000),
  "surrogate+rtl": "BTC above $50k " + String.fromCharCode(0xd800) + "‮" + "x".repeat(10000),
};
console.log("=== ReDoS / timing ===");
for (const [name, s] of Object.entries(probes)) {
  const t0 = process.hrtime.bigint();
  const r = parseThresholdUsd(s);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  ${name.padEnd(20)} len=${String(s.length).padEnd(7)} ${ms.toFixed(1).padStart(8)}ms  -> ${r}`);
}

console.log("");
console.log("=== semantics on edge-case questions ===");
const cases = [
  ["Will BTC reach $100k by Dec 2026?", 100000, "touch"],
  ["Will BTC be above $50,000 on 2026-12-31?", 50000, "above"],
  ["Will ETH drop to $1000 in 2026?", 1000, "touch_below"],
  ["Will BTC dip below $30k?", 30000, "below"],
  ["ETF approval in 2024 push BTC above $50k", 50000, "above"],
  ["Will BTC hit 2000?", null, "-"],
  ["Will BTC hit $2000?", 2000, "touch"],
  ["Will BTC be above $90k and below $100k?", null, "ambiguous range"],
  ["Will SOL reach $500 or ETH reach $10000?", null, "two assets"],
  ["Will Bitcoin dominance rise above 60%?", null, "percent not USD"],
  ["Will BTC close above $80k for 5 days?", null, "5 vs 80000"],
];
for (const [q, expectVal, expectMode] of cases) {
  const p = parseThresholdMarket(q);
  const got = p ? `${p.coin} ${p.thresholdUsd} ${p.mode}` : "null";
  console.log(`  expect ${String(expectVal).padEnd(7)}|${String(expectMode).padEnd(16)} got ${got.padEnd(22)} "${q.slice(0, 44)}"`);
}

console.log("");
console.log("=== yearsToExpiry on hostile dates ===");
for (const d of ["not-a-date", "2026-02-30", "", "1970-01-01", 8.64e15 + 1, NaN, "9999-12-31"]) {
  console.log("  ", JSON.stringify(d), "->", yearsToExpiry(d, Date.parse("2026-07-26")));
}

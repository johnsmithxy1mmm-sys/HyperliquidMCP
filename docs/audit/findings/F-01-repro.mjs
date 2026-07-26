/**
 * Reproducer F-01: hl_polymarket_divergence must not fabricate an opportunity
 * from a question that is not a USD price threshold.
 *
 * Before the fix, "Will Bitcoin dominance rise above 60%?" parsed as a $60 BTC
 * threshold. Against $90,000 spot that gives P=1.0 and a -50pp "edge" which
 * ranked FIRST and went into the summary as "Top". Structural, not incidental:
 * the more absurd the misparse, the further the threshold from spot, the closer
 * the probability to 0 or 1, and the higher it sorts — because the ranking is
 * by |edge| descending. The worst readings were promoted to the top.
 *
 * Runs the REAL tool against a local mock Gamma API and a stub Hyperliquid
 * client. No outbound network.
 */
import http from "node:http";

const BASE = "/home/user/Polymarket-Mint-Bot/hypersignal-mcp/dist";

const mk = (question, yesProb, liq) => ({
  question,
  slug: question.toLowerCase().replace(/\W+/g, "-").slice(0, 40),
  endDate: "2026-12-31T00:00:00Z",
  active: true,
  closed: false,
  outcomes: '["Yes","No"]',
  outcomePrices: `["${yesProb}","${(1 - yesProb).toFixed(2)}"]`,
  liquidityNum: liq,
  volumeNum: liq * 5,
});

const MARKETS = [
  mk("Will Bitcoin dominance rise above 60%?", 0.5, 900000), // not a price
  mk("Will BTC market cap exceed 2 trillion?", 0.5, 850000), // not a price
  mk("Will BTC reach $500 or ETH reach $10000?", 0.5, 840000), // two assets
  mk("Will BTC be above $90,000 and below $100,000?", 0.5, 830000), // a range
  mk("Will BTC be above $150,000 on Dec 31 2026?", 0.25, 800000), // legitimate
];

const srv = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(MARKETS));
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const gammaUrl = `http://127.0.0.1:${srv.address().port}`;

const closes = [];
let px = 90000;
for (let i = 0; i < 40; i++) {
  px *= 1 + (i % 2 === 0 ? 0.01 : -0.0098);
  closes.push(px);
}
const ctx = {
  config: { polymarket: { gammaUrl }, requestTimeoutMs: 5000 },
  hl: {
    metaAndAssetCtxs: async () => [
      { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 50 }] },
      [{ markPx: "90000", oraclePx: "90000", midPx: "90000", funding: "0.00001", openInterest: "1", dayNtlVlm: "1", prevDayPx: "89000" }],
    ],
    candles: async () =>
      closes.map((c, i) => ({ t: i * 86400000, o: String(c), h: String(c), l: String(c), c: String(c), v: "1", n: 1 })),
  },
};

const { polymarketDivergence } = await import(`${BASE}/tools/premium/polymarketDivergence.js`);
const out = await polymarketDivergence.run({ coin: "BTC", minEdge: 0.05, limit: 10 }, ctx);
srv.close();

console.log("Spot: $90,000. Five markets offered, only ONE is a real price threshold.");
console.log("");
console.log("SUMMARY THE AGENT RECEIVES:");
console.log("  " + out.summary);
console.log("");
console.log("RANKED OUTPUT:");
if (out.data.divergences.length === 0) console.log("  (none)");
out.data.divergences.forEach((d, i) =>
  console.log(`  #${i + 1} edge=${(d.edge * 100).toFixed(1)}pp threshold=$${d.thresholdUsd} "${d.question}"`),
);

const qs = out.data.divergences.map((d) => d.question);
let pass = 0;
let total = 0;
const check = (label, cond) => {
  total++;
  if (cond) pass++;
  console.log(`  ${cond ? "PASS" : "FAIL"} ${label}`);
};

console.log("");
check("dominance question not priced", !qs.some((q) => /dominance/i.test(q)));
check("market cap question not priced", !qs.some((q) => /market cap/i.test(q)));
check("two-asset question not priced", !qs.some((q) => /or ETH/i.test(q)));
check("range question not priced", !qs.some((q) => /and below/i.test(q)));
check("legitimate threshold still surfaced", qs.some((q) => /\$150,000/.test(q)));
check("no threshold implausible vs spot survived", out.data.divergences.every((d) => d.thresholdUsd / 90000 <= 20 && 90000 / d.thresholdUsd <= 20));

console.log("");
console.log(`${pass}/${total} checks pass`);

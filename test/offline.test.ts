/**
 * Offline unit tests for pure logic (no Hyperliquid network needed).
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatPrice,
  formatSize,
  actionHash,
  signL1Action,
  addressForKey,
  feeRateToPercentString,
} from "../src/trading/signing.js";
import { sharpe, sortino, maxDrawdown, annualizeHourlyFunding, paginate, round, shortHash } from "../src/core/format.js";
import { assertExchangeOk, TradingService } from "../src/trading/exchange.js";
import { getDb, upsertKey, getKey, disableMissingBootstrapKeys } from "../src/billing/db.js";
import type { Config } from "../src/config.js";
import { HyperliquidClient } from "../src/core/hlClient.js";
import { RateLimiter } from "../src/core/rateLimiter.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planTwap, planIceberg, planMirror } from "../src/execution/plan.js";
import { evaluateAlert } from "../src/alerts/evaluate.js";
import type { AlertRecord } from "../src/alerts/types.js";
import { SignalSigner, canonicalize } from "../src/signals/signer.js";
import { createPublicKey, verify as edVerify } from "node:crypto";
import { scoreTrader, labelTrader } from "../src/smartmoney/score.js";
import type { TraderProfile } from "../src/smartmoney/profile.js";
import { cosineSimilarity, detectCoordination, type WalletVector } from "../src/smartmoney/coordination.js";
import { normCdf, annualizedVol, probAboveAtExpiry, probTouchAbove, probTouchBelow, impliedProbForMode } from "../src/polymarket/pricing.js";
import { parseThresholdMarket, parseThresholdUsd, yearsToExpiry, isPlausibleThreshold } from "../src/polymarket/parse.js";
import BetterSqlite3 from "better-sqlite3";
import { collectAdminStats, currentPeriod } from "../src/admin/stats.js";
import { rankCohort, pnlForWindow } from "../src/hl/cohortRank.js";
import { calibrate, spearman, rankWithTies, spearmanPValue } from "../src/smartmoney/calibration.js";
import { ScoreStore, MAX_RESOLVE_ATTEMPTS, SCORE_HORIZON_DAYS } from "../src/store/scoreStore.js";
import { scoreTolerangeMs } from "../src/store/signalStore.js";
import { ScoreSampler } from "../src/smartmoney/scoreSampler.js";
import type { ToolContext } from "../src/tools/registry.js";
import { aggregateByCoin, type CohortAccount } from "../src/hl/whales.js";
import { clampFee } from "../src/config.js";
import { TtlLruCache } from "../src/core/cache.js";
import { InMemorySnapshotStore } from "../src/core/snapshots.js";
import { AlertEngine } from "../src/alerts/engine.js";
import type { Warehouse } from "../src/store/warehouse.js";
import { resolveTarget } from "../apify-actor/target.js";
import { createAlert } from "../src/tools/premium/alerts.js";
import { registerTool, type ToolDef } from "../src/tools/registry.js";
import { BillingService } from "../src/billing/service.js";
import { ToolError, UpstreamError } from "../src/core/errors.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import express from "express";
import type { AddressInfo } from "node:net";
import { ipBucket, TRUST_PROXY_SETTING } from "../src/core/clientIp.js";
import { requestFreeKey } from "../src/tools/free/requestFreeKey.js";
import { whaleFlowAlerts } from "../src/tools/premium/whaleFlowAlerts.js";
import { whalePositions } from "../src/tools/premium/whalePositions.js";
import { smartMoneyScore } from "../src/tools/premium/smartMoney.js";
import { twapOrder, cancelExecution, copyWallet } from "../src/tools/trading/execution.js";
import { ExecutionRunner } from "../src/execution/runner.js";
import { traderReport } from "../src/tools/premium/traderReport.js";
import { hip3Analytics } from "../src/tools/premium/hip3Analytics.js";
import { PolymarketClient } from "../src/polymarket/client.js";
import { vaultScreener } from "../src/tools/premium/vaultScreener.js";
import { buildPaymentRequirements, verifyPayment } from "../src/billing/x402.js";

test("formatSize rounds to szDecimals", () => {
  assert.equal(formatSize(1.23456789, 3), "1.235");
  assert.equal(formatSize(10, 2), "10");
  assert.equal(formatSize(0.5, 4), "0.5");
});

test("formatPrice: integers pass through, else 5 sig figs & decimal cap", () => {
  assert.equal(formatPrice(65000, 3), "65000");
  assert.equal(formatPrice(1234.5678, 3), "1234.6"); // 5 sig figs, maxDecimals=3
  assert.equal(formatPrice(0.0012345, 2), "0.0012"); // maxDecimals=4
});

test("actionHash is deterministic and sensitive to inputs", () => {
  const action = { type: "order", orders: [{ a: 0, b: true, p: "100", s: "1", r: false, t: { limit: { tif: "Gtc" } } }], grouping: "na" };
  const h1 = actionHash(action, null, 1700000000000);
  const h2 = actionHash(action, null, 1700000000000);
  const h3 = actionHash(action, null, 1700000000001);
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.match(h1, /^0x[0-9a-f]{64}$/);
});

test("signL1Action produces a valid r/s/v signature", async () => {
  // Well-known test private key (Hardhat account #0) — NOT a real funded key.
  const pk = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const action = { type: "cancel", cancels: [{ a: 0, o: 123 }] };
  const sig = await signL1Action(pk, action, 1700000000000, true, null);
  assert.match(sig.r, /^0x[0-9a-f]{64}$/);
  assert.match(sig.s, /^0x[0-9a-f]{64}$/);
  assert.ok(sig.v === 27 || sig.v === 28);
  assert.equal(addressForKey(pk).toLowerCase(), "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
});

test("stats helpers", () => {
  assert.equal(round(annualizeHourlyFunding(0.00001), 6), 0.0876);
  assert.ok(sharpe([1, 1, 1, 1]) === 0); // zero variance
  assert.ok(sharpe([2, -1, 3, -1, 2]) > 0);
  assert.ok(sortino([2, -1, 3, -1, 2]) > 0);
  assert.equal(maxDrawdown([100, 120, 90, 130]), round((120 - 90) / 120, 4));
});

test("paginate slices and reports nextOffset", () => {
  const p = paginate([1, 2, 3, 4, 5], 0, 2);
  assert.deepEqual(p.items, [1, 2]);
  assert.equal(p.nextOffset, 2);
  assert.equal(paginate([1, 2, 3], 2, 5).nextOffset, null);
});

test("paginate tolerates undefined/NaN inputs (direct-call path)", () => {
  const p = paginate([1, 2, 3], undefined, undefined);
  assert.deepEqual(p.items, [1, 2, 3]);
  assert.equal(p.nextOffset, null);
  const q = paginate([1, 2, 3], Number.NaN, Number.NaN);
  assert.deepEqual(q.items, [1, 2, 3]);
});

test("feeRateToPercentString has no float artifacts", () => {
  assert.equal(feeRateToPercentString(5), "0.005%");
  assert.equal(feeRateToPercentString(7), "0.007%"); // 7*0.001 float bug guard
  assert.equal(feeRateToPercentString(100), "0.1%");
  assert.equal(feeRateToPercentString(0), "0%");
});

test("assertExchangeOk accepts real acceptance shapes", () => {
  // resting order + filled order + cancel "success" strings must all pass
  assertExchangeOk({ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 1 } }] } } });
  assertExchangeOk({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "1" } }] } } });
  assertExchangeOk({ status: "ok", response: { type: "cancel", data: { statuses: ["success"] } } });
  assertExchangeOk({ status: "ok", response: { type: "default" } }); // no statuses at all
});

test("assertExchangeOk rejects exchange-level and order-level errors", () => {
  assert.throws(() => assertExchangeOk({ status: "err", response: "Invalid signature" }), /rejected the action/);
  assert.throws(
    () =>
      assertExchangeOk({
        status: "ok",
        response: { type: "order", data: { statuses: [{ error: "Insufficient margin" }] } },
      }),
    /Insufficient margin/,
  );
  assert.throws(() => assertExchangeOk(null), /Empty or non-object/);
  assert.throws(() => assertExchangeOk("ok"), /Empty or non-object/);
});

test("shortHash is stable and compact", () => {
  assert.equal(shortHash("abc"), shortHash("abc"));
  assert.notEqual(shortHash("abc"), shortHash("abd"));
  assert.match(shortHash("0x1,0x2"), /^[0-9a-z]+$/);
});

test("bootstrap keys removed from env are revoked; re-adding re-enables", () => {
  const db = getDb(join(tmpdir(), `hypersignal-test-${Date.now()}.db`));
  upsertKey(db, "hashA", "pro", "pro-bootstrap");
  upsertKey(db, "hashB", "pro", "pro-bootstrap");
  upsertKey(db, "hashC", "pro", "manual"); // non-bootstrap must never be touched

  // env now only contains hashA -> hashB revoked, hashC untouched
  const revoked = disableMissingBootstrapKeys(db, ["hashA"]);
  assert.equal(revoked, 1);
  assert.equal(getKey(db, "hashA")?.disabled, 0);
  assert.equal(getKey(db, "hashB")?.disabled, 1);
  assert.equal(getKey(db, "hashC")?.disabled, 0);

  // re-adding hashB to env re-enables it via upsert
  upsertKey(db, "hashB", "pro", "pro-bootstrap");
  assert.equal(getKey(db, "hashB")?.disabled, 0);
});

test("snapshot store caps total keys (memory bound)", () => {
  const s = new InMemorySnapshotStore();
  for (let i = 0; i < 5_010; i++) s.record("cap", `k${i}`, { v: i });
  const keys = s.keys("cap");
  assert.ok(keys.length <= 5_000, `expected <=5000 keys, got ${keys.length}`);
  assert.ok(keys.includes("k5009")); // newest survive, oldest evicted
  assert.ok(!keys.includes("k0"));
});

test("planTwap splits evenly and sums exactly to totalSize", () => {
  const c = planTwap({ totalSize: 10, slices: 4, durationMs: 3 * 60_000, szDecimals: 5 });
  assert.equal(c.length, 4);
  assert.equal(round(c.reduce((a, x) => a + x.size, 0), 6), 10);
  assert.equal(c[0].atOffsetMs, 0);
  assert.equal(c[3].atOffsetMs, 180_000); // last at full duration
  // rounding drift folded into last slice
  const d = planTwap({ totalSize: 1, slices: 3, durationMs: 0, szDecimals: 5 });
  assert.equal(round(d.reduce((a, x) => a + x.size, 0), 10), 1);
});

test("planIceberg clips to totalSize", () => {
  const c = planIceberg(10, 3);
  assert.deepEqual(c.map((x) => x.size), [3, 3, 3, 1]);
  assert.equal(round(c.reduce((a, x) => a + x.size, 0), 6), 10);
});

test("planMirror scales exposure to equity and preserves direction", () => {
  // $10k mirroring a $1M whale at scale 1 => ~1% of size
  const orders = planMirror(
    [{ coin: "BTC", szi: 10, markPx: 60000 }, { coin: "ETH", szi: -100, markPx: 3000 }],
    10_000,
    1_000_000,
    1,
  );
  const btc = orders.find((o) => o.coin === "BTC");
  const eth = orders.find((o) => o.coin === "ETH");
  assert.ok(btc && btc.isBuy);
  assert.equal(round(btc.size, 4), round(10 * 0.01, 4)); // 1% of 10
  assert.ok(eth && !eth.isBuy); // short preserved
});

test("planMirror emits deltas so repeating a copy does not compound exposure", () => {
  const target = [{ coin: "BTC", szi: 10, markPx: 100_000 }];
  const desired = 0.1; // $10k mirroring a $1M whale at scale 1

  // From flat: open the full mirror.
  const first = planMirror(target, 10_000, 1_000_000, 1, []);
  assert.equal(first.length, 1);
  assert.equal(round(first[0].size, 8), desired);
  assert.equal(first[0].isBuy, true);
  assert.equal(first[0].reduceOnly, false);

  // Already in sync: a repeat call must emit NOTHING. Before the fix this
  // returned the full mirror again and doubled the position.
  const held = [{ coin: "BTC", szi: desired, markPx: 100_000 }];
  assert.deepEqual(planMirror(target, 10_000, 1_000_000, 1, held), []);

  // Partially filled: trade only the remainder.
  const partial = planMirror(target, 10_000, 1_000_000, 1, [{ coin: "BTC", szi: 0.04, markPx: 100_000 }]);
  assert.equal(round(partial[0].size, 8), round(desired - 0.04, 8));
  assert.equal(partial[0].isBuy, true);

  // Overweight: shrink, and mark reduceOnly so it can never grow the position.
  const over = planMirror(target, 10_000, 1_000_000, 1, [{ coin: "BTC", szi: 0.3, markPx: 100_000 }]);
  assert.equal(over[0].isBuy, false);
  assert.equal(round(over[0].size, 8), 0.2);
  assert.equal(over[0].reduceOnly, true);

  // Target exited: unwind our leg instead of stranding it.
  const exited = planMirror([], 10_000, 1_000_000, 1, held);
  assert.equal(exited.length, 1);
  assert.equal(exited[0].isBuy, false);
  assert.equal(round(exited[0].size, 8), desired);
  assert.equal(exited[0].reduceOnly, true);

  // Flip long -> short must NOT be reduceOnly, or the exchange rejects it.
  const flip = planMirror([{ coin: "BTC", szi: -10, markPx: 100_000 }], 10_000, 1_000_000, 1, held);
  assert.equal(flip[0].isBuy, false);
  assert.equal(round(flip[0].size, 8), 0.2); // 0.1 long -> 0.1 short
  assert.equal(flip[0].reduceOnly, false);
});

test("evaluateAlert funding_apr fires on rising edge only, with carry direction", () => {
  const base: AlertRecord = {
    id: "a", subject: "s", type: "funding_apr", params: { coin: "BTC", aprThreshold: 0.5 },
    enabled: true, cooldownMinutes: 60, lastFiredAt: null, lastState: null, createdAt: 0,
  };
  const below = evaluateAlert(base, { now: 1, markPx: 60000, fundingApr: 0.2 });
  assert.equal(below.fired, false);
  const cross = evaluateAlert(base, { now: 2, markPx: 60000, fundingApr: 0.8 });
  assert.equal(cross.fired, true);
  assert.equal(cross.signal?.direction, "short"); // positive funding => fade longs
  // already "over" => no re-fire
  const stayOver = evaluateAlert({ ...base, lastState: { over: true } }, { now: 3, markPx: 60000, fundingApr: 0.9 });
  assert.equal(stayOver.fired, false);
});

test("evaluateAlert whale_net_flip fires only on genuine long<->short flip", () => {
  const a: AlertRecord = {
    id: "w", subject: "s", type: "whale_net_flip", params: { coin: "ETH" },
    enabled: true, cooldownMinutes: 60, lastFiredAt: null, lastState: { sign: 1 }, createdAt: 0,
  };
  const flip = evaluateAlert(a, { now: 1, markPx: 3000, whaleNetNtlUsd: -500000 });
  assert.equal(flip.fired, true);
  assert.equal(flip.signal?.direction, "short");
  const same = evaluateAlert({ ...a, lastState: { sign: -1 } }, { now: 2, markPx: 3000, whaleNetNtlUsd: -400000 });
  assert.equal(same.fired, false);
});

test("SignalSigner produces verifiable Ed25519 signatures; canonicalize is order-independent", () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  const signer = new SignalSigner(); // ephemeral
  const signed = signer.sign({ type: "funding_apr", coin: "BTC", direction: "short", refPx: 60000 }, 123);
  const canonical = canonicalize({ payload: { type: "funding_apr", coin: "BTC", direction: "short", refPx: 60000 }, ts: 123 });
  const pub = createPublicKey({ key: Buffer.from(signed.publicKey, "base64"), format: "der", type: "spki" });
  const ok = edVerify(null, Buffer.from(canonical), pub, Buffer.from(signed.signature, "base64"));
  assert.equal(ok, true);
  // tampered payload fails
  const bad = edVerify(null, Buffer.from(canonical + "x"), pub, Buffer.from(signed.signature, "base64"));
  assert.equal(bad, false);
});

function profile(over: Partial<TraderProfile>): TraderProfile {
  return {
    address: "0xabc", accountValue: 50_000, tradeCount: 50, closedTrades: 40, winratePct: 50,
    avgR: 1, realizedPnl: 1000, pnlSharpe: 1, avgHoldMinutes: 120, distinctCoins: 5,
    topConcentrationPct: 0.3, longShortBalance: 0.5, ...over,
  };
}

test("scoreTrader ranks a big consistent winner above a small lucky one", () => {
  const whale = scoreTrader(profile({ accountValue: 5_000_000, winratePct: 70, pnlSharpe: 2.5, avgR: 2.5, closedTrades: 180 }));
  const small = scoreTrader(profile({ accountValue: 2_000, winratePct: 52, pnlSharpe: 0.3, avgR: 1.1, closedTrades: 8 }));
  assert.ok(whale.score > small.score, `${whale.score} !> ${small.score}`);
  assert.ok(whale.score >= 0 && whale.score <= 100);
  assert.ok(whale.labels.includes("whale") && whale.labels.includes("sharp"));
});

test("labelTrader tags behavior", () => {
  assert.ok(labelTrader(profile({ avgHoldMinutes: 10 })).includes("scalper"));
  assert.ok(labelTrader(profile({ avgHoldMinutes: 3000 })).includes("swing"));
  assert.ok(labelTrader(profile({ realizedPnl: -500 })).includes("underwater"));
  assert.ok(
    labelTrader(profile({ tradeCount: 400, longShortBalance: 0.8, avgHoldMinutes: 20 })).includes("market_maker_like"),
  );
  assert.ok(labelTrader(profile({ distinctCoins: 1, topConcentrationPct: 0.9 })).includes("high_conviction"));
});

test("cosineSimilarity + detectCoordination cluster co-moving wallets", () => {
  const mk = (address: string, e: [string, number][]): WalletVector => ({ address, vec: new Map(e) });
  // A and B mirror each other; C is opposite; D unrelated
  const wallets = [
    mk("A", [["BTC", 0.6], ["ETH", 0.3], ["SOL", 0.1]]),
    mk("B", [["BTC", 0.62], ["ETH", 0.28], ["SOL", 0.1]]),
    mk("C", [["BTC", -0.6], ["ETH", -0.3], ["SOL", -0.1]]),
    mk("D", [["SOL", 1]]),
  ];
  assert.ok(cosineSimilarity(wallets[0].vec, wallets[1].vec) > 0.99);
  assert.ok(cosineSimilarity(wallets[0].vec, wallets[2].vec) < 0); // opposite
  const { clusters, pairs } = detectCoordination(wallets, 0.9);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].sort(), ["A", "B"]);
  assert.equal(pairs[0].a === "A" || pairs[0].b === "A", true);
});

test("normCdf matches known values", () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(normCdf(-1.96) - 0.025) < 1e-3);
});

test("annualizedVol is positive and scales with periods", () => {
  const closes = [100, 101, 99, 102, 98, 103, 97];
  const v = annualizedVol(closes, 365);
  assert.ok(v > 0);
  assert.equal(annualizedVol([100], 365), 0); // insufficient data
});

test("threshold probabilities behave monotonically", () => {
  // at expiry: prob(above) rises as S approaches/exceeds K
  const low = probAboveAtExpiry(90000, 100000, 0.25, 0.6);
  const high = probAboveAtExpiry(99000, 100000, 0.25, 0.6);
  assert.ok(high > low);
  assert.ok(low >= 0 && high <= 1);
  // touch prob >= at-expiry prob for an upper barrier (can hit then fall back)
  const touch = probTouchAbove(90000, 100000, 0.25, 0.6);
  assert.ok(touch >= low - 1e-9);
  // already above => certain
  assert.equal(probTouchAbove(101000, 100000, 0.25, 0.6), 1);
  // T=0 deterministic
  assert.equal(probAboveAtExpiry(101000, 100000, 0, 0.6), 1);
  assert.equal(probAboveAtExpiry(99000, 100000, 0, 0.6), 0);
});

test("impliedProbForMode dispatches; below = 1 - above", () => {
  const above = probAboveAtExpiry(95000, 100000, 0.5, 0.5);
  assert.ok(Math.abs(impliedProbForMode("below", 95000, 100000, 0.5, 0.5) - (1 - above)) < 1e-9);
  assert.equal(impliedProbForMode("above", 95000, 100000, 0.5, 0.5), above);
});

test("parseThresholdMarket extracts asset, threshold, and mode", () => {
  const a = parseThresholdMarket("Will Bitcoin reach $150,000 by December 31, 2025?");
  assert.equal(a?.coin, "BTC");
  assert.equal(a?.thresholdUsd, 150000);
  assert.equal(a?.mode, "touch");
  const b = parseThresholdMarket("Will Ethereum be above $4k on Jan 1?");
  assert.equal(b?.coin, "ETH");
  assert.equal(b?.thresholdUsd, 4000);
  assert.equal(b?.mode, "above");
  const c = parseThresholdMarket("Will Solana fall below $100 this year?");
  assert.equal(c?.coin, "SOL");
  assert.equal(c?.mode, "below");
  assert.equal(parseThresholdMarket("Who wins the 2028 election?"), null);
});

test("parseThresholdMarket refuses questions that are not single USD price thresholds", () => {
  // These are the misparses that hurt most: they yield a probability of exactly
  // 0 or 1, therefore the largest possible |edge|, and the tool ranks by |edge|
  // — so a misread outranks every genuine opportunity and lands in the summary.
  assert.equal(parseThresholdMarket("Will Bitcoin dominance rise above 60%?"), null);
  assert.equal(parseThresholdMarket("Will BTC market cap exceed 2 trillion?"), null);
  assert.equal(parseThresholdMarket("Will Bitcoin hashrate exceed 800 EH/s?"), null);
  assert.equal(parseThresholdMarket("Will ETH staked supply pass 40 million?"), null);
  // Two assets: we cannot tell which the threshold belongs to.
  assert.equal(parseThresholdMarket("Will SOL reach $500 or ETH reach $10000?"), null);
  // A range is not a single-threshold event.
  assert.equal(parseThresholdMarket("Will BTC be above $90k and below $100k?"), null);

  // Genuine thresholds must still parse — the guard must not be a blanket ban.
  assert.equal(parseThresholdMarket("Will BTC be above $150,000 on Dec 31 2026?")?.thresholdUsd, 150000);
  assert.equal(parseThresholdMarket("Will ETH reach $10k by June?")?.mode, "touch");
});

test("isPlausibleThreshold rejects thresholds orders of magnitude from spot", () => {
  // $60 against $90,000 spot is the dominance misparse; P collapses to 1.0.
  assert.equal(isPlausibleThreshold(60, 90_000), false);
  assert.equal(isPlausibleThreshold(2_000_000, 90_000), false);
  // Real threshold markets sit within a few multiples of spot, either side.
  assert.equal(isPlausibleThreshold(150_000, 90_000), true);
  assert.equal(isPlausibleThreshold(45_000, 90_000), true);
  assert.equal(isPlausibleThreshold(1_500_000, 90_000, 20), true); // exactly at the bound
  // Degenerate inputs are not plausible.
  assert.equal(isPlausibleThreshold(0, 90_000), false);
  assert.equal(isPlausibleThreshold(100, 0), false);
  assert.equal(isPlausibleThreshold(NaN, 90_000), false);
});

test("parseThresholdUsd honors suffixes", () => {
  assert.equal(parseThresholdUsd("$120k"), 120000);
  assert.equal(parseThresholdUsd("1.2M"), 1200000);
  assert.equal(parseThresholdUsd("$100,000"), 100000);
});

test("yearsToExpiry non-negative", () => {
  assert.ok(yearsToExpiry(Date.now() + 365 * 86400000) > 0.99);
  assert.equal(yearsToExpiry(Date.now() - 1000), 0);
  assert.equal(yearsToExpiry(undefined), 0);
});

test("canonicalize preserves repeated (non-cyclic) references", () => {
  const shared = { x: 1 };
  const s = canonicalize({ a: shared, b: shared });
  assert.equal(s, '{"a":{"x":1},"b":{"x":1}}'); // not null for the second ref
  // genuine cycle degrades to null instead of blowing the stack
  const cyc: Record<string, unknown> = {};
  cyc.self = cyc;
  assert.equal(canonicalize(cyc), '{"self":null}');
});

test("parseThresholdUsd skips bare years and prefers $/suffixed values", () => {
  assert.equal(parseThresholdUsd("Will Bitcoin ETF approval in 2024 push BTC above $50k?"), 50000);
  assert.equal(parseThresholdUsd("above 100000 by March 5"), 100000); // larger wins at equal score
  assert.equal(parseThresholdUsd("in 2025"), null); // year alone is not a price
  assert.equal(parseThresholdUsd("Will ETH hit $1.5M market cap... no, price $1.5k?"), 1500000); // $ + suffix priority, larger tie-break
  assert.equal(parseThresholdUsd("$100,000 by December 31, 2025"), 100000); // comma number beats day/skips year
});

test("parseThresholdMarket detects touch_below for downward reach-verbs", () => {
  const a = parseThresholdMarket("Will Bitcoin drop to $70k by June?");
  assert.equal(a?.mode, "touch_below");
  assert.equal(a?.thresholdUsd, 70000);
  const b = parseThresholdMarket("Will Solana be below $100 at year end?");
  assert.equal(b?.mode, "below"); // plain below stays at-expiry
});

test("probTouchBelow: certain when already below, >= at-expiry prob otherwise", () => {
  assert.equal(probTouchBelow(99000, 100000, 0.25, 0.6), 1);
  const touch = probTouchBelow(110000, 100000, 0.25, 0.6);
  const atExpiry = impliedProbForMode("below", 110000, 100000, 0.25, 0.6);
  assert.ok(touch >= atExpiry - 1e-9);
  assert.ok(touch > 0 && touch <= 1);
  assert.equal(impliedProbForMode("touch_below", 99000, 100000, 0.25, 0.6), 1);
});

test("planTwap never emits non-positive slices, indices contiguous", () => {
  const c = planTwap({ totalSize: 0.1, slices: 3, durationMs: 60000, szDecimals: 5 });
  assert.ok(c.every((x) => x.size > 0));
  assert.deepEqual(c.map((x) => x.index), c.map((_, i) => i));
  assert.ok(Math.abs(c.reduce((a, x) => a + x.size, 0) - 0.1) < 1e-9);
});

test("collectAdminStats aggregates per-key usage, tool totals, and x402 counts", () => {
  // Fresh in-memory db with just the tables the collector reads — isolated
  // from the module-level getDb() singleton other tests exercise.
  const db = new BetterSqlite3(":memory:");
  db.exec(`
    CREATE TABLE api_keys (key_hash TEXT PRIMARY KEY, tier TEXT, label TEXT, created_at INTEGER, disabled INTEGER);
    CREATE TABLE usage_counters (key_hash TEXT, period TEXT, tool TEXT, count INTEGER, PRIMARY KEY (key_hash, period, tool));
    CREATE TABLE x402_payments (payment_id TEXT PRIMARY KEY, created_at INTEGER);
  `);
  const now = Date.now();
  const period = currentPeriod(now);

  db.prepare(`INSERT INTO api_keys VALUES (?,?,?,?,?)`).run("hashA".padEnd(64, "0"), "pro", "pro-bootstrap", now, 0);
  db.prepare(`INSERT INTO api_keys VALUES (?,?,?,?,?)`).run("hashB".padEnd(64, "0"), "free", "free-bootstrap", now, 0);
  db.prepare(`INSERT INTO usage_counters VALUES (?,?,?,?)`).run("hashA".padEnd(64, "0"), period, "hl_funding_screener", 10);
  db.prepare(`INSERT INTO usage_counters VALUES (?,?,?,?)`).run("hashA".padEnd(64, "0"), period, "hl_whale_positions", 3);
  db.prepare(`INSERT INTO usage_counters VALUES (?,?,?,?)`).run("hashB".padEnd(64, "0"), period, "hl_funding_screener", 2);
  db.prepare(`INSERT INTO x402_payments VALUES (?,?)`).run("pay1", now - 86_400_000); // 1 day ago
  db.prepare(`INSERT INTO x402_payments VALUES (?,?)`).run("pay2", now - 40 * 86_400_000); // 40 days ago (outside 30d window)

  const stats = collectAdminStats(db, period, now);

  assert.equal(stats.totalKeys, 2);
  assert.equal(stats.totalCallsThisPeriod, 15);
  assert.equal(stats.toolTotalsThisPeriod[0].tool, "hl_funding_screener");
  assert.equal(stats.toolTotalsThisPeriod[0].count, 12); // 10 + 2 across both keys

  const keyA = stats.keys.find((k) => k.keyHashPrefix === "hashA".padEnd(64, "0").slice(0, 10));
  assert.equal(keyA?.callsThisPeriod, 13);
  assert.equal(keyA?.topTools[0].tool, "hl_funding_screener");

  assert.equal(stats.x402PaymentsTotal, 2);
  assert.equal(stats.x402PaymentsLast30d, 1); // only pay1 within 30 days
});

test("rankCohort dedupes, filters dust, and ranks by the chosen strategy", () => {
  const rows = [
    { ethAddress: "0x" + "a".repeat(40), accountValue: "5000000",
      windowPerformances: [["month", { pnl: "10000" }], ["allTime", { pnl: "50000" }]] },
    // dust account with a huge relative PnL — must not outrank the real desk
    { ethAddress: "0x" + "b".repeat(40), accountValue: "300",
      windowPerformances: [["month", { pnl: "900000" }]] },
    { address: "0x" + "c".repeat(40), accountValue: "1000000",
      windowPerformances: [["month", { pnl: "250000" }]] },
    { ethAddress: "0x" + "a".repeat(40), accountValue: "5000000" }, // duplicate
    { ethAddress: "not-an-address", accountValue: "9999999" },      // invalid
  ];

  const byEquity = rankCohort(rows, { strategy: "accountValue", minAccountValue: 50_000 });
  assert.deepEqual(byEquity.map((w) => w.address), ["0x" + "a".repeat(40), "0x" + "c".repeat(40)]);

  const byPnl = rankCohort(rows, { strategy: "pnlMonth", minAccountValue: 50_000 });
  assert.equal(byPnl[0].address, "0x" + "c".repeat(40)); // 250k > 10k
  assert.ok(!byPnl.some((w) => w.address === "0x" + "b".repeat(40)), "dust must be filtered");

  assert.equal(rankCohort(rows, { topN: 1, minAccountValue: 50_000 }).length, 1);
});

test("pnlForWindow tolerates missing/misshapen payloads", () => {
  assert.equal(pnlForWindow({ windowPerformances: [["month", { pnl: "42" }]] }, "month"), 42);
  assert.equal(pnlForWindow({ windowPerformances: [["day", { pnl: "42" }]] }, "month"), 0);
  assert.equal(pnlForWindow({}, "month"), 0);
  assert.equal(pnlForWindow({ windowPerformances: "garbage" }, "month"), 0);
});

test("rankWithTies averages tied ranks", () => {
  assert.deepEqual(rankWithTies([10, 20, 20, 30]), [1, 2.5, 2.5, 4]);
});

test("spearman detects monotone relationships regardless of linearity", () => {
  const x = [1, 2, 3, 4, 5, 6, 7, 8];
  assert.equal(spearman(x, x.map((v) => v ** 3)), 1);      // perfectly monotone, non-linear
  assert.equal(spearman(x, x.map((v) => -v)), -1);
  assert.equal(spearman([1, 2, 3], [1, 2, 3]), null);      // n < 4
});

test("calibrate is honest when evidence is thin and positive when it is strong", () => {
  assert.equal(calibrate([]).verdict, "insufficient_data");
  assert.equal(calibrate([{ score: 1, forwardReturn: 1 }]).verdict, "insufficient_data");

  // 40 observations where score tracks outcome => should register as positive
  const strong = Array.from({ length: 40 }, (_, i) => ({ score: i, forwardReturn: i * 100 }));
  const good = calibrate(strong);
  assert.equal(good.verdict, "positive");
  assert.ok((good.spearman ?? 0) > 0.9);
  assert.ok((good.pValue ?? 1) < 0.05);
  assert.equal(good.quartiles.length, 4);
  // quartiles must be ordered lowest-score-first with rising outcomes
  assert.ok(good.quartiles[3].meanForwardReturn > good.quartiles[0].meanForwardReturn);

  // score unrelated to outcome => must NOT claim predictive power
  const noise = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7, 9, 3, 2, 3, 8, 4,
                 6, 2, 6, 4, 3, 3, 8, 3, 2, 7, 9, 5, 0, 2, 8, 8, 4, 1, 9, 7];
  const flat = calibrate(noise.map((v, i) => ({ score: i, forwardReturn: v })));
  assert.notEqual(flat.verdict, "positive");
});

test("spearman p-value matches reference values (not their complement)", () => {
  // Reference two-sided p-values for the Student-t approximation. The earlier
  // incomplete-beta symmetry handling returned 1-p, which made a significant
  // result indistinguishable from pure noise and could never reach `positive`.
  const cases: Array<[number, number, number]> = [
    [0.5, 30, 0.0049],
    [0.3, 30, 0.1072],
    [0.2, 30, 0.2893],
    [0.8, 12, 0.0018],
    [0.25, 100, 0.0121],
    [0.05, 50, 0.7302],
  ];
  for (const [r, n, expected] of cases) {
    const p = spearmanPValue(r, n);
    assert.ok(p !== null, `p should exist for n=${n}`);
    assert.ok(
      Math.abs((p as number) - expected) < Math.max(0.001, expected * 0.05),
      `r=${r} n=${n}: got ${p}, expected ≈${expected}`,
    );
  }
  assert.equal(spearmanPValue(0.5, 8), null); // n < 10
  // A p-value must never be reported as the complement of itself.
  assert.ok((spearmanPValue(0.9, 40) as number) < 0.01);
});

test("calibrate reports an inverted score instead of hiding it as no_evidence", () => {
  // Score perfectly ANTI-correlated with outcome: a finding, not an absence.
  const inverted = Array.from({ length: 40 }, (_, i) => ({ score: i, forwardReturn: -i * 100 }));
  const report = calibrate(inverted);
  assert.equal(report.verdict, "inverted");
  assert.ok((report.spearman ?? 0) < -0.9);
});

test("score store abandons unresolvable rows instead of blocking the queue", () => {
  const db = new BetterSqlite3(":memory:");
  const store = new ScoreStore(db);
  const day = 86_400_000;

  // A poison row that will never resolve, recorded before a healthy one.
  store.record({ address: "0xbad", score: 10, accountValue: 1, horizonDays: 1, ts: 1000 });
  store.record({ address: "0xgood", score: 20, accountValue: 1, horizonDays: 1, ts: 2000 });
  const now = 5 * day;

  // Oldest-first, so the poison row is served first.
  const first = store.due(1, now);
  assert.equal(first[0].address, "0xbad");

  // One failure is enough to send it behind untried rows: ordering is by
  // attempts before age, so a failing row can never hold the head of the queue.
  store.markAttempt(first[0].id);
  assert.equal(store.due(1, now)[0].address, "0xgood");

  // Once its attempt budget is spent it drops out of the queue entirely.
  const poisonId = first[0].id;
  for (let i = 1; i < MAX_RESOLVE_ATTEMPTS; i++) store.markAttempt(poisonId);
  const remaining = store.due(10, now);
  assert.deepEqual(remaining.map((r) => r.address), ["0xgood"]);
  assert.equal(store.abandoned(), 1);
});

test("score sampler walks the server cohort once per day and never a caller's", async () => {
  const db = new BetterSqlite3(":memory:");
  const scores = new ScoreStore(db);
  const day = 86_400_000;
  const now = 100 * day;

  const cohortAddresses = [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
    "0x3333333333333333333333333333333333333333",
  ];
  let fillsCalls = 0;

  const ctx = {
    // No leaderboard configured => resolveCohort must fall back to the env list,
    // which is a server-selected source and therefore eligible for the sample.
    config: { whaleAddresses: cohortAddresses, leaderboardUrl: undefined, requestTimeoutMs: 1000 },
    hl: {
      userFillsByTime: async () => {
        fillsCalls++;
        return [];
      },
      clearinghouseState: async () => ({
        marginSummary: { accountValue: "250000", totalNtlPos: "0", totalRawUsd: "0", totalMarginUsed: "0" },
        crossMarginSummary: { accountValue: "250000", totalNtlPos: "0", totalRawUsd: "0", totalMarginUsed: "0" },
        crossMaintenanceMarginUsed: "0",
        withdrawable: "250000",
        assetPositions: [],
      }),
    },
    store: { cohort: { get: () => null }, scores },
  } as unknown as ToolContext;

  const sampler = new ScoreSampler(ctx);

  const first = await sampler.runOnce(now);
  assert.equal(first.skipped, false);
  assert.equal(first.sampled, 3);
  assert.equal(scores.counts().total, 3);
  assert.equal(fillsCalls, 3);

  // Same UTC day => no second walk, and crucially no repeat API traffic.
  const second = await sampler.runOnce(now + 3600_000);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "already_sampled_today");
  assert.equal(fillsCalls, 3);

  // Next day it samples again, into the same horizon the tool writes to.
  const third = await sampler.runOnce(now + day);
  assert.equal(third.sampled, 3);
  assert.equal(scores.counts().total, 6);
  assert.ok(scores.hasSampleForDay(SCORE_HORIZON_DAYS, now + day));
});

test("score sampler reports a missing cohort instead of throwing", async () => {
  const db = new BetterSqlite3(":memory:");
  const ctx = {
    config: { whaleAddresses: [], leaderboardUrl: undefined, requestTimeoutMs: 1000 },
    hl: {},
    store: { cohort: { get: () => null }, scores: new ScoreStore(db) },
  } as unknown as ToolContext;

  const res = await new ScoreSampler(ctx).runOnce(0);
  assert.equal(res.skipped, true);
  assert.equal(res.sampled, 0);
});

test("reliable alert polling redelivers until acked; autoAck stays at-most-once", async () => {
  const { AlertStore } = await import("../src/store/alertStore.js");
  const db = new BetterSqlite3(":memory:");
  const store = new AlertStore(db);
  const a = store.create("subj", "price_move", { coin: "BTC" }, 60);
  store.recordFired(a.id, "subj", Date.now(), "m1", {});
  store.recordFired(a.id, "subj", Date.now(), "m2", {});

  // Reliable mode: same events come back until acknowledged — a response lost
  // in transit is retried, not lost.
  const first = store.pollUnacked("subj", 50, false);
  assert.equal(first.length, 2);
  const again = store.pollUnacked("subj", 50, false);
  assert.deepEqual(again.map((e) => e.id), first.map((e) => e.id));

  // Watermark ack clears everything at or below the id.
  const acked = store.ackThrough("subj", first[first.length - 1].id);
  assert.equal(acked, 2);
  assert.equal(store.pollUnacked("subj", 50, false).length, 0);

  // autoAck (default): read once, gone — documented at-most-once.
  store.recordFired(a.id, "subj", Date.now(), "m3", {});
  assert.equal(store.pollUnacked("subj", 50, true).length, 1);
  assert.equal(store.pollUnacked("subj", 50, true).length, 0);

  // Ownership isolation: another subject's watermark acks nothing.
  store.recordFired(a.id, "subj", Date.now(), "m4", {});
  assert.equal(store.ackThrough("other", 999_999), 0);
  assert.equal(store.pollUnacked("subj", 50, false).length, 1);
});

test("self-serve free key: one active key per fingerprint, re-issue is not a quota reset", async () => {
  const { getFreeKeyGrant, recordFreeKeyGrant, incrementUsage, monthlyTotal, upsertKey, getKey } = await import(
    "../src/billing/db.js"
  );
  const db = new BetterSqlite3(":memory:");
  db.exec(`
    CREATE TABLE api_keys (key_hash TEXT PRIMARY KEY, tier TEXT NOT NULL, label TEXT, created_at INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE usage_counters (key_hash TEXT NOT NULL, period TEXT NOT NULL, tool TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (key_hash, period, tool));
    CREATE TABLE free_key_grants (fingerprint TEXT PRIMARY KEY, key_hash TEXT NOT NULL, granted_at INTEGER NOT NULL, grants INTEGER NOT NULL DEFAULT 1);
  `);
  const fp = "fingerprint-a";

  upsertKey(db, "hash1", "free", "self-serve");
  recordFreeKeyGrant(db, fp, "hash1");
  // Burn 40 of the monthly allowance on the first key.
  for (let i = 0; i < 40; i++) incrementUsage(db, "hash1", "2026-07", "hl_whale_positions");
  assert.equal(monthlyTotal(db, "hash1", "2026-07"), 40);

  // Re-issue: the old key must die and its usage must follow the new key,
  // otherwise "lose your key, ask again" mints unlimited fresh allowances.
  upsertKey(db, "hash2", "free", "self-serve");
  recordFreeKeyGrant(db, fp, "hash2");

  assert.equal(getKey(db, "hash1"), undefined, "old key must be removed, not left behind as a dead row");
  assert.equal(getKey(db, "hash2")?.disabled, 0, "new key must be active");
  assert.equal(monthlyTotal(db, "hash2", "2026-07"), 40, "usage must carry over");
  assert.equal(monthlyTotal(db, "hash1", "2026-07"), 0);

  const grant = getFreeKeyGrant(db, fp);
  assert.equal(grant?.keyHash, "hash2");
  assert.equal(grant?.grants, 2, "grant count tracks re-issues");

  // A different fingerprint is independent.
  upsertKey(db, "hash3", "free", "self-serve");
  recordFreeKeyGrant(db, "fingerprint-b", "hash3");
  assert.equal(monthlyTotal(db, "hash3", "2026-07"), 0);
  assert.equal(getKey(db, "hash2")?.disabled, 0, "another requester must not revoke this one");
});

test("track record excludes late-scored signals and classifies legacy rows", async () => {
  const { SignalStore } = await import("../src/store/signalStore.js");
  const DAY = 86_400_000;
  const t0 = 1_780_272_000_000;

  // A row scored on time and a row scored 30 days late, both written under the
  // old schema. Lateness is recoverable from scored_at, so the migration can
  // classify history precisely instead of discarding it.
  const db = new BetterSqlite3(":memory:");
  db.exec(`CREATE TABLE signals (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, coin TEXT NOT NULL, direction TEXT NOT NULL,
    ref_px REAL NOT NULL, ts INTEGER NOT NULL, horizon_minutes INTEGER NOT NULL, signature TEXT,
    scored_at INTEGER, scored_px REAL, forward_return REAL);`);
  const ins = db.prepare(
    `INSERT INTO signals (id,type,coin,direction,ref_px,ts,horizon_minutes,signature,scored_at,scored_px,forward_return)
     VALUES (?,?,?,?,?,?,?,NULL,?,?,?)`,
  );
  ins.run("ontime", "whale_net_flip", "BTC", "long", 100_000, t0, 1440, t0 + DAY + 30_000, 102_000, 0.02);
  ins.run("late", "whale_net_flip", "BTC", "long", 100_000, t0, 1440, t0 + 30 * DAY, 160_000, 0.6);

  const store = new SignalStore(db);
  const rec = store.trackRecord()[0];

  // The +60% thirty-day drift must not be published as a 24h forward return.
  assert.equal(rec.scored, 1);
  assert.equal(rec.avgReturnPct, 2);
  assert.equal(rec.excludedStale, 1);
  assert.equal(rec.total, 2);
  // History is preserved on disk, only demoted in the statistics.
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM signals`).get() as { c: number }).c, 2);

  // markStale closes a row out without letting it into the numbers.
  const id = store.record({
    type: "price_move", coin: "ETH", direction: "long", refPx: 1000, horizonMinutes: 60, ts: t0,
  });
  store.markStale(id, t0 + 10 * DAY);
  const eth = store.trackRecord().find((r) => r.type === "price_move");
  assert.equal(eth?.scored, 0);
  assert.equal(eth?.excludedStale, 1);
  // ...and it is no longer retried forever.
  assert.equal(store.dueForScoring(t0 + 20 * DAY).some((s) => s.id === id), false);
});

test("INV-S8: hlClient cache must not hand out arrays callers can sort in place", async () => {
  // The cache returns values BY REFERENCE. Four tools used to sort them in
  // place, reordering shared state under any concurrent reader of the same
  // entry. This locks in that a cached array survives a caller mutating its
  // own copy — the discipline the fix relies on.
  const cache = new TtlLruCache();
  const original = [{ t: 3 }, { t: 1 }, { t: 2 }];
  const first = await cache.getOrLoad("candles:BTC", 60_000, async () => original);
  const copy = [...first].sort((a, b) => a.t - b.t);
  assert.deepEqual(copy.map((c) => c.t), [1, 2, 3]);
  const second = await cache.getOrLoad<typeof original>("candles:BTC", 60_000, async () => {
    throw new Error("must be served from cache");
  });
  assert.deepEqual(second.map((c) => c.t), [3, 1, 2], "cached order must be untouched by the caller's sort");
});

test("INV-M1/R4: an x402 payment id can be consumed once, and released only on known failure", async () => {
  const { consumePaymentId, releasePaymentId } = await import("../src/billing/db.js");
  const db = new BetterSqlite3(":memory:");
  db.exec(`CREATE TABLE x402_payments (payment_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);`);

  assert.equal(consumePaymentId(db, "tx-1"), true, "first use reserves");
  assert.equal(consumePaymentId(db, "tx-1"), false, "replay is refused");
  // Settlement known-failed => the reservation is released and the caller may retry.
  releasePaymentId(db, "tx-1");
  assert.equal(consumePaymentId(db, "tx-1"), true, "released id is reusable");
  // A different payment is unaffected.
  assert.equal(consumePaymentId(db, "tx-2"), true);
});

test("INV-M5: monthly usage is monotonic and isolated per key and period", async () => {
  const { incrementUsage, monthlyTotal } = await import("../src/billing/db.js");
  const db = new BetterSqlite3(":memory:");
  db.exec(`CREATE TABLE usage_counters (key_hash TEXT NOT NULL, period TEXT NOT NULL, tool TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (key_hash, period, tool));`);

  let prev = 0;
  for (let i = 0; i < 25; i++) {
    const total = incrementUsage(db, "k1", "2026-07", i % 2 ? "hl_whale_positions" : "hl_funding_screener");
    assert.ok(total > prev, "usage must never go backwards");
    prev = total;
  }
  assert.equal(monthlyTotal(db, "k1", "2026-07"), 25);
  // A new period starts clean; another key is untouched.
  assert.equal(monthlyTotal(db, "k1", "2026-08"), 0);
  assert.equal(monthlyTotal(db, "k2", "2026-07"), 0);
});

test("INV-S6: a cohort refresh is an atomic all-or-nothing snapshot", async () => {
  const { CohortStore } = await import("../src/store/cohortStore.js");
  const db = new BetterSqlite3(":memory:");
  const store = new CohortStore(db);

  store.replace(
    [
      { address: "0xa", accountValue: 300, pnl: 1, rankBy: 300 },
      { address: "0xb", accountValue: 200, pnl: 1, rankBy: 200 },
    ],
    "accountValue",
    1000,
  );
  assert.deepEqual(store.get(10, 1000)?.addresses, ["0xa", "0xb"]);

  // A replace must swap the whole set: no wallet from the previous snapshot may
  // survive, or the cohort would mix rankings from two different moments.
  store.replace([{ address: "0xc", accountValue: 500, pnl: 1, rankBy: 500 }], "pnlMonth", 2000);
  const snap = store.get(10, 2000);
  assert.deepEqual(snap?.addresses, ["0xc"]);
  assert.equal(snap?.strategy, "pnlMonth");
  assert.equal(snap?.ageSeconds, 0);
  // Age is reported from the snapshot time, so staleness is visible.
  assert.equal(store.get(10, 2000 + 3_600_000)?.ageSeconds, 3600);
});

test("INV-U3: signal horizons are minutes and score horizons are days", () => {
  // These two live side by side in the same engine tick. Confusing them would
  // score a 24h signal after 24 minutes, or resolve a 30-day outcome after 30.
  const DAY_MS = 86_400_000;
  const signalHorizonMinutes = 1440;
  assert.equal(signalHorizonMinutes * 60_000, DAY_MS, "1440 minutes must be one day");
  assert.equal(SCORE_HORIZON_DAYS * DAY_MS, 30 * DAY_MS, "score horizon is expressed in days");
  // The tolerance helper works in minutes and returns ms.
  assert.equal(scoreTolerangeMs(1440), 1440 * 60_000 * 0.05);
  assert.equal(scoreTolerangeMs(1), 5 * 60_000, "floor of 5 minutes for short horizons");
});

test("score store dedupes one observation per address per day", () => {
  const db = new BetterSqlite3(":memory:");
  const store = new ScoreStore(db);
  const day = 86_400_000;
  store.record({ address: "0xa", score: 1, accountValue: 1, horizonDays: 30, ts: 10 * day });
  store.record({ address: "0xa", score: 99, accountValue: 1, horizonDays: 30, ts: 10 * day + 3600_000 });
  store.record({ address: "0xa", score: 2, accountValue: 1, horizonDays: 30, ts: 11 * day });
  assert.equal(store.counts().total, 2);
});

test("closePosition refuses submitting against a foreign address", async () => {
  const pk = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // Hardhat #0 (test-only)
  const config = {
    tradingEnabled: true,
    agentPrivateKey: pk,
    builder: { address: undefined, feeTenthsBps: 5 },
    network: "testnet",
  } as unknown as Config;
  const svc = new TradingService(config, {} as HyperliquidClient);
  await assert.rejects(
    // foreign address + confirm + live mode must be rejected BEFORE any network I/O
    svc.closePosition("BTC", { confirm: true, dryRun: false }, "0x1111111111111111111111111111111111111111"),
    /trading account's own positions/,
  );
});

test("clampFee caps at 100 tenths-of-bp and floors negatives", () => {
  assert.equal(clampFee(5), 5);
  assert.equal(clampFee(250), 100);
  assert.equal(clampFee(-3), 0);
});

test("aggregateByCoin nets long/short and weights entries", () => {
  const accounts: CohortAccount[] = [
    mkAcct("0xaaa", [{ coin: "BTC", szi: 2, entryPx: 60000, notional: 120000, upnl: 1000 }]),
    mkAcct("0xbbb", [{ coin: "BTC", szi: -1, entryPx: 62000, notional: 62000, upnl: -500 }]),
    mkAcct("0xccc", [{ coin: "ETH", szi: 10, entryPx: 3000, notional: 30000, upnl: 0 }]),
  ];
  const agg = aggregateByCoin(accounts);
  const btc = agg.get("BTC");
  assert.ok(btc);
  assert.equal(btc.longWallets, 1);
  assert.equal(btc.shortWallets, 1);
  assert.equal(btc.netSz, 1); // +2 long, -1 short
  assert.equal(btc.wavgEntryLong, 60000);
  assert.equal(btc.wavgEntryShort, 62000);
  assert.equal(round(btc.totalUnrealizedPnl, 2), 500);
});

test("TtlLruCache respects TTL and single-flights", async () => {
  const c = new TtlLruCache(10);
  let calls = 0;
  const load = () => { calls++; return Promise.resolve("v"); };
  const [a, b] = await Promise.all([c.getOrLoad("k", 1000, load), c.getOrLoad("k", 1000, load)]);
  assert.equal(a, "v");
  assert.equal(b, "v");
  assert.equal(calls, 1); // single-flight
});

test("snapshot store finds nearest within tolerance", () => {
  const s = new InMemorySnapshotStore();
  const now = Date.now();
  s.record("ns", "k", { v: 1 }, now - 3_600_000);
  s.record("ns", "k", { v: 2 }, now);
  const near1h = s.nearest("ns", "k", 3_600_000, 600_000);
  assert.deepEqual(near1h?.value, { v: 1 });
  assert.equal(s.nearest("ns", "k", 10 * 3_600_000, 600_000), undefined);
});

test("snapshot store lists keys per namespace (vanished-coin detection)", () => {
  const s = new InMemorySnapshotStore();
  s.record("whaleFlow", "BTC:abc", { v: 1 });
  s.record("whaleFlow", "ETH:abc", { v: 1 });
  s.record("other", "SOL:xyz", { v: 1 });
  assert.deepEqual(s.keys("whaleFlow").sort(), ["BTC:abc", "ETH:abc"]);
  assert.deepEqual(s.keys("other"), ["SOL:xyz"]);
  assert.deepEqual(s.keys("empty"), []);
});

function mkAcct(
  address: string,
  positions: Array<{ coin: string; szi: number; entryPx: number; notional: number; upnl: number }>,
): CohortAccount {
  return {
    address,
    account: {
      accountValue: 0,
      totalNtlPos: 0,
      totalMarginUsed: 0,
      withdrawable: 0,
      crossMaintenanceMarginUsed: 0,
      positions: positions.map((p) => ({
        coin: p.coin,
        szi: p.szi,
        side: p.szi > 0 ? "long" : p.szi < 0 ? "short" : "flat",
        entryPx: p.entryPx,
        positionValueUsd: p.notional,
        unrealizedPnl: p.upnl,
        returnOnEquity: 0,
        leverage: 1,
        leverageType: "cross",
        liquidationPx: null,
        marginUsed: 0,
        maxLeverage: 50,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Ladder coherence (lessons from the Octagon BTC-2026 report comparison)
// ---------------------------------------------------------------------------

test("ladder coherence catches the four impossible orderings from the Octagon report", async () => {
  const { findLadderViolations } = await import("../src/polymarket/coherence.js");
  const END = "2026-12-31T23:59:00-05:00";
  const mk = (thresholdUsd: number, yesProb: number) => ({
    question: `Will Bitcoin reach $${thresholdUsd} by December 31, 2026?`,
    slug: `up${thresholdUsd}`,
    thresholdUsd,
    mode: "touch" as const,
    yesProb,
    endDate: END,
    liquidityUsd: 1000,
  });
  // The report's upside rungs around the violation cluster.
  const entries = [mk(160000, 0.028), mk(170000, 0.018), mk(180000, 0.021), mk(190000, 0.022), mk(200000, 0.02)];
  const v = findLadderViolations(entries);
  // All-pairs, not adjacent-only: 170<180, 170<190, 170<200, 180<190.
  assert.equal(v.length, 4);
  const pairs = v.map((x) => `${x.nearer.thresholdUsd}<${x.further.thresholdUsd}`).sort();
  assert.deepEqual(pairs, ["170000<180000", "170000<190000", "170000<200000", "180000<190000"]);
  // Sorted by gap: the worst violation (170k vs 190k, 0.4pp) first.
  assert.equal(v[0].further.thresholdUsd, 190000);
  assert.ok(v[0].gap > v[v.length - 1].gap);
});

test("ladder coherence: downward ladders, mode isolation, and deadline isolation", async () => {
  const { findLadderViolations } = await import("../src/polymarket/coherence.js");
  const END = "2026-12-31T23:59:00-05:00";
  const down = (k: number, p: number, endDate: string = END, mode: "touch_below" | "below" = "touch_below") => ({
    question: `Will Bitcoin drop to $${k}?`,
    slug: `d${k}${mode}${endDate}`,
    thresholdUsd: k,
    mode,
    yesProb: p,
    endDate,
    liquidityUsd: 1,
  });

  // Downward: lower threshold = harder. 10k priced above 15k is impossible.
  const v = findLadderViolations([down(20000, 0.016), down(15000, 0.017), down(10000, 0.023)]);
  assert.equal(v.length, 3); // 20<15 (0.1pp), 20<10 (0.7pp), 15<10 (0.6pp)
  assert.equal(v[0].further.thresholdUsd, 10000);

  // Different modes are never compared even with identical thresholds/deadlines.
  assert.equal(
    findLadderViolations([down(15000, 0.01, END, "touch_below"), down(10000, 0.99, END, "below")]).length,
    0,
  );
  // Different deadlines are a date ladder, not a value ladder — not compared.
  assert.equal(
    findLadderViolations([down(15000, 0.01, "2026-06-30"), down(10000, 0.99, END)]).length,
    0,
  );
  // A coherent ladder yields nothing.
  assert.equal(findLadderViolations([down(20000, 0.03), down(15000, 0.02), down(10000, 0.01)]).length, 0);
});

test("duplicate contract listings collapse to the most liquid copy", async () => {
  const { dedupeLadderEntries } = await import("../src/polymarket/coherence.js");
  const END = "2026-12-31T23:59:00-05:00";
  const row = (slug: string, yesProb: number, liquidityUsd: number) => ({
    question: "Will Bitcoin drop to $60,000 by December 31, 2026?",
    slug,
    thresholdUsd: 60000,
    mode: "touch_below" as const,
    yesProb,
    endDate: END,
    liquidityUsd,
  });
  // The Octagon table listed one ↓$60k contract four times at four prices.
  const { unique, dropped } = dedupeLadderEntries([
    row("a", 0.999, 50),
    row("b", 0.37, 155_000),
    row("c", 0.0, 0),
    row("d", 0.999, 137_000),
  ]);
  assert.equal(dropped, 3);
  assert.equal(unique.length, 1);
  assert.equal(unique[0].slug, "b"); // the liquid copy survives, whatever arrived first
  // Distinct thresholds are never merged.
  const distinct = dedupeLadderEntries([row("a", 0.5, 1), { ...row("b", 0.4, 1), thresholdUsd: 55000 }]);
  assert.equal(distinct.dropped, 0);
});

test("alert engine resolves due score outcomes with no alerts and no due signals", async () => {
  const db = new BetterSqlite3(":memory:");
  const scores = new ScoreStore(db);
  const day = 86_400_000;
  scores.record({ address: "0xabc", score: 50, accountValue: 1, horizonDays: 1, ts: 1000 });
  // A server nobody has created an alert on: calibration must still accrue.
  const store = {
    alerts: { listActive: () => [] },
    signals: { dueForScoring: () => [] },
    scores,
  } as unknown as Warehouse;
  const hl = {
    userFillsByTime: async () => [{ closedPnl: "125.5" }, { closedPnl: "-25.5" }],
  } as unknown as HyperliquidClient;
  const engine = new AlertEngine(hl, store, {} as SignalSigner, {} as ToolContext);

  await engine.tick(5 * day);

  assert.equal(scores.counts().resolved, 1);
});

test("apify actor never sends the operator key to a caller-supplied URL", () => {
  const env = { MCP_SERVER_URL: "https://operator.example/mcp", MCP_API_KEY: "hs_pro_operator" };

  const target = resolveTarget({ mcpServerUrl: "https://evil.example/mcp" }, env);

  assert.deepEqual(target, { url: "https://operator.example/mcp", apiKey: "hs_pro_operator" });
});

test("apify actor lets a caller with their own key pick their own server", () => {
  const env = { MCP_SERVER_URL: "https://operator.example/mcp", MCP_API_KEY: "hs_pro_operator" };

  const target = resolveTarget({ mcpServerUrl: "https://self-hosted.example/mcp", mcpApiKey: "hs_pro_caller" }, env);

  assert.deepEqual(target, { url: "https://self-hosted.example/mcp", apiKey: "hs_pro_caller" });
});

test("price_move alert stored with movePct 0 does not fire on a sub-1% move", () => {
  // Alerts created before the floor existed can still hold 0 in the database.
  const alert: AlertRecord = {
    id: "a", subject: "s", type: "price_move", params: { coin: "BTC", movePct: 0 },
    enabled: true, cooldownMinutes: 5, lastFiredAt: null, lastState: null, createdAt: 0,
  };

  const result = evaluateAlert(alert, { now: 1, markPx: 100.5, priorPx: 100 });

  assert.equal(result.fired, false);
});

test("hl_create_alert rejects a price_move threshold below 1%", () => {
  const movePct = createAlert.inputSchema.movePct;

  assert.equal(movePct?.safeParse(0).success, false);
  assert.equal(movePct?.safeParse(0.009).success, false);
  assert.equal(movePct?.safeParse(0.01).success, true);
});

/** Registers `run` as a premium tool behind a fresh free key; returns the call and the key's usage. */
function premiumCallOnFreeKey(name: string, run: ToolDef["run"]) {
  const billing = new BillingService({
    dbPath: join(tmpdir(), `hypersignal-test-${Date.now()}.db`),
    x402: { enabled: false },
  } as unknown as Config);
  const fingerprint = `${name}-${Date.now()}-${Math.random()}`;
  const { rawKey } = billing.issueFreeKey(fingerprint);
  let handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean }> = async () => ({});
  const server = {
    registerTool: (_name: string, _config: unknown, h: typeof handler) => {
      handler = h;
    },
  } as unknown as McpServer;
  const def: ToolDef = { name, tier: "premium", title: name, description: name, inputSchema: {}, annotations: {}, run };
  registerTool(server, def, { mode: "http", authorize: billing.authorizerFor({ apiKey: rawKey }) } as unknown as ToolContext);
  return { call: () => handler({}), usage: () => billing.freeKeyUsage(fingerprint) };
}

test("a premium call that fails does not use up the free key's monthly quota", async () => {
  const tool = premiumCallOnFreeKey("hl_test_failing", async () => {
    throw new ToolError("unknown_coin", "No such coin.");
  });

  const result = await tool.call();

  assert.equal(result.isError, true);
  assert.equal(tool.usage(), 0);
});

test("a premium call that succeeds counts against the free key's monthly quota", async () => {
  const tool = premiumCallOnFreeKey("hl_test_ok", async () => ({ summary: "ok", data: {} }));

  const result = await tool.call();

  assert.notEqual(result.isError, true);
  assert.equal(tool.usage(), 1);
});

test("price_move fires once per crossing and re-arms after the move fades", () => {
  const base: AlertRecord = {
    id: "a", subject: "s", type: "price_move", params: { coin: "SOL", movePct: 0.01, windowMinutes: 1440 },
    enabled: true, cooldownMinutes: 5, lastFiredAt: null, lastState: null, createdAt: 0,
  };

  const cross = evaluateAlert(base, { now: 1, markPx: 102, priorPx: 100 });
  // A 24h move that persists all day must not re-fire on every cooldown.
  const persists = evaluateAlert({ ...base, lastState: cross.state }, { now: 2, markPx: 103, priorPx: 100 });
  const fades = evaluateAlert({ ...base, lastState: persists.state }, { now: 3, markPx: 100.5, priorPx: 100 });
  const recross = evaluateAlert({ ...base, lastState: fades.state }, { now: 4, markPx: 98, priorPx: 100 });

  assert.deepEqual([cross.fired, persists.fired, fades.fired, recross.fired], [true, false, false, true]);
});

test("behind one proxy, a client-sent X-Forwarded-For cannot choose the client IP", async () => {
  const app = express();
  app.set("trust proxy", TRUST_PROXY_SETTING);
  app.get("/ip", (req, res) => {
    res.send(req.ip);
  });
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;

  // The client forges 6.6.6.6; the proxy (Fly, Caddy) appends the real peer 1.2.3.4.
  const res = await fetch(`http://127.0.0.1:${port}/ip`, { headers: { "X-Forwarded-For": "6.6.6.6, 1.2.3.4" } });
  server.close();

  assert.equal(await res.text(), "1.2.3.4");
});

test("ipBucket collapses an IPv6 /64 to one requester and unwraps IPv4-mapped addresses", () => {
  assert.equal(ipBucket("2001:db8:1:2::a"), ipBucket("2001:0db8:0001:0002:ffff:1:2:3"));
  assert.notEqual(ipBucket("2001:db8:1:2::a"), ipBucket("2001:db8:1:3::a"));
  assert.equal(ipBucket("::ffff:1.2.3.4"), "1.2.3.4");
  assert.equal(ipBucket("1.2.3.4"), "1.2.3.4");
});

test("hl_request_free_key re-issues at most once an hour per requester", async () => {
  const billing = new BillingService({
    dbPath: join(tmpdir(), `hypersignal-test-${Date.now()}.db`),
    x402: { enabled: false },
  } as unknown as Config);
  const ctx = (clientIp: string) => ({ mode: "http", billing, clientIp }) as unknown as ToolContext;

  await requestFreeKey.run({}, ctx("2001:db8:77:1::a"));

  // Another address in the same /64, minutes later: same requester, refused.
  await assert.rejects(
    requestFreeKey.run({}, ctx("2001:db8:77:1::b")),
    (err: unknown) => err instanceof ToolError && err.code === "free_key_cooldown",
  );
});

test("a free key may be re-issued again after the hour has passed", () => {
  const billing = new BillingService({
    dbPath: join(tmpdir(), `hypersignal-test-${Date.now()}.db`),
    x402: { enabled: false },
  } as unknown as Config);
  const fingerprint = `cooldown-${Date.now()}-${Math.random()}`;
  const t0 = 1_900_000_000_000;

  billing.issueFreeKey(fingerprint, t0);

  assert.equal(billing.issueFreeKey(fingerprint, t0 + 61 * 60_000).reissued, true);
});

/** A clearinghouseState with one BTC position (szi > 0 long, < 0 short). */
function walletWithBtc(szi: number) {
  const ntl = String(Math.abs(szi) * 60000);
  return {
    marginSummary: { accountValue: "1000000", totalNtlPos: ntl, totalRawUsd: "0", totalMarginUsed: "0" },
    crossMarginSummary: { accountValue: "1000000", totalNtlPos: ntl, totalRawUsd: "0", totalMarginUsed: "0" },
    crossMaintenanceMarginUsed: "0",
    withdrawable: "0",
    assetPositions: [
      {
        type: "oneWay",
        position: {
          coin: "BTC", szi: String(szi), entryPx: "60000", positionValue: ntl, unrealizedPnl: "0",
          returnOnEquity: "0", leverage: { type: "cross", value: 1 }, liquidationPx: null, marginUsed: "0", maxLeverage: 40,
        },
      },
    ],
  };
}

test("whale_net_flip does not fire when a cohort wallet failed to load", async () => {
  const whale = "0x1111111111111111111111111111111111111111";
  const minnow = "0x2222222222222222222222222222222222222222";
  // The cohort was net long (the whale), last seen with sign +1.
  const alert: AlertRecord = {
    id: "w", subject: "s", type: "whale_net_flip", params: { coin: "BTC", cohort: [whale, minnow] },
    enabled: true, cooldownMinutes: 5, lastFiredAt: null, lastState: { sign: 1 }, createdAt: 0,
  };
  const recorded: unknown[] = [];
  const store = {
    alerts: { listActive: () => [alert], updateState: () => undefined, recordFired: () => undefined },
    signals: { dueForScoring: () => [], record: (s: unknown) => recorded.push(s) },
    snapshots: { record: () => undefined },
    scores: { due: () => [] },
  } as unknown as Warehouse;
  const hl = {
    metaAndAssetCtxs: async () => [
      { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] },
      [{ markPx: "60000", prevDayPx: "60000", funding: "0", oraclePx: "60000", openInterest: "0", dayNtlVlm: "0" }],
    ],
    // The whale's request fails; only the small short loads.
    clearinghouseState: async (address: string) => {
      if (address === whale) throw new Error("429 Too Many Requests");
      return walletWithBtc(-1);
    },
  } as unknown as HyperliquidClient;
  const signer = { sign: () => ({ signature: "sig" }) } as unknown as SignalSigner;
  const engine = new AlertEngine(hl, store, signer, { store, hl } as unknown as ToolContext);

  const fired = await engine.tick(1_000_000);

  assert.equal(fired, 0);
  assert.equal(recorded.length, 0, "no signed signal from a partial cohort");
});

/** Two-wallet cohort whose whale (net long 10 BTC an hour ago) now fails to load. */
function partialCohortCtx() {
  const whale = "0x3333333333333333333333333333333333333333";
  const minnow = "0x4444444444444444444444444444444444444444";
  const cohortKey = shortHash([whale, minnow].sort().join(","));
  const snapshots = new InMemorySnapshotStore();
  const hourAgo = Date.now() - 3_600_000;
  snapshots.record("whaleFlow", `BTC:${cohortKey}`, { netNtlUsd: 540_000 }, hourAgo);
  snapshots.record("whalePositions", `BTC:${cohortKey}`, { netNtlUsd: 540_000 }, hourAgo);
  const hl = {
    clearinghouseState: async (address: string) => {
      if (address === whale) throw new Error("429 Too Many Requests");
      return walletWithBtc(-1);
    },
  };
  return { cohort: [whale, minnow], ctx: { hl, snapshots, store: { cohort: { get: () => null } } } as unknown as ToolContext };
}

test("hl_whale_flow_alerts reports no flow from a partially loaded cohort", async () => {
  const { cohort, ctx } = partialCohortCtx();

  const { data } = await whaleFlowAlerts.run({ cohort, thresholdUsd: 100_000, lookbackMinutes: 60 }, ctx);

  assert.deepEqual((data as { alerts: unknown[] }).alerts, []);
  assert.equal((data as { walletsRequested: number }).walletsRequested, 2);
});

test("hl_whale_positions gives no 1h change for a partially loaded cohort", async () => {
  const { cohort, ctx } = partialCohortCtx();

  const { data } = await whalePositions.run({ cohort }, ctx);

  const btc = (data as { coins: Array<{ coin: string; change1hUsd: number | null }> }).coins.find((c) => c.coin === "BTC");
  assert.equal(btc?.change1hUsd, null);
  assert.equal((data as { walletsRequested: number }).walletsRequested, 2);
});

test("alert engine status shows when the last tick ran and why it failed", async () => {
  let failing = true;
  const store = {
    alerts: { listActive: () => [] },
    signals: { dueForScoring: () => [] },
    scores: {
      due: () => {
        if (failing) throw new Error("database is locked");
        return [];
      },
    },
  } as unknown as Warehouse;
  const engine = new AlertEngine({} as HyperliquidClient, store, {} as SignalSigner, {} as ToolContext);

  await engine.tick(1_000);
  const afterFailure = engine.status();
  failing = false;
  await engine.tick(2_000);

  assert.deepEqual(afterFailure, { lastTickAt: 1_000, lastTickError: "database is locked" });
  assert.deepEqual(engine.status(), { lastTickAt: 2_000, lastTickError: null });
});

test("a deploy with both key env vars empty does not revoke every bootstrap key", () => {
  const db = getDb(join(tmpdir(), `hypersignal-test-${Date.now()}.db`));
  const keyHash = `pro-bootstrap-${Date.now()}-${Math.random()}`;
  upsertKey(db, keyHash, "pro", "pro-bootstrap");
  const saved = { pro: process.env.HYPERSIGNAL_PRO_KEYS, free: process.env.HYPERSIGNAL_FREE_KEYS };
  delete process.env.HYPERSIGNAL_PRO_KEYS;
  delete process.env.HYPERSIGNAL_FREE_KEYS;

  try {
    new BillingService({ dbPath: join(tmpdir(), "unused.db"), x402: { enabled: false } } as unknown as Config);
  } finally {
    if (saved.pro !== undefined) process.env.HYPERSIGNAL_PRO_KEYS = saved.pro;
    if (saved.free !== undefined) process.env.HYPERSIGNAL_FREE_KEYS = saved.free;
  }

  assert.equal(getKey(db, keyHash)?.disabled, 0, "a missing secret must not lock out every paying customer");
});

test("hyperliquid client charges the documented info request weights", async () => {
  const charged: number[] = [];
  const realAcquire = RateLimiter.prototype.acquire;
  const realFetch = globalThis.fetch;
  RateLimiter.prototype.acquire = async function (weight?: number) {
    charged.push(weight ?? 1);
  };
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body));
    const fills = Array.from({ length: 45 }, (_, i) => ({ tid: i, hash: "h", time: 1, coin: "BTC", px: "1", sz: "1" }));
    return new Response(JSON.stringify(body.type === "userFillsByTime" ? fills : [{ universe: [] }, []]), { status: 200 });
  }) as typeof fetch;
  try {
    const hl = new HyperliquidClient({
      infoBaseUrl: "http://hl.test/info", requestTimeoutMs: 1000, maxRetries: 0, rateWeightPerMin: 1200,
    } as unknown as Config);
    await hl.metaAndAssetCtxs();
    await hl.userFillsByTime("0xabc", 0, 1);
  } finally {
    RateLimiter.prototype.acquire = realAcquire;
    globalThis.fetch = realFetch;
  }

  // Hyperliquid docs: most info requests weigh 20; fill endpoints add 1 per 20 items returned.
  assert.deepEqual(charged, [20, 20, 2]);
});

test("a paid hl_smart_money_score call does not make the daily calibration sample skip", async () => {
  const scores = new ScoreStore(new BetterSqlite3(":memory:"));
  const cohortAddresses = [
    "0x5555555555555555555555555555555555555555",
    "0x6666666666666666666666666666666666666666",
    "0x7777777777777777777777777777777777777777",
  ];
  const ctx = {
    config: { whaleAddresses: cohortAddresses, leaderboardUrl: undefined, requestTimeoutMs: 1000 },
    hl: {
      userFillsByTime: async () => [],
      clearinghouseState: async () => walletWithBtc(1),
    },
    store: { cohort: { get: () => null }, scores },
  } as unknown as ToolContext;

  // A caller asks for the top 3 over a 7-day lookback.
  await smartMoneyScore.run({ topN: 3, lookbackDays: 7 }, ctx);
  const sample = await new ScoreSampler(ctx).runOnce(Date.now());

  assert.equal(sample.skipped, false, "the sampler, not a caller's query, decides what enters the calibration");
});

test("calibration outcomes are returns on the sampled account, not raw USD PnL", () => {
  const store = new ScoreStore(new BetterSqlite3(":memory:"));
  store.record({ address: "0xbig", score: 90, accountValue: 1_000_000, horizonDays: 30, ts: 1_000 });
  store.record({ address: "0xsmall", score: 10, accountValue: 10_000, horizonDays: 30, ts: 2_000 });
  store.record({ address: "0xempty", score: 50, accountValue: 0, horizonDays: 30, ts: 3_000 });
  for (const row of store.due(10, 365 * 86_400_000)) {
    const pnl = { "0xbig": 10_000, "0xsmall": 1_000, "0xempty": 500 }[row.address] ?? 0;
    store.setOutcome(row.id, pnl);
  }

  // $10k on $1M is 1%; $1k on $10k is 10%. Raw USD would rank the big account first.
  const outcomes = store.outcomes().sort((a, b) => a.score - b.score);

  assert.deepEqual(outcomes, [
    { score: 10, forwardReturn: 0.1 },
    { score: 90, forwardReturn: 0.01 },
  ]);
});

test("an insignificant small positive correlation is no evidence, not weak_positive", () => {
  const observations = Array.from({ length: 40 }, (_, i) => ({ score: i, forwardReturn: (i + 7) % 40 }));

  const report = calibrate(observations);

  // r ≈ 0.13 with p ≈ 0.41: indistinguishable from noise.
  assert.ok((report.pValue ?? 0) > 0.05);
  assert.equal(report.verdict, "no_evidence");
});

test("planTwap slices in whole lots so the exchange sends exactly totalSize", () => {
  // szDecimals 0: 1.5-coin slices would each be rounded to 2 on the wire (20 sent).
  const children = planTwap({ totalSize: 15, slices: 10, durationMs: 0, szDecimals: 0 });

  assert.deepEqual(children.map((c) => c.size), [2, 2, 2, 2, 2, 1, 1, 1, 1, 1]);
});

/** Trading-mode ctx with one perp market (BTC) of the given size decimals. */
function tradingCtx(szDecimals: number, execution: unknown = {}) {
  const hl = {
    metaAndAssetCtxs: async () => [
      { universe: [{ name: "BTC", szDecimals, maxLeverage: 40 }] },
      [{ markPx: "60000", midPx: "60000", prevDayPx: "60000", funding: "0", oraclePx: "60000", openInterest: "0", dayNtlVlm: "0" }],
    ],
  };
  return { hl, mode: "stdio", trading: {}, execution } as unknown as ToolContext;
}

test("hl_twap_order refuses more slices than the size has lots", async () => {
  await assert.rejects(
    twapOrder.run({ coin: "BTC", side: "buy", totalSize: 3, slices: 5, durationMinutes: 1 }, tradingCtx(0)),
    (err: unknown) => err instanceof ToolError && err.code === "bad_plan" && /at most 3 slices/.test(err.message),
  );
});

/** A TradingService able to submit, over one BTC market at $60,000 (szDecimals 5). */
function cappedTrading(maxOrderNotionalUsd: number) {
  const config = {
    tradingEnabled: true,
    agentPrivateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // Hardhat #0 (test-only)
    builder: { address: undefined, feeTenthsBps: 5 },
    network: "testnet",
    maxOrderNotionalUsd,
  } as unknown as Config;
  return new TradingService(config, (tradingCtx(5) as unknown as { hl: HyperliquidClient }).hl);
}

test("placeOrder refuses an order above the operator's notional cap, even when confirmed", async () => {
  // 1 BTC at ~$60k against a $10k cap; refused before anything is signed.
  await assert.rejects(
    cappedTrading(10_000).placeOrder({ coin: "BTC", isBuy: true, sz: 1, reduceOnly: false, tif: "Ioc" }, { confirm: true, dryRun: true }),
    (err: unknown) => err instanceof ToolError && err.code === "order_too_large",
  );
});

test("placeOrder lets a reduce-only order through the notional cap so a position can always be closed", async () => {
  const res = await cappedTrading(10_000).placeOrder(
    { coin: "BTC", isBuy: false, sz: 1, reduceOnly: true, tif: "Ioc" },
    { confirm: true, dryRun: true },
  );

  assert.equal(res.mode, "dry_run");
});

test("hl_twap_order refuses up front when a slice would exceed the per-order cap", async () => {
  const ctx = { ...(tradingCtx(5) as object), config: { maxOrderNotionalUsd: 10_000 } } as unknown as ToolContext;

  // 2 BTC over 4 slices: 0.5 BTC (~$30k) per slice against a $10k cap.
  await assert.rejects(
    twapOrder.run({ coin: "BTC", side: "buy", totalSize: 2, slices: 4, durationMinutes: 10 }, ctx),
    (err: unknown) => err instanceof ToolError && err.code === "order_too_large",
  );
});

test("a live plan stops after three consecutive failed slices", async () => {
  let calls = 0;
  const trading = {
    placeOrder: async () => {
      calls++;
      throw new Error("Insufficient margin to place order.");
    },
  } as unknown as TradingService;
  const runner = new ExecutionRunner(trading);
  const children = Array.from({ length: 6 }, (_, i) => ({ index: i, size: 0.01, atOffsetMs: i * 20 }));

  const plan = runner.schedule({ kind: "twap", coin: "BTC", isBuy: true, reduceOnly: false, children, live: true });
  await new Promise((resolve) => setTimeout(resolve, 250));

  assert.equal(calls, 3, "the remaining slices must not keep firing into the same failure");
  assert.equal(plan.status, "failed");
});

test("hl_twap_order reports blocked instead of scheduling when trading cannot submit", async () => {
  let scheduled = false;
  const execution = {
    schedule: () => {
      scheduled = true;
      return { id: "x", children: [] };
    },
  };
  const ctx = {
    ...(tradingCtx(5, execution) as object),
    trading: { canSubmit: () => ({ ok: false, reason: "trading_disabled (set HL_ENABLE_TRADING=true)" }) },
    config: { maxOrderNotionalUsd: 10_000 },
  } as unknown as ToolContext;

  const { data } = await twapOrder.run(
    { coin: "BTC", side: "buy", totalSize: 0.01, slices: 2, durationMinutes: 1, confirm: true, dryRun: false },
    ctx,
  );

  assert.equal((data as { mode: string }).mode, "blocked");
  assert.equal(scheduled, false);
});

test("hl_cancel_execution stops a running plan", async () => {
  const runner = new ExecutionRunner({ placeOrder: async () => ({ mode: "submitted" }) } as unknown as TradingService);
  const plan = runner.schedule({
    kind: "twap", coin: "BTC", isBuy: true, reduceOnly: false, live: true,
    children: [{ index: 0, size: 0.01, atOffsetMs: 60_000 }],
  });
  const ctx = { execution: runner, trading: {} } as unknown as ToolContext;

  const { data } = await cancelExecution.run({ planId: plan.id }, ctx);

  assert.equal((data as { status: string }).status, "cancelled");
});

test("a live TWAP cut short by a crash comes back interrupted and is not resumed", async () => {
  const db = new BetterSqlite3(":memory:");
  let sent = 0;
  const trading = {
    placeOrder: async () => {
      sent++;
      return { mode: "submitted" };
    },
  } as unknown as TradingService;
  const crashed = new ExecutionRunner(trading, db);
  const plan = crashed.schedule({
    kind: "twap", coin: "BTC", isBuy: true, reduceOnly: false, live: true,
    children: [{ index: 0, size: 0.01, atOffsetMs: 0 }, { index: 1, size: 0.01, atOffsetMs: 200 }],
  });
  await new Promise((resolve) => setTimeout(resolve, 20)); // the first slice goes out

  // A process that died leaves its plan "running" in the DB; the next one reads it from there.
  const restarted = new ExecutionRunner(trading, db);
  const after = restarted.get(plan.id);
  crashed.cancel(plan.id); // the dead process's timer dies with it
  await new Promise((resolve) => setTimeout(resolve, 300)); // past slice 1's time, had it been resumed

  assert.equal(after?.status, "interrupted");
  assert.deepEqual(after?.children.map((c) => c.status), ["submitted", "pending"]);
  assert.equal(restarted.pending().length, 0, "a restarted server must not resume sending the rest");
  assert.equal(sent, 1);
});

test("a plan cut short by shutdown is stored as interrupted, not as cancelled by the user", () => {
  const db = new BetterSqlite3(":memory:");
  const trading = { placeOrder: async () => ({ mode: "submitted" }) } as unknown as TradingService;
  const runner = new ExecutionRunner(trading, db);
  const plan = runner.schedule({
    kind: "twap", coin: "BTC", isBuy: true, reduceOnly: false, live: true,
    children: [{ index: 0, size: 0.01, atOffsetMs: 60_000 }],
  });

  runner.cancelAllPending();

  assert.equal(new ExecutionRunner(trading, db).get(plan.id)?.status, "interrupted");
});

test("a plan another live process is running is left alone, not marked interrupted", () => {
  const db = new BetterSqlite3(":memory:");
  const trading = { placeOrder: async () => ({ mode: "submitted" }) } as unknown as TradingService;
  const first = new ExecutionRunner(trading, db);
  const plan = first.schedule({
    kind: "twap", coin: "BTC", isBuy: true, reduceOnly: false, live: true,
    children: [{ index: 0, size: 0.01, atOffsetMs: 60_000 }],
  });
  db.prepare(`UPDATE execution_plans SET owner_pid = ?`).run(process.ppid); // owned by a process that is alive

  const second = new ExecutionRunner(trading, db);
  first.cancel(plan.id);

  assert.equal(second.get(plan.id), undefined);
  assert.equal(second.pending().length, 0, "shutting down the second server must not touch the first one's plan");
});

test("Polymarket 'Up or Down' markets are direction bets, not price thresholds", () => {
  assert.equal(parseThresholdMarket("Solana Up or Down - October 28"), null);
});

test("Polymarket parser skips a day-of-month next to a month name", () => {
  assert.equal(parseThresholdMarket("Will XRP hit 3 by October 28?")?.thresholdUsd, 3);
});

test("Polymarket parser refuses a percentage move as a price", () => {
  assert.equal(parseThresholdMarket("Will SOL rise 10% this week?"), null);
});

test("Polymarket 'exceed / fall below ... by <date>' resolves on a touch, not at expiry", () => {
  assert.equal(parseThresholdMarket("Will Bitcoin exceed $150k by December 31?")?.mode, "touch");
  assert.equal(parseThresholdMarket("Will Ethereum fall below $2,000 by December 31?")?.mode, "touch_below");
  // "be above ... on <date>" is still a reading at the date.
  assert.equal(parseThresholdMarket("Will Bitcoin be above $100k on December 31?")?.mode, "above");
});

test("fundingHistory pages past Hyperliquid's 500-entry response cap", async () => {
  const HOUR = 3_600_000;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const { startTime } = JSON.parse(String(init?.body)) as { startTime: number };
    // 30 days of hourly funding = 720 entries; each response holds at most 500.
    const entries = [];
    for (let t = Math.ceil(startTime / HOUR) * HOUR; t < 720 * HOUR && entries.length < 500; t += HOUR) {
      entries.push({ coin: "BTC", fundingRate: "0.0000125", premium: "0", time: t });
    }
    return new Response(JSON.stringify(entries), { status: 200 });
  }) as typeof fetch;
  let history: unknown[] = [];
  try {
    const hl = new HyperliquidClient({
      infoBaseUrl: "http://hl.test/info", requestTimeoutMs: 1000, maxRetries: 0, rateWeightPerMin: 100_000,
    } as unknown as Config);
    history = await hl.fundingHistory("BTC", 0, 720 * HOUR);
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(history.length, 720);
});

test("hl_trader_report flags history cut at Hyperliquid's 10,000 most recent fills", async () => {
  const fills = Array.from({ length: 10_000 }, (_, i) => ({
    coin: "BTC", px: "60000", sz: "0.01", side: "B", time: i, closedPnl: i % 2 ? "5" : "-3", fee: "0.1", dir: "Close Long",
  }));
  const ctx = { hl: { userFillsByTime: async () => fills } } as unknown as ToolContext;

  const { data } = await traderReport.run({ address: "0x8888888888888888888888888888888888888888" }, ctx);

  assert.equal((data as { historyTruncated: boolean }).historyTruncated, true);
});

test("hl_hip3_analytics lists the builder dexs it did not scan", async () => {
  const dexs = Array.from({ length: 12 }, (_, i) => ({ name: `dex${i}` }));
  const ctx = {
    hl: {
      metaAndAssetCtxs: async () => [{ universe: [] }, []],
      perpDexs: async () => [null, ...dexs],
      metaAndAssetCtxsForDex: async () => [{ universe: [] }, []],
    },
  } as unknown as ToolContext;

  const { data } = await hip3Analytics.run({}, ctx);

  assert.deepEqual((data as { dexsNotScanned: string[] }).dexsNotScanned, ["dex10", "dex11"]);
});

test("Polymarket markets are fetched by 24h volume across several pages, not the first 500 returned", async () => {
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    urls.push(String(url));
    const offset = Number(new URL(String(url)).searchParams.get("offset") ?? 0);
    const page = offset < 1000 ? Array.from({ length: 500 }, (_, i) => ({
      question: `Q${offset + i}`, slug: `s${offset + i}`, outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]',
    })) : [];
    return new Response(JSON.stringify(page), { status: 200 });
  }) as typeof fetch;
  let markets: unknown[] = [];
  try {
    const client = new PolymarketClient({
      polymarket: { gammaUrl: "http://gamma.test" }, requestTimeoutMs: 1000,
    } as unknown as Config);
    markets = await client.activeMarkets();
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.ok(urls.every((u) => u.includes("order=volume24hr") && u.includes("ascending=false")));
  assert.equal(markets.length, 1000);
});

test("hl_vault_screener does not read a withdrawal as a drawdown", async () => {
  const vault = "0x9999999999999999999999999999999999999999";
  // Followers withdrew half the vault; the strategy itself made and lost nothing.
  const details = {
    name: "flat", leader: vault, apr: 0, followers: [],
    portfolio: [["allTime", {
      accountValueHistory: [[0, "2000"], [1, "1000"], [2, "1000"]],
      pnlHistory: [[0, "0"], [1, "0"], [2, "0"]],
    }]],
  };
  const ctx = { config: { vaultAddresses: [] }, hl: { rawInfo: async () => details } } as unknown as ToolContext;

  const { data } = await vaultScreener.run({ vaults: [vault] }, ctx);

  assert.equal((data as { vaults: Array<{ maxDrawdownPct: number }> }).vaults[0].maxDrawdownPct, 0);
});

test("hl_vault_screener caps how many vaults one call may fan out to", () => {
  const vaults = Array.from({ length: 51 }, (_, i) => `0x${String(i).padStart(40, "0")}`);

  assert.equal(vaultScreener.inputSchema.vaults?.safeParse(vaults).success, false);
});

test("detectCoordination does not call single-coin books the same entity", () => {
  // Twenty unrelated whales that are simply long BTC all have cosine 1.0.
  const wallets: WalletVector[] = Array.from({ length: 20 }, (_, i) => ({
    address: `W${i}`,
    vec: new Map([["BTC", 1 + i]]),
  }));

  const { clusters, pairs } = detectCoordination(wallets, 0.9);

  assert.equal(clusters.length, 0);
  assert.equal(pairs.length, 0);
});

test("detectCoordination returns at most 50 pairs, strongest first", () => {
  const wallets: WalletVector[] = Array.from({ length: 60 }, (_, i) => ({
    address: `M${i}`,
    vec: new Map([["BTC", 0.5], ["ETH", 0.3 + i / 1000], ["SOL", 0.2]]),
  }));

  const { pairs } = detectCoordination(wallets, 0.9);

  assert.equal(pairs.length, 50);
  assert.ok(pairs.every((p, i) => i === 0 || pairs[i - 1].similarity >= p.similarity));
});

function x402Config(): Config {
  return {
    dbPath: join(tmpdir(), `hypersignal-test-${Date.now()}.db`),
    x402: {
      enabled: true, payTo: "0x000000000000000000000000000000000000beef", network: "base", asset: "USDC",
      facilitatorUrl: "http://facilitator.test", pricePerCallUsdc: 0.01,
    },
  } as unknown as Config;
}

/** base64 X-PAYMENT for one EIP-3009 authorization; `reordered` serializes the same payment differently. */
function x402Header(
  nonce: string,
  { reordered = false, from = "0xPayer", validBefore = "9999999999" }: { reordered?: boolean; from?: string; validBefore?: string } = {},
): string {
  const authorization = reordered
    ? { nonce, validBefore, validAfter: "0", value: "10000", to: "0x000000000000000000000000000000000000beef", from }
    : { from, to: "0x000000000000000000000000000000000000beef", value: "10000", validAfter: "0", validBefore, nonce };
  const payment = reordered
    ? { payload: { authorization, signature: "0xsig" }, network: "base", scheme: "exact", x402Version: 1 }
    : { x402Version: 1, scheme: "exact", network: "base", payload: { signature: "0xsig", authorization } };
  return Buffer.from(JSON.stringify(payment)).toString("base64");
}

/** Facilitator that accepts every payment; counts settlements. Returns a restore function. */
function stubFacilitator(
  counts: { settles: number },
  settle: { status: number; body: string } = { status: 200, body: JSON.stringify({ success: true, transaction: "0xtx" }) },
): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).endsWith("/settle")) {
      counts.settles++;
      return new Response(settle.body, { status: settle.status });
    }
    return new Response(JSON.stringify({ isValid: true }), { status: 200 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

test("x402 requirements carry the EIP-712 domain standard clients sign against", () => {
  const extra = buildPaymentRequirements(x402Config(), "hl_whale_positions").accepts[0].extra;

  // Base mainnet USDC's EIP-712 domain is ("USD Coin", "2").
  assert.deepEqual({ name: extra.name, version: extra.version }, { name: "USD Coin", version: "2" });
});

test("x402 refuses the same authorization re-encoded as a different JSON payload", async () => {
  const config = x402Config();
  const requirements = buildPaymentRequirements(config, "hl_whale_positions");
  const restore = stubFacilitator({ settles: 0 });
  let second: { reason?: string } = {};
  try {
    await verifyPayment(config, getDb(config.dbPath), x402Header("0xnonce-replay"), requirements);
    second = await verifyPayment(config, getDb(config.dbPath), x402Header("0xnonce-replay", { reordered: true }), requirements);
  } finally {
    restore();
  }

  assert.equal(second.reason, "payment_replayed");
});

test("x402 settles only after the tool succeeds, so a failed call costs the payer nothing", async () => {
  const billing = new BillingService(x402Config());
  const counts = { settles: 0 };
  const restore = stubFacilitator(counts);
  const header = x402Header("0xnonce-settle");
  const call = async (run: ToolDef["run"]) => {
    let handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean }> = async () => ({});
    const server = { registerTool: (_n: string, _c: unknown, h: typeof handler) => { handler = h; } } as unknown as McpServer;
    const def: ToolDef = { name: "hl_test_x402", tier: "premium", title: "t", description: "d", inputSchema: {}, annotations: {}, run };
    registerTool(server, def, { mode: "http", authorize: billing.authorizerFor({ xPayment: header }) } as unknown as ToolContext);
    return handler({});
  };
  let failed: { isError?: boolean } = {};
  let settlesAfterFailure = -1;
  let succeeded: { isError?: boolean } = {};
  try {
    failed = await call(async () => {
      throw new ToolError("unknown_coin", "No such coin.");
    });
    settlesAfterFailure = counts.settles;
    // The same payment is still good for a call that delivers.
    succeeded = await call(async () => ({ summary: "ok", data: {} }));
  } finally {
    restore();
  }

  assert.equal(failed.isError, true);
  assert.equal(settlesAfterFailure, 0);
  assert.notEqual(succeeded.isError, true);
  assert.equal(counts.settles, 1);
});

test("x402 does not settle a call the client cancelled or disconnected from", async () => {
  const billing = new BillingService(x402Config());
  const counts = { settles: 0 };
  const restore = stubFacilitator(counts);
  let handler: (args: Record<string, unknown>, extra: { signal: AbortSignal }) => Promise<{ isError?: boolean }> =
    async () => ({});
  const server = { registerTool: (_n: string, _c: unknown, h: typeof handler) => { handler = h; } } as unknown as McpServer;
  const def: ToolDef = {
    name: "hl_test_cancel", tier: "premium", title: "t", description: "d", inputSchema: {}, annotations: {},
    run: async () => ({ summary: "ok", data: {} }),
  };
  registerTool(server, def, {
    mode: "http", authorize: billing.authorizerFor({ xPayment: x402Header("0xnonce-cancel") }),
  } as unknown as ToolContext);
  const controller = new AbortController();
  controller.abort(); // the client went away before the result could be delivered

  let result: { isError?: boolean } = {};
  try {
    result = await handler({}, { signal: controller.signal });
  } finally {
    restore();
  }

  assert.equal(result.isError, true);
  assert.equal(counts.settles, 0);
});

test("x402 keeps the reservation when a gateway error leaves the settle outcome unknown", async () => {
  const config = x402Config();
  const requirements = buildPaymentRequirements(config, "hl_whale_positions");
  const header = x402Header("0xnonce-502");
  const restore = stubFacilitator({ settles: 0 }, { status: 502, body: "<html>Bad Gateway</html>" });
  let settleError: unknown;
  let retry: { reason?: string } = {};
  try {
    const first = await verifyPayment(config, getDb(config.dbPath), header, requirements);
    await first.charge?.settle().catch((err: unknown) => {
      settleError = err;
    });
    first.charge?.release(); // what registerTool does after a failed call
    retry = await verifyPayment(config, getDb(config.dbPath), header, requirements);
  } finally {
    restore();
  }

  // The transfer may already be on-chain: the same authorization must not be accepted again.
  assert.equal((settleError as ToolError).details?.reason, "settlement_unconfirmed");
  assert.equal(retry.reason, "payment_replayed");
});

test("a refused settlement tells the client what to pay to retry", async () => {
  const config = x402Config();
  const requirements = buildPaymentRequirements(config, "hl_whale_positions");
  const restore = stubFacilitator({ settles: 0 }, { status: 200, body: JSON.stringify({ success: false, errorReason: "insufficient_funds" }) });
  let settleError: unknown;
  try {
    const { charge } = await verifyPayment(config, getDb(config.dbPath), x402Header("0xnonce-refused"), requirements);
    await charge?.settle().catch((err: unknown) => {
      settleError = err;
    });
  } finally {
    restore();
  }

  // Nothing moved, so the caller may pay again: the 402 must carry what to pay, like the first one did.
  assert.equal((settleError as ToolError).details?.reason, "settlement_failed");
  assert.deepEqual((settleError as ToolError).details?.x402, requirements);
});

test("x402 refuses an authorization that expires before a call could settle", async () => {
  const config = x402Config();
  const soon = String(Math.floor(Date.now() / 1000) + 5);
  const restore = stubFacilitator({ settles: 0 });
  let result: { reason?: string } = {};
  try {
    result = await verifyPayment(
      config, getDb(config.dbPath), x402Header("0xnonce-expiring", { validBefore: soon }),
      buildPaymentRequirements(config, "hl_whale_positions"),
    );
  } finally {
    restore();
  }

  assert.equal(result.reason, "authorization_expiring");
});

test("x402 caps how many unsettled payments one payer may hold", async () => {
  const config = x402Config();
  const requirements = buildPaymentRequirements(config, "hl_whale_positions");
  const restore = stubFacilitator({ settles: 0 });
  const results: Array<{ reason?: string }> = [];
  try {
    // Verify checks each authorization's balance alone, so one $0.01 wallet could
    // start any number of tool runs with distinct nonces before one settles.
    for (let i = 0; i < 4; i++) {
      results.push(
        await verifyPayment(config, getDb(config.dbPath), x402Header(`0xnonce-cap-${i}`, { from: "0xBusyPayer" }), requirements),
      );
    }
  } finally {
    restore();
  }

  assert.deepEqual(results.map((r) => r.reason), [undefined, undefined, undefined, "too_many_pending_payments"]);
});

/** An agent (API) wallet trading for a master account that holds 0.1 BTC; the agent itself holds nothing. */
function apiWalletSetup() {
  const master = "0x00000000000000000000000000000000000000aa";
  const target = "0x00000000000000000000000000000000000000bb";
  const empty = {
    marginSummary: { accountValue: "0", totalNtlPos: "0", totalRawUsd: "0", totalMarginUsed: "0" },
    crossMarginSummary: { accountValue: "0", totalNtlPos: "0", totalRawUsd: "0", totalMarginUsed: "0" },
    crossMaintenanceMarginUsed: "0", withdrawable: "0", assetPositions: [],
  };
  const hl = {
    ...(tradingCtx(5) as unknown as { hl: object }).hl,
    clearinghouseState: async (address: string) =>
      [master, target].includes(address.toLowerCase()) ? walletWithBtc(0.1) : empty,
  } as unknown as HyperliquidClient;
  const config = {
    tradingEnabled: false,
    agentPrivateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // Hardhat #0 (test-only)
    accountAddress: master,
    builder: { address: undefined, feeTenthsBps: 5 },
    network: "testnet",
    maxOrderNotionalUsd: 10_000,
  } as unknown as Config;
  return { master, target, hl, config, trading: new TradingService(config, hl) };
}

test("closePosition reads the master account an API wallet trades for", async () => {
  const { trading } = apiWalletSetup();

  const res = await trading.closePosition("BTC", { confirm: true, dryRun: true });

  assert.equal(res.mode, "dry_run");
});

test("closePosition accepts the master account's address when submitting", async () => {
  const { trading, master } = apiWalletSetup();

  // Trading is disabled here, so a refusal for any other reason surfaces as "blocked".
  const res = await trading.closePosition("BTC", { confirm: true, dryRun: false }, master);

  assert.equal(res.mode, "blocked");
});

test("hl_copy_wallet sizes from the master account's equity, not the empty agent wallet", async () => {
  const { hl, config, trading, target } = apiWalletSetup();
  const ctx = { hl, config, trading, execution: {}, mode: "stdio" } as unknown as ToolContext;

  const { data } = await copyWallet.run({ targetAddress: target }, ctx);

  assert.equal((data as { myEquityUsd: number }).myEquityUsd, 1_000_000);
});

test("server.json matches package.json for the MCP Registry", async () => {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const server = JSON.parse(readFileSync("server.json", "utf8"));

  // The registry checks the npm package's mcpName against server.json's name.
  assert.equal(server.name, pkg.mcpName);
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages[0].identifier, pkg.name);
  assert.equal(server.packages[0].version, pkg.version);
  assert.ok(server.description.length <= 100, "the registry rejects descriptions over 100 characters");
});

/** Registers `run` as a free tool and returns what a client receives for one call. */
async function freeToolResult(run: ToolDef["run"]) {
  let handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; structuredContent: Record<string, unknown> }> =
    async () => ({ content: [], structuredContent: {} });
  const server = { registerTool: (_n: string, _c: unknown, h: typeof handler) => { handler = h; } } as unknown as McpServer;
  const def: ToolDef = { name: "hl_test_errors", tier: "free", title: "t", description: "d", inputSchema: {}, annotations: {}, run };
  registerTool(server, def, { mode: "http" } as unknown as ToolContext);
  return handler({});
}

test("an unexpected error reaches the client as an id, not its internal text", async () => {
  const result = await freeToolResult(async () => {
    throw new Error("SQLITE_CORRUPT: database disk image is malformed (/app/data/hypersignal.db)");
  });

  assert.ok(!JSON.stringify(result).includes("SQLITE"), "internal details must stay in the server log");
  assert.match(String(result.structuredContent.errorId), /^[0-9a-f]{8}$/);
});

test("an upstream error does not forward a slice of the upstream response body", async () => {
  const result = await freeToolResult(async () => {
    throw new UpstreamError("Hyperliquid returned HTTP 502", { status: 502, bodyPreview: "<html>internal gateway trace</html>" });
  });

  assert.equal(result.structuredContent.bodyPreview, undefined);
  assert.equal(result.structuredContent.status, 502);
});

test("hl_admin_stats is not exposed on the remote server, only locally", async () => {
  const { registerTools } = await import("../src/tools/index.js");
  const names = (mode: "http" | "stdio") => {
    const registered: string[] = [];
    const server = { registerTool: (name: string) => registered.push(name) } as unknown as McpServer;
    registerTools(server, { mode } as unknown as ToolContext, ["free", "premium"]);
    return registered;
  };

  assert.equal(names("http").includes("hl_admin_stats"), false);
  assert.equal(names("stdio").includes("hl_admin_stats"), true);
});

test("hl_create_alert caps the active alerts one key may hold", async () => {
  const mine = Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, subject: "key-1", type: "price_move" }));
  const ctx = {
    ...(tradingCtx(5) as object),
    subject: "key-1",
    store: {
      alerts: {
        listActive: () => [...mine, { id: "other", subject: "key-2", type: "price_move" }],
        create: () => ({ id: "new", type: "price_move", params: { coin: "BTC" }, cooldownMinutes: 120 }),
      },
    },
  } as unknown as ToolContext;

  await assert.rejects(
    createAlert.run({ type: "price_move", coin: "BTC", cooldownMinutes: 120 }, ctx),
    (err: unknown) => err instanceof ToolError && err.code === "too_many_alerts",
  );
});

test("hl_create_alert refuses a whale cohort over 100 addresses", () => {
  const cohort = Array.from({ length: 101 }, (_, i) => `0x${String(i).padStart(40, "0")}`);

  assert.equal(createAlert.inputSchema.cohort?.safeParse(cohort).success, false);
});

test("a retried Hyperliquid request is charged again for each attempt", async () => {
  const charged: number[] = [];
  const realAcquire = RateLimiter.prototype.acquire;
  const realFetch = globalThis.fetch;
  let calls = 0;
  RateLimiter.prototype.acquire = async function (weight?: number) {
    charged.push(weight ?? 1);
  };
  globalThis.fetch = (async () => {
    calls++;
    return calls === 1
      ? new Response("busy", { status: 503 })
      : new Response(JSON.stringify([{ universe: [] }, []]), { status: 200 });
  }) as typeof fetch;
  try {
    const hl = new HyperliquidClient({
      infoBaseUrl: "http://hl.test/info", requestTimeoutMs: 1000, maxRetries: 1, rateWeightPerMin: 1200,
    } as unknown as Config);
    await hl.metaAndAssetCtxs();
  } finally {
    RateLimiter.prototype.acquire = realAcquire;
    globalThis.fetch = realFetch;
  }

  // Hyperliquid counts every HTTP request, retries included.
  assert.deepEqual(charged, [20, 20]);
});

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!condition() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
}

test("a WebSocket that stays connected but silent is dropped so it can reconnect", async () => {
  const { WebSocketServer } = await import("ws");
  const { MidsFeed } = await import("../src/core/ws.js");
  const wss = new WebSocketServer({ port: 0 });
  let connections = 0;
  let closedByClient = 0;
  wss.on("connection", (socket) => {
    connections++;
    socket.on("close", () => closedByClient++);
  });
  const { port } = wss.address() as AddressInfo;
  const hl = { metaAndAssetCtxs: async () => [{ universe: [] }, []] } as unknown as HyperliquidClient;
  const feed = new MidsFeed({ wsEnabled: true, wsUrl: `ws://127.0.0.1:${port}` } as unknown as Config, hl);
  const realNow = Date.now;
  try {
    feed.ensureConnected();
    await waitFor(() => connections === 1);
    await new Promise((resolve) => setTimeout(resolve, 50)); // let the client see "open"
    // A minute of silence: a half-open socket never fires "close" by itself.
    Date.now = () => realNow() + 61_000;
    await feed.getMid("BTC");
    Date.now = realNow;
    await waitFor(() => closedByClient === 1);
  } finally {
    Date.now = realNow;
    feed.close();
    wss.close();
  }

  assert.equal(closedByClient, 1);
});

test("a stale auto cohort is served, flagged, when there is no other source", async () => {
  const { resolveCohort } = await import("../src/hl/cohort.js");
  const ctx = {
    config: { whaleAddresses: [], leaderboardUrl: undefined, requestTimeoutMs: 1000 },
    store: {
      cohort: {
        get: () => ({ addresses: ["0x1111111111111111111111111111111111111111"], ageSeconds: 3 * 86_400, strategy: "top_pnl" }),
      },
    },
  } as unknown as ToolContext;

  // The leaderboard refresher failing for a day used to stop every whale tool and the sampler.
  const cohort = await resolveCohort(ctx, undefined, 50);

  assert.equal(cohort.source, "auto_stale");
  assert.equal(cohort.addresses.length, 1);
});

test("the public track record counts only the server's own (house) signals", async () => {
  const { SignalStore } = await import("../src/store/signalStore.js");
  const store = new SignalStore(new BetterSqlite3(":memory:"));
  const house = store.record({ type: "funding_apr", coin: "BTC", direction: "short", refPx: 100, horizonMinutes: 1440, origin: "house" });
  const user = store.record({ type: "funding_apr", coin: "ETH", direction: "long", refPx: 100, horizonMinutes: 1440 });
  store.setScore(house, 101, -0.01, 2_000, "live");
  store.setScore(user, 99, 0.05, 2_000, "live");

  // A user's alerts can be tuned to flatter the record; the server's cannot.
  const [record] = store.trackRecord(undefined, "house");

  assert.equal(record.total, 1);
  assert.equal(record.scored, 1);
});

test("a house alert firing records its signal as house", async () => {
  const { HOUSE_SUBJECT } = await import("../src/alerts/house.js");
  const alert: AlertRecord = {
    id: "h", subject: HOUSE_SUBJECT, type: "price_move", params: { coin: "BTC", movePct: 0.01, windowMinutes: 60 },
    enabled: true, cooldownMinutes: 60, lastFiredAt: null, lastState: null, createdAt: 0,
  };
  const recorded: Array<{ origin?: string }> = [];
  const store = {
    alerts: { listActive: () => [alert], updateState: () => undefined, recordFired: () => undefined },
    signals: { dueForScoring: () => [], record: (s: { origin?: string }) => recorded.push(s) },
    snapshots: { record: () => undefined, nearest: () => ({ value: { px: 59_000 }, at: 0 }) },
    scores: { due: () => [] },
  } as unknown as Warehouse;
  const hl = { metaAndAssetCtxs: (tradingCtx(5) as unknown as { hl: HyperliquidClient }).hl.metaAndAssetCtxs } as unknown as HyperliquidClient;
  const signer = { sign: () => ({ signature: "sig" }) } as unknown as SignalSigner;

  await new AlertEngine(hl, store, signer, { store, hl } as unknown as ToolContext).tick(1_000_000);

  assert.deepEqual(recorded.map((s) => s.origin), ["house"]);
});

test("ensureHouseAlerts keeps funding alerts on the top 10 coins by open interest plus BTC/ETH whale flips", async () => {
  const { ensureHouseAlerts, HOUSE_SUBJECT } = await import("../src/alerts/house.js");
  const { AlertStore } = await import("../src/store/alertStore.js");
  const alerts = new AlertStore(new BetterSqlite3(":memory:"));
  const market = (coins: string[]) => ({
    metaAndAssetCtxs: async () => [
      { universe: coins.map((name) => ({ name, szDecimals: 2, maxLeverage: 10 })) },
      // Open interest falls with position in the list, so the first ten are the top ten.
      coins.map((_, i) => ({ markPx: "10", prevDayPx: "10", funding: "0", oraclePx: "10", openInterest: String(1000 - i), dayNtlVlm: "0" })),
    ],
  }) as unknown as HyperliquidClient;
  const coins = ["BTC", "ETH", "SOL", "XRP", "DOGE", "HYPE", "SUI", "AVAX", "LINK", "BNB", "LTC", "ADA"];

  await ensureHouseAlerts(market(coins), alerts);
  // ADA overtakes BNB: BNB's funding alert goes, ADA's arrives, nothing is duplicated.
  await ensureHouseAlerts(market([...coins.slice(0, 9), "ADA", "LTC", "BNB"]), alerts);

  const house = alerts.list(HOUSE_SUBJECT);
  const funding = house.filter((a) => a.type === "funding_apr").map((a) => a.params.coin).sort();
  const flips = house.filter((a) => a.type === "whale_net_flip").map((a) => a.params.coin).sort();
  assert.deepEqual(funding, [...coins.slice(0, 9), "ADA"].sort());
  assert.deepEqual(flips, ["BTC", "ETH"]);
});

test("the public proof publishes house signals, calibration and the signing key", async () => {
  const { buildPublicProof } = await import("../src/public/proof.js");
  const origins: Array<string | undefined> = [];
  const store = {
    signals: {
      trackRecord: (_type?: string, origin?: string) => {
        origins.push(origin);
        return [{ type: "funding_apr", total: 4, scored: 3, wins: 2, hitRatePct: 66.67, avgReturnPct: 0.4, medianReturnPct: 0.3, excludedStale: 0 }];
      },
    },
    scores: { outcomes: () => [], counts: () => ({ total: 10, resolved: 0, pending: 10 }), abandoned: () => 0 },
  } as unknown as Warehouse;
  const signer = { publicKey: () => "MCowBQYDK2VwAyEA", ephemeral: false } as unknown as SignalSigner;

  const proof = buildPublicProof(store, signer, "1.7.0", 5_000);

  assert.deepEqual(origins, ["house"]);
  assert.equal(proof.houseSignals[0].hitRatePct, 66.67);
  assert.equal(proof.calibration.verdict, "insufficient_data");
  assert.equal(proof.signing.publicKey, "MCowBQYDK2VwAyEA");
});

test("the public track record page escapes what it renders", async () => {
  const { renderProofHtml } = await import("../src/public/proof.js");
  const html = renderProofHtml({
    server: "hypersignal-mcp", version: "1.7.0", generatedAt: 0,
    signing: { alg: "ed25519", publicKey: "key<script>", persistent: true },
    calibration: { n: 0, spearman: null, pValue: null, quartiles: [], verdict: "insufficient_data", observations: { total: 1, resolved: 0, pending: 1, abandoned: 0 } },
    houseSignals: [{ type: "<img onerror=x>", total: 1, scored: 0, wins: 0, hitRatePct: 0, avgReturnPct: 0, medianReturnPct: 0, excludedStale: 0 }],
  });

  assert.ok(!html.includes("<script>") && !html.includes("<img"), "every value is HTML-escaped");
  assert.ok(html.includes("insufficient_data"));
});

test("the server exposes proof resources and briefing prompts to MCP clients", async () => {
  const { registerResourcesAndPrompts } = await import("../src/mcp/resourcesAndPrompts.js");
  const resources = new Map<string, (uri: URL) => Promise<{ contents: Array<{ text: string }> }>>();
  const prompts = new Map<string, (args: Record<string, string>) => Promise<{ messages: Array<{ content: { text: string } }> }>>();
  const server = {
    registerResource: (name: string, _uri: string, _meta: unknown, read: (uri: URL) => Promise<{ contents: Array<{ text: string }> }>) =>
      resources.set(name, read),
    registerPrompt: (name: string, _cfg: unknown, cb: (args: Record<string, string>) => Promise<{ messages: Array<{ content: { text: string } }> }>) =>
      prompts.set(name, cb),
  } as unknown as McpServer;
  const ctx = {
    store: {
      signals: { trackRecord: () => [{ type: "funding_apr", total: 2, scored: 1, wins: 1, hitRatePct: 100, avgReturnPct: 1, medianReturnPct: 1, excludedStale: 0 }] },
      scores: { outcomes: () => [], counts: () => ({ total: 0, resolved: 0, pending: 0 }), abandoned: () => 0 },
    },
    signer: { publicKey: () => "PUBKEY", ephemeral: false },
  } as unknown as ToolContext;

  registerResourcesAndPrompts(server, ctx, "1.7.0");

  assert.deepEqual([...resources.keys()].sort(), ["about", "calibration", "signal-pubkey", "track-record"]);
  assert.deepEqual([...prompts.keys()].sort(), ["funding_carry_scan", "wallet_risk_check", "whale_briefing"]);
  const record = JSON.parse((await resources.get("track-record")!(new URL("hypersignal://track-record"))).contents[0].text);
  assert.equal(record[0].hitRatePct, 100);
  const briefing = (await prompts.get("whale_briefing")!({ coin: "ETH" })).messages[0].content.text;
  assert.ok(briefing.includes("hl_whale_positions") && briefing.includes("ETH"));
});

/** Main dex with BTC; HIP-3 dex "xyz" with XYZ100 at index 0 (the same index as BTC on the main dex). */
function hip3Hl(extra: Record<string, unknown> = {}) {
  const ctxRow = (px: string) => ({ markPx: px, midPx: px, prevDayPx: px, funding: "0", oraclePx: px, openInterest: "10", dayNtlVlm: "0" });
  return {
    metaAndAssetCtxs: async () => [{ universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] }, [ctxRow("60000")]],
    metaAndAssetCtxsForDex: async (dex: string) =>
      dex === "xyz" ? [{ universe: [{ name: "xyz:XYZ100", szDecimals: 4, maxLeverage: 20 }] }, [ctxRow("29800")]] : [{ universe: [] }, []],
    ...extra,
  } as unknown as HyperliquidClient;
}

test("resolveMarket finds a HIP-3 coin on its builder dex", async () => {
  const { resolveMarket } = await import("../src/hl/markets.js");

  const market = await resolveMarket(hip3Hl(), "XYZ:xyz100");

  assert.equal(market.coin, "xyz:XYZ100");
  assert.equal(market.markPx, 29800);
});

test("hl_get_account with dex 'all' shows positions on every perp dex", async () => {
  const { getAccount } = await import("../src/tools/free/getAccount.js");
  const xyzState = { ...walletWithBtc(1), assetPositions: walletWithBtc(1).assetPositions.map((p) => ({ ...p, position: { ...p.position, coin: "xyz:XYZ100" } })) };
  const hl = hip3Hl({
    perpDexs: async () => [null, { name: "xyz" }],
    clearinghouseState: async (_user: string, dex?: string) => (dex === "xyz" ? xyzState : walletWithBtc(1)),
  });

  const { data } = await getAccount.run({ address: "0x1111111111111111111111111111111111111111", dex: "all" }, { hl } as unknown as ToolContext);

  assert.deepEqual((data as { positions: Array<{ coin: string }> }).positions.map((p) => p.coin).sort(), ["BTC", "xyz:XYZ100"]);
});

test("an alert on a HIP-3 coin is evaluated against that dex's market", async () => {
  const alert: AlertRecord = {
    id: "x", subject: "s", type: "price_move", params: { coin: "xyz:XYZ100", movePct: 0.01, windowMinutes: 60 },
    enabled: true, cooldownMinutes: 60, lastFiredAt: null, lastState: null, createdAt: 0,
  };
  const recorded: unknown[] = [];
  const store = {
    alerts: { listActive: () => [alert], updateState: () => undefined, recordFired: () => undefined },
    signals: { dueForScoring: () => [], record: (s: unknown) => recorded.push(s) },
    snapshots: { record: () => undefined, nearest: () => ({ value: { px: 29_000 }, at: 0 }) },
    scores: { due: () => [] },
  } as unknown as Warehouse;
  const signer = { sign: () => ({ signature: "sig" }) } as unknown as SignalSigner;

  const fired = await new AlertEngine(hip3Hl(), store, signer, { store } as unknown as ToolContext).tick(1_000_000);

  assert.equal(fired, 1);
});

test("placeOrder refuses a HIP-3 coin rather than trade the main dex asset at the same index", async () => {
  const config = {
    tradingEnabled: false, agentPrivateKey: undefined, builder: { address: undefined, feeTenthsBps: 5 },
    network: "testnet", maxOrderNotionalUsd: 10_000,
  } as unknown as Config;

  await assert.rejects(
    new TradingService(config, hip3Hl()).placeOrder({ coin: "xyz:XYZ100", isBuy: true, sz: 0.01, reduceOnly: false, tif: "Ioc" }, { confirm: false, dryRun: true }),
    (err: unknown) => err instanceof ToolError && err.code === "hip3_trading_unsupported",
  );
});

/** Stubs Telegram's Bot API; returns the sent messages and a restore function. */
function stubTelegram(username = "hypersignal_bot") {
  const sent: Array<{ chat_id: string; text: string }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const method = String(url).split("/").pop();
    if (method === "getMe") return new Response(JSON.stringify({ ok: true, result: { username } }));
    if (method === "sendMessage") sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ok: true, result: {} }));
  }) as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = realFetch; } };
}

test("a Telegram link code links the key's chat once and expires after 15 minutes", async () => {
  const { TelegramStore } = await import("../src/telegram/store.js");
  const store = new TelegramStore(new BetterSqlite3(":memory:"));

  const code = store.createLinkCode("key-1", 0);
  const expired = store.createLinkCode("key-2", 0);

  assert.equal(store.redeem(code, "chat-9", 60_000), "key-1");
  assert.equal(store.redeem(code, "chat-9", 60_000), undefined, "a code works once");
  assert.equal(store.redeem(expired, "chat-8", 16 * 60_000), undefined);
  assert.equal(store.chatFor("key-1"), "chat-9");
});

test("the bot links a chat on /start <code> and unlinks it on /stop", async () => {
  const { TelegramStore } = await import("../src/telegram/store.js");
  const { TelegramBot } = await import("../src/telegram/bot.js");
  const store = new TelegramStore(new BetterSqlite3(":memory:"));
  const bot = new TelegramBot("TEST-TOKEN", store);
  const tg = stubTelegram();
  const code = store.createLinkCode("key-1");
  let linked: string | undefined;
  try {
    await bot.handleUpdate({ update_id: 1, message: { chat: { id: 42 }, text: `/start ${code}` } });
    linked = store.chatFor("key-1");
    await bot.handleUpdate({ update_id: 2, message: { chat: { id: 42 }, text: "/stop" } });
  } finally {
    tg.restore();
  }

  assert.equal(linked, "42");
  assert.equal(store.chatFor("key-1"), undefined);
  assert.equal(tg.sent.length, 2, "both commands are answered");
});

test("the bot sends at most 30 alert messages an hour to one chat", async () => {
  const { TelegramStore } = await import("../src/telegram/store.js");
  const { TelegramBot } = await import("../src/telegram/bot.js");
  const store = new TelegramStore(new BetterSqlite3(":memory:"));
  store.link("key-1", "42");
  const bot = new TelegramBot("TEST-TOKEN", store);
  const tg = stubTelegram();
  try {
    for (let i = 0; i < 31; i++) await bot.notify("key-1", `alert ${i}`);
  } finally {
    tg.restore();
  }

  assert.equal(tg.sent.length, 30);
});

test("a firing alert is handed to the notifier with its owner", async () => {
  const alert: AlertRecord = {
    id: "n", subject: "key-7", type: "price_move", params: { coin: "BTC", movePct: 0.01, windowMinutes: 60 },
    enabled: true, cooldownMinutes: 60, lastFiredAt: null, lastState: null, createdAt: 0,
  };
  const store = {
    alerts: { listActive: () => [alert], updateState: () => undefined, recordFired: () => undefined },
    signals: { dueForScoring: () => [], record: () => "id" },
    snapshots: { record: () => undefined, nearest: () => ({ value: { px: 59_000 }, at: 0 }) },
    scores: { due: () => [] },
  } as unknown as Warehouse;
  const notified: string[] = [];
  const signer = { sign: () => ({ signature: "sig" }) } as unknown as SignalSigner;
  const engine = new AlertEngine(hip3Hl(), store, signer, { store } as unknown as ToolContext, (subject) => notified.push(subject));

  await engine.tick(1_000_000);

  assert.deepEqual(notified, ["key-7"]);
});

test("hl_link_telegram returns a one-time t.me link, or says Telegram is not configured", async () => {
  const { linkTelegram } = await import("../src/tools/free/telegram.js");
  const { TelegramStore } = await import("../src/telegram/store.js");
  const { TelegramBot } = await import("../src/telegram/bot.js");
  const bot = new TelegramBot("TEST-TOKEN", new TelegramStore(new BetterSqlite3(":memory:")));
  const tg = stubTelegram("hypersignal_bot");
  let link = "";
  try {
    const { data } = await linkTelegram.run({}, { subject: "key-1", telegram: bot } as unknown as ToolContext);
    link = (data as { link: string }).link;
  } finally {
    tg.restore();
  }

  assert.match(link, /^https:\/\/t\.me\/hypersignal_bot\?start=[0-9a-f]{16}$/);
  await assert.rejects(
    linkTelegram.run({}, { subject: "key-1" } as unknown as ToolContext),
    (err: unknown) => err instanceof ToolError && err.code === "telegram_not_configured",
  );
});

test("calibration keeps one observation per wallet per non-overlapping forward window", () => {
  const store = new ScoreStore(new BetterSqlite3(":memory:"));
  const day = 86_400_000;
  // The daily sampler scores the same wallets every day with a 30-day forward
  // window: consecutive rows share 29 of 30 days and are not independent.
  for (const address of ["0xa", "0xb"]) {
    for (let d = 0; d < 40; d++) {
      store.record({ address, score: d, accountValue: 1_000, horizonDays: 30, ts: d * day });
    }
  }
  for (const row of store.due(1_000, 400 * day)) store.setOutcome(row.id, 10);

  const outcomes = store.outcomes();

  // Day 0 and day 30 for each wallet; day 1..29 overlap day 0's window.
  assert.equal(outcomes.length, 4);
});

test("webhook targets on private, loopback or link-local addresses are refused", async () => {
  const { isPrivateAddress } = await import("../src/webhook/webhooks.js");
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  assert.equal(isPrivateAddress("93.184.216.34"), false);
  assert.equal(isPrivateAddress("2606:4700::1111"), false);
});

test("a webhook URL must be https and resolve only to public addresses", async () => {
  const { assertPublicHttpsUrl } = await import("../src/webhook/webhooks.js");
  const resolvesTo = (address: string) => async () => [{ address, family: address.includes(":") ? 6 : 4 }];

  await assert.rejects(assertPublicHttpsUrl("http://example.com/hook", resolvesTo("93.184.216.34")));
  await assert.rejects(assertPublicHttpsUrl("https://internal.example/hook", resolvesTo("10.0.0.5")));
  await assertPublicHttpsUrl("https://example.com/hook", resolvesTo("93.184.216.34"));
});

test("webhook deliveries are HMAC-signed and capped at 30 an hour per key", async () => {
  const { WebhookStore, WebhookSender } = await import("../src/webhook/webhooks.js");
  const { createHmac } = await import("node:crypto");
  const store = new WebhookStore(new BetterSqlite3(":memory:"));
  const secret = store.set("key-1", "https://example.com/hook");
  const sender = new WebhookSender(store, async () => [{ address: "93.184.216.34", family: 4 }]);
  const posts: Array<{ body: string; signature: string | null; redirect?: string }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown; headers?: Record<string, string>; redirect?: string }) => {
    posts.push({ body: String(init?.body), signature: init?.headers?.["x-hypersignal-signature"] ?? null, redirect: init?.redirect });
    return new Response("ok");
  }) as typeof fetch;
  try {
    for (let i = 0; i < 31; i++) await sender.notify("key-1", { message: `alert ${i}` });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(posts.length, 30);
  assert.equal(posts[0].signature, `sha256=${createHmac("sha256", secret).update(posts[0].body).digest("hex")}`);
  assert.equal(posts[0].redirect, "manual", "a redirect must not lead the server to an internal address");
});

test("hl_set_webhook validates the URL and returns the signing secret once", async () => {
  const { setWebhook, deleteWebhook } = await import("../src/tools/free/webhook.js");
  const { WebhookStore, WebhookSender } = await import("../src/webhook/webhooks.js");
  const sender = new WebhookSender(new WebhookStore(new BetterSqlite3(":memory:")), async () => [{ address: "93.184.216.34", family: 4 }]);
  const ctx = { subject: "key-1", webhooks: sender } as unknown as ToolContext;

  const { data } = await setWebhook.run({ url: "https://example.com/hook" }, ctx);
  await assert.rejects(setWebhook.run({ url: "http://example.com/hook" }, ctx));
  const removed = await deleteWebhook.run({}, ctx);

  assert.match((data as { secret: string }).secret, /^[0-9a-f]{64}$/);
  assert.equal((removed.data as { deleted: boolean }).deleted, true);
});

/** walletWithBtc with the position on another coin, e.g. the HIP-3 "xyz:XYZ100". */
function walletWith(coin: string, szi: number, liquidationPx: string | null = null) {
  const s = walletWithBtc(szi);
  return { ...s, assetPositions: s.assetPositions.map((p) => ({ ...p, position: { ...p.position, coin, liquidationPx } })) };
}

/** Main dex holds BTC long; the "xyz" dex holds XYZ100 with the given size. */
function hip3WhaleCtx(xyzSzi = 1) {
  const hl = hip3Hl({
    perpDexs: async () => [null, { name: "xyz" }],
    clearinghouseState: async (_user: string, dex?: string) => (dex === "xyz" ? walletWith("xyz:XYZ100", xyzSzi, "25000") : walletWithBtc(1)),
  });
  return { hl, snapshots: new InMemorySnapshotStore(), store: { cohort: { get: () => null } } } as unknown as ToolContext;
}

const WHALE = "0x1111111111111111111111111111111111111111";

test("hl_liquidation_map for a HIP-3 coin reads the cohort's positions on that coin's dex", async () => {
  const { liquidationMap } = await import("../src/tools/premium/liquidationMap.js");

  const { data } = await liquidationMap.run({ coin: "xyz:XYZ100", cohort: [WHALE] }, hip3WhaleCtx());

  assert.equal((data as { positionsConsidered: number }).positionsConsidered, 1);
});

test("hl_whale_positions for a HIP-3 coin aggregates that dex's positions", async () => {
  const { data } = await whalePositions.run({ coin: "xyz:XYZ100", cohort: [WHALE] }, hip3WhaleCtx());

  assert.deepEqual((data as { coins: Array<{ coin: string }> }).coins.map((c) => c.coin), ["xyz:XYZ100"]);
});

test("whale tools over every dex cap the cohort so one call cannot spend the whole rate budget", async () => {
  const cohort = Array.from({ length: 30 }, (_, i) => `0x${String(i + 1).padStart(40, "0")}`);

  const { data } = await whalePositions.run({ dex: "all", cohort, topN: 30 }, hip3WhaleCtx());

  const out = data as { walletsRequested: number; walletsCappedTo: number | null; coins: Array<{ coin: string }> };
  assert.equal(out.walletsRequested, 20);
  assert.equal(out.walletsCappedTo, 20);
  assert.deepEqual(out.coins.map((c) => c.coin).sort(), ["BTC", "xyz:XYZ100"]);
});

test("whale flow on one HIP-3 dex does not report the cohort's main-dex coins as fully exited", async () => {
  const ctx = hip3WhaleCtx();
  // An hour ago the same cohort was scanned on the main dex and held BTC.
  (ctx.snapshots as InMemorySnapshotStore).record("whaleFlow", `BTC:${shortHash(WHALE)}`, { netNtlUsd: 60_000 }, Date.now() - 3_600_000);

  const { data } = await whaleFlowAlerts.run({ dex: "xyz", cohort: [WHALE], thresholdUsd: 1_000, lookbackMinutes: 60 }, ctx);

  const out = data as { dex: string; alerts: Array<{ coin: string }> };
  assert.equal(out.dex, "xyz");
  assert.deepEqual(out.alerts.map((a) => a.coin), []);
});

test("whale_net_flip on a HIP-3 coin fires from that dex's cohort positions", async () => {
  const alert: AlertRecord = {
    id: "h", subject: "s", type: "whale_net_flip", params: { coin: "xyz:XYZ100", cohort: [WHALE] },
    enabled: true, cooldownMinutes: 5, lastFiredAt: null, lastState: { sign: -1 }, createdAt: 0,
  };
  const store = {
    alerts: { listActive: () => [alert], updateState: () => undefined, recordFired: () => undefined },
    signals: { dueForScoring: () => [], record: () => undefined },
    snapshots: { record: () => undefined },
    scores: { due: () => [] },
  } as unknown as Warehouse;
  const ctx = hip3WhaleCtx(); // the cohort is now net long XYZ100
  const signer = { sign: () => ({ signature: "sig" }) } as unknown as SignalSigner;

  const fired = await new AlertEngine(ctx.hl, store, signer, { ...ctx, store } as unknown as ToolContext).tick(1_000_000);

  assert.equal(fired, 1);
});

test("a whale tool's dex argument is read case-insensitively, and 'main' means the main dex", async () => {
  const xyz = await whalePositions.run({ dex: " XYZ ", cohort: [WHALE] }, hip3WhaleCtx());
  const main = await whalePositions.run({ dex: "main", cohort: [WHALE] }, hip3WhaleCtx());

  assert.deepEqual((xyz.data as { coins: Array<{ coin: string }> }).coins.map((c) => c.coin), ["xyz:XYZ100"]);
  assert.deepEqual((main.data as { coins: Array<{ coin: string }> }).coins.map((c) => c.coin), ["BTC"]);
});

test("an unknown dex name is a clear error listing the known dexes, not an empty or internal-error result", async () => {
  const { getAccount } = await import("../src/tools/free/getAccount.js");
  const { getOpenOrders } = await import("../src/tools/free/getOpenOrders.js");
  // The live API answers an unknown dex with null.
  const hl = hip3Hl({ perpDexs: async () => [null, { name: "xyz" }], clearinghouseState: async () => null, openOrders: async () => null });
  const ctx = { hl, snapshots: new InMemorySnapshotStore(), store: { cohort: { get: () => null } } } as unknown as ToolContext;
  const unknownDex = (err: unknown) => err instanceof ToolError && err.code === "unknown_dex" && err.message.includes("xyz");

  await assert.rejects(getAccount.run({ address: WHALE, dex: "xzy" }, ctx), unknownDex);
  await assert.rejects(getOpenOrders.run({ address: WHALE, dex: "xzy" }, ctx), unknownDex);
  await assert.rejects(whalePositions.run({ dex: "xzy", cohort: [WHALE] }, ctx), unknownDex);
});

test("a whale alert on a delisted HIP-3 dex does not stop the same cohort's main-dex alerts", async () => {
  const alert = (id: string, coin: string): AlertRecord => ({
    id, subject: "s", type: "whale_net_flip", params: { coin, cohort: [WHALE] },
    enabled: true, cooldownMinutes: 5, lastFiredAt: null, lastState: { sign: -1 }, createdAt: 0,
  });
  const store = {
    alerts: { listActive: () => [alert("gone", "gone:OLD"), alert("btc", "BTC")], updateState: () => undefined, recordFired: () => undefined },
    signals: { dueForScoring: () => [], record: () => undefined },
    snapshots: { record: () => undefined },
    scores: { due: () => [] },
  } as unknown as Warehouse;
  const ctx = hip3WhaleCtx(); // "gone" is not among the live dexes; the cohort is now net long BTC
  const signer = { sign: () => ({ signature: "sig" }) } as unknown as SignalSigner;

  const fired = await new AlertEngine(ctx.hl, store, signer, { ...ctx, store } as unknown as ToolContext).tick(1_000_000);

  assert.equal(fired, 1);
});

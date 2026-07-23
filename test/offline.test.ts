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
import type { HyperliquidClient } from "../src/core/hlClient.js";
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
import { normCdf, annualizedVol, probAboveAtExpiry, probTouchAbove, impliedProbForMode } from "../src/polymarket/pricing.js";
import { parseThresholdMarket, parseThresholdUsd, yearsToExpiry } from "../src/polymarket/parse.js";
import { aggregateByCoin, type CohortAccount } from "../src/hl/whales.js";
import { clampFee } from "../src/config.js";
import { TtlLruCache } from "../src/core/cache.js";
import { InMemorySnapshotStore } from "../src/core/snapshots.js";

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
  const c = planTwap({ totalSize: 10, slices: 4, durationMs: 3 * 60_000 });
  assert.equal(c.length, 4);
  assert.equal(round(c.reduce((a, x) => a + x.size, 0), 6), 10);
  assert.equal(c[0].atOffsetMs, 0);
  assert.equal(c[3].atOffsetMs, 180_000); // last at full duration
  // rounding drift folded into last slice
  const d = planTwap({ totalSize: 1, slices: 3, durationMs: 0 });
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
    mk("A", [["BTC", 0.7], ["ETH", 0.3]]),
    mk("B", [["BTC", 0.72], ["ETH", 0.28]]),
    mk("C", [["BTC", -0.7], ["ETH", -0.3]]),
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
    /agent wallet's own positions/,
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

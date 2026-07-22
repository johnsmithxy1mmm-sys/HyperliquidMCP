/**
 * Offline unit tests for pure logic (no Hyperliquid network needed).
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { formatPrice, formatSize, actionHash, signL1Action, addressForKey } from "../src/trading/signing.js";
import { sharpe, sortino, maxDrawdown, annualizeHourlyFunding, paginate, round } from "../src/core/format.js";
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

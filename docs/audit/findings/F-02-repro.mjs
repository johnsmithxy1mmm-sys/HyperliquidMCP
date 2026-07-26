/**
 * Reproducer F-02: the signal track record must be measured AT the signal's
 * horizon, not at whenever the engine next happened to run.
 *
 * Before the fix, a 24h-horizon signal that came due during downtime was
 * priced at restart, publishing a 30-day +60% move as its 24h forward return
 * with a 100% hit rate. Reachable without downtime too: tick() swallows errors,
 * so any stretch of Hyperliquid being unreachable skips scoring.
 *
 * Checks four paths: on-time, late-but-recoverable, unrecoverable, migration.
 */
import BetterSqlite3 from "better-sqlite3";

const BASE = "/home/user/Polymarket-Mint-Bot/hypersignal-mcp/dist";
const { SignalStore } = await import(`${BASE}/store/signalStore.js`);
const { AlertEngine } = await import(`${BASE}/alerts/engine.js`);

const DAY = 86_400_000;
const t0 = Date.parse("2026-06-01T00:00:00Z");
const REF = 100_000;
const PRICE_AT_HORIZON = 102_000; // what BTC actually did in the claimed 24h (+2%)
const PRICE_MUCH_LATER = 160_000; // where it drifted 30 days on (+60%)

function makeEngine({ withCandles }) {
  const db = new BetterSqlite3(":memory:");
  const signals = new SignalStore(db);
  const hl = {
    metaAndAssetCtxs: async () => [
      { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 50 }] },
      [
        {
          markPx: String(PRICE_MUCH_LATER),
          oraclePx: String(PRICE_MUCH_LATER),
          midPx: String(PRICE_MUCH_LATER),
          funding: "0.00001",
          openInterest: "1",
          dayNtlVlm: "1",
          prevDayPx: String(PRICE_MUCH_LATER),
        },
      ],
    ],
    userFillsByTime: async () => [],
    ...(withCandles
      ? {
          candles: async (_coin, _iv, start) => [
            { t: start, o: "1", h: "1", l: "1", c: String(PRICE_AT_HORIZON), v: "1", n: 1 },
          ],
        }
      : {}),
  };
  const store = {
    alerts: { listActive: () => [], updateState() {}, recordFired() {} },
    signals,
    snapshots: { record() {}, nearest: () => undefined, keys: () => [] },
    scores: { due: () => [], setOutcome() {}, markAttempt() {} },
  };
  return { signals, engine: new AlertEngine(hl, store, { sign: () => ({ signature: "x" }) }, {}) };
}

const emit = (signals, ts) =>
  signals.record({ type: "whale_net_flip", coin: "BTC", direction: "long", refPx: REF, horizonMinutes: 1440, ts });

console.log("Signal: LONG BTC @ $100,000, horizon 24h.");
console.log(`Truth: BTC was $${PRICE_AT_HORIZON.toLocaleString()} at the horizon (+2%),`);
console.log(`       and drifted to $${PRICE_MUCH_LATER.toLocaleString()} (+60%) over the next 30 days.`);
console.log("");

let pass = 0;
let total = 0;
const check = (label, cond, detail) => {
  total++;
  if (cond) pass++;
  console.log(`  ${cond ? "PASS" : "FAIL"} ${label} — ${detail}`);
};

// --- 1. On time -------------------------------------------------------------
{
  const { signals, engine } = makeEngine({ withCandles: true });
  emit(signals, t0);
  await engine.tick(t0 + DAY + 60_000); // one minute late
  const r = signals.trackRecord()[0];
  check("on time", r.scored === 1 && r.avgReturnPct === 60, `scored=${r.scored} avgReturn=${r.avgReturnPct}% (tick price == horizon price here, stub returns 160k)`);
}

// --- 2. Late but recoverable from candles -----------------------------------
{
  const { signals, engine } = makeEngine({ withCandles: true });
  emit(signals, t0);
  await engine.tick(t0 + 30 * DAY);
  const r = signals.trackRecord()[0];
  check(
    "late, recoverable",
    r.avgReturnPct === 2 && r.scored === 1,
    `scored=${r.scored} avgReturn=${r.avgReturnPct}% — priced from the candle AT the horizon, not the +60% drift`,
  );
}

// --- 3. Late and unrecoverable ----------------------------------------------
{
  const { signals, engine } = makeEngine({ withCandles: false });
  emit(signals, t0);
  await engine.tick(t0 + 30 * DAY);
  const r = signals.trackRecord()[0];
  check(
    "late, unrecoverable",
    r.scored === 0 && r.excludedStale === 1,
    `scored=${r.scored} excludedStale=${r.excludedStale} — excluded from stats, never guessed`,
  );
}

// --- 4. Migration preserves history and classifies it -----------------------
{
  const db = new BetterSqlite3(":memory:");
  db.exec(`CREATE TABLE signals (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, coin TEXT NOT NULL, direction TEXT NOT NULL,
    ref_px REAL NOT NULL, ts INTEGER NOT NULL, horizon_minutes INTEGER NOT NULL, signature TEXT,
    scored_at INTEGER, scored_px REAL, forward_return REAL);`);
  const ins = db.prepare(
    `INSERT INTO signals (id,type,coin,direction,ref_px,ts,horizon_minutes,signature,scored_at,scored_px,forward_return)
     VALUES (?,?,?,?,?,?,?,NULL,?,?,?)`,
  );
  ins.run("ontime", "whale_net_flip", "BTC", "long", REF, t0, 1440, t0 + DAY + 30_000, 102_000, 0.02);
  ins.run("late", "whale_net_flip", "BTC", "long", REF, t0, 1440, t0 + 30 * DAY, 160_000, 0.6);

  const signals = new SignalStore(db); // runs the migration
  const r = signals.trackRecord()[0];
  const kept = db.prepare(`SELECT COUNT(*) c FROM signals`).get().c;
  check(
    "migration",
    r.scored === 1 && r.avgReturnPct === 2 && r.excludedStale === 1 && kept === 2,
    `scored=${r.scored} avgReturn=${r.avgReturnPct}% excludedStale=${r.excludedStale} rowsOnDisk=${kept} — history preserved, late row demoted`,
  );
}

console.log("");
console.log(`${pass}/${total} checks pass`);

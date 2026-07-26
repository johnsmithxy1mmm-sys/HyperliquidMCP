/**
 * Reproducer F-03: hl_copy_wallet must be idempotent.
 *
 * Before the fix it re-mirrored the target's FULL position on every call with
 * reduceOnly:false, so "keep me in sync with this whale" — the normal way an
 * agent uses a copy tool — compounded exposure without limit. It also sized
 * orders from a caller-supplied equity that was never checked against the real
 * account, and evaluated no risk limit before signing.
 *
 * Models the live configuration: agent key present, own positions tracked.
 */
const BASE = "/home/user/Polymarket-Mint-Bot/hypersignal-mcp/dist";
const { copyWallet } = await import(`${BASE}/tools/trading/execution.js`);

const TARGET = "0x1111111111111111111111111111111111111111";
// Hardhat account #0 — a well-known throwaway test key, never funded.
const AGENT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const acct = (equity, positions) => ({
  marginSummary: { accountValue: String(equity), totalNtlPos: "0", totalRawUsd: "0", totalMarginUsed: "0" },
  crossMaintenanceMarginUsed: "0",
  withdrawable: "0",
  assetPositions: positions.map(([coin, szi, px]) => ({
    position: {
      coin,
      szi: String(szi),
      entryPx: String(px),
      positionValue: String(Math.abs(szi * px)),
      unrealizedPnl: "0",
      returnOnEquity: "0",
      leverage: { type: "cross", value: 1 },
      liquidationPx: null,
      marginUsed: "0",
      maxLeverage: 50,
    },
  })),
});

// Target whale: $1,000,000 equity, LONG 10 BTC at $100k.
const targetState = acct(1_000_000, [["BTC", 10, 100_000]]);
// Me: $10,000 equity, flat to begin with. Filled orders update this.
let myPositions = [];
const MY_EQUITY = 10_000;

const sent = [];
const ctx = {
  config: { agentPrivateKey: AGENT_KEY },
  hl: {
    clearinghouseState: async (addr) =>
      addr.toLowerCase() === TARGET.toLowerCase() ? targetState : acct(MY_EQUITY, myPositions),
  },
  execution: {},
  trading: {
    placeOrder: async (p) => {
      sent.push(p);
      // Simulate the fill so the next call sees the updated book.
      const signed = p.isBuy ? p.sz : -p.sz;
      const existing = myPositions.find((x) => x[0] === p.coin);
      if (existing) existing[1] += signed;
      else myPositions.push([p.coin, signed, 100_000]);
      myPositions = myPositions.filter((x) => Math.abs(x[1]) > 1e-9);
      return { mode: "submitted", action: {}, builderAttached: null };
    },
  },
};

const run = (over = {}) =>
  copyWallet.run({ targetAddress: TARGET, scale: 1, confirm: true, dryRun: false, ...over }, ctx);

console.log("SETUP: whale $1,000,000 LONG 10 BTC | me $10,000 => proportional mirror 0.1 BTC");
console.log("");
console.log("Agent keeps in sync by calling the tool repeatedly:");
for (let i = 1; i <= 3; i++) {
  const out = await run();
  const held = myPositions.find((x) => x[0] === "BTC")?.[1] ?? 0;
  console.log(
    `  call #${i}: orders=${out.data.orders.length} inSync=${out.data.alreadyInSync}` +
      `  -> holding ${held.toFixed(4)} BTC`,
  );
}

const held = myPositions.find((x) => x[0] === "BTC")?.[1] ?? 0;
console.log("");
console.log(`  intended 0.1 BTC | actual ${held.toFixed(4)} BTC | orders sent total: ${sent.length}`);
const idempotent = Math.abs(held - 0.1) < 1e-9 && sent.length === 1;
console.log(idempotent ? "  PASS — repeat calls are a no-op once in sync" : "  FAIL — exposure compounded");

// --- target exits: our leg must be unwound, not left stranded ---------------
targetState.assetPositions = [];
const exitOut = await run();
const afterExit = myPositions.find((x) => x[0] === "BTC")?.[1] ?? 0;
console.log("");
console.log("Target closes its position:");
console.log(`  orders=${exitOut.data.orders.length} reduceOnly=${exitOut.data.orders[0]?.reduceOnly}` +
  `  -> holding ${afterExit.toFixed(4)} BTC`);
console.log(Math.abs(afterExit) < 1e-9 ? "  PASS — stale leg unwound" : "  FAIL — stale exposure left behind");

// --- risk limits ------------------------------------------------------------
targetState.assetPositions = acct(1_000_000, [["BTC", 10, 100_000]]).assetPositions;
myPositions = [];
console.log("");
console.log("Risk limits:");
for (const [label, over] of [
  ["equity overstated ($10M claimed on a $10k account)", { myEquityUsd: 10_000_000, scale: 10 }],
  ["over-leveraged (scale=10 => 10x equity)", { scale: 10 }],
]) {
  try {
    await run(over);
    console.log(`  FAIL — ${label}: accepted`);
  } catch (e) {
    console.log(`  PASS — ${label}: refused (${e.code})`);
  }
}

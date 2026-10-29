# HyperSignal MCP

[![CI](https://github.com/johnsmithxy1mmm-sys/HyperliquidMCP/actions/workflows/ci.yml/badge.svg)](https://github.com/johnsmithxy1mmm-sys/HyperliquidMCP/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-20%20%7C%2022-brightgreen)](https://nodejs.org)
[![HyperliquidMCP MCP server](https://glama.ai/mcp/servers/johnsmithxy1mmm-sys/HyperliquidMCP/badges/card.svg)](https://glama.ai/mcp/servers/johnsmithxy1mmm-sys/HyperliquidMCP)

**Monetized [MCP](https://modelcontextprotocol.io) server for Hyperliquid analytics & signals.**
Gives AI agents (Claude, Cursor, ChatGPT, autonomous trading agents) the Hyperliquid analytics
that free open-source MCP servers don't have — whale-cohort signals, liquidation maps, funding
screeners, HIP-3 analytics, and ready-made risk reports — plus an optional local trading tier
that attaches a builder code to orders.

> ⚠️ **Analytics, not investment advice.** Trading tools place real orders and are irreversible.

---

## Tiers & tools

### Free (open-source parity — the hook)
| Tool | What it returns |
|---|---|
| `hl_get_markets` | Perp markets: mark/oracle price, hourly + annualized funding, OI, 24h volume; filter/sort |
| `hl_get_orderbook` | L2 book (top-N levels), spread, mid |
| `hl_get_candles` | OHLCV candles by interval/range or lookback |
| `hl_get_funding_history` | Funding history + avg/cumulative |
| `hl_get_account` | Positions, equity, margin, liquidation prices for any address |
| `hl_get_open_orders` | Open resting orders for any address |

### Premium (the differentiator — metered)
| Tool | What it returns |
|---|---|
| `hl_whale_positions` | Aggregated cohort positioning by coin: net long/short, wavg entry, 1h/24h change |
| `hl_whale_flow_alerts` | Recent large cohort position shifts above a USD threshold |
| `hl_liquidation_map` | Liquidation clusters (notional-at-risk by distance from mark), nearest cascades |
| `hl_funding_screener` | Every perp screened by annualized funding + cross-venue spreads |
| `hl_hip3_analytics` | HIP-3 (builder-deployed / RWA / equity) perp metrics + external basis |
| `hl_portfolio_risk` | Liquidation distance, effective leverage, concentration, stress scenarios, PnL Sharpe |
| `hl_vault_screener` | Vaults by APR, max drawdown, Sharpe/Sortino, age, TVL, leader share |
| `hl_trader_report` | Wallet breakdown: winrate, avg R, PnL curve, scalp/swing style, top coins |

### Agent-native (v0.3) — the differentiators
| Tool | Tier | What it does |
|---|---|---|
| `hl_create_alert` / `hl_list_alerts` / `hl_delete_alert` | premium | Register/manage **standing alerts** (funding threshold, price move, whale net-flip). The server evaluates them on a schedule — it watches the market for your agent. |
| `hl_poll_alerts` | premium | Retrieve fired alert events since your last poll (at-least-once), each with a signed signal payload. |
| `hl_signal_track_record` | premium | Transparent, **verifiable performance** of emitted signals: hit-rate and avg/median direction-adjusted forward return per signal type. |
| `hl_request_free_key` | free | **Self-serve API key** — one call, no signup, grants 100 premium calls/month. Send it as `X-API-Key`. This is the intended first call for any new agent: premium tools point at it by name when they need a key. |
| `hl_signal_pubkey` | free | Ed25519 public key to independently **verify** any signal's authenticity + timestamp. |
| `hl_admin_stats` | free (own gate) | **Operator only** — requires `adminSecret` matching `HYPERSIGNAL_ADMIN_SECRET`. Per-key usage this billing period, top tools, active alerts, signal track record, x402 payment counts. |
| `hl_smart_money_score` | premium | Rank a cohort by a **smart-money screening score** (risk-adjusted perf + winrate + reward/risk + size + activity) with behavioral **labels** (whale, sharp, scalper, market_maker_like, high_conviction, …). A descriptive screener over past results — see `hl_score_calibration` before treating it as a forecast. |
| `hl_score_calibration` | free | **Out-of-sample evidence** for the smart-money score: Spearman rank correlation between score and the realized forward return each wallet went on to earn (forward PnL over account value when sampled), p-value, and mean forward return per score quartile. Free on purpose — a claim about predictive power should be checkable before you pay for it. The server scores its own cohort daily, so this fills in whether or not anyone is calling the paid tool. |
| `hl_coordination_scan` | premium | Find wallets holding near-identical exposure (cosine similarity) — likely the **same entity / copy-bot / coordinated group**; returns clusters + strongest pairs. |
| `hl_polymarket_divergence` | premium | Compare **Polymarket** price-threshold odds against the probability implied by Hyperliquid price + realized vol — a cross-market mispricing edge no other MCP offers. Also audits the market's own price ladder for **logically impossible orderings** (a further threshold priced above a nearer one), collapses duplicate contract listings, reports each estimate's **volatility-sensitivity range**, and flags extreme tails where a diffusion model is blind to jump risk. |

Every emitted signal is **cryptographically signed** and scored against forward price — a track record that can't be cherry-picked. Persistence (alerts, positioning snapshots, signals) is SQLite-backed and survives restarts.

**Public proof, no key needed:** the hosted server runs its own standing alerts (funding extremes on the top 10 perps by open interest, whale-cohort flips on BTC/ETH) and publishes their track record together with the score calibration and the signing key at [`/track-record`](https://hypersmash.fly.dev/track-record) ([JSON](https://hypersmash.fly.dev/track-record.json)). The same data is available to MCP clients as resources (`hypersignal://about`, `://track-record`, `://calibration`, `://signal-pubkey`), plus three prompts: `whale_briefing`, `wallet_risk_check`, `funding_carry_scan`.

### Trading (optional, **local stdio only**, builder code, maximum warnings)
| Tool | What it does |
|---|---|
| `hl_place_order` | Limit/market order via your agent wallet, builder code attached |
| `hl_cancel_order` | Cancel by coin + order id |
| `hl_close_position` | Reduce-only market close |
| `hl_approve_builder_fee_guide` | **Read-only** — generates the `approveBuilderFee` payload/instructions for your main wallet |
| `hl_twap_order` | Slice a position into evenly-spaced child orders (TWAP) to minimize impact, builder code on each child |
| `hl_copy_wallet` | Mirror a target wallet's positioning scaled to your equity (copy-trading), builder code attached |
| `hl_execution_status` | Progress of running TWAP/execution plans |
| `hl_cancel_execution` | Stop a running plan; slices not yet fired are dropped. A plan also stops by itself after 3 failed slices in a row |

Trading defaults to **dry-run** (previews the exact signed action without sending). Submitting
requires `HL_ENABLE_TRADING=true` + `HL_AGENT_PRIVATE_KEY` (env only) + `confirm=true` + `dryRun=false`.
Every non-reduce-only order (including each TWAP slice and copy-trade leg) is capped at `HL_MAX_ORDER_NOTIONAL_USD`
(default $10,000), which only the operator can raise.
HIP-3 coins (`xyz:XYZ100`) trade on their builder dex, which keeps its own collateral (enable the unified account
or transfer collateral to it) and may charge higher fees. Live HIP-3 orders also need `HL_ENABLE_HIP3_TRADING=true`:
turn it on after a testnet run. Copy-trading mirrors main-dex positions only.
**Trading tools are never exposed on the remote HTTP server.**

---

## Try it on the hosted server

Nothing to install. Free tools work without a key. For the premium tools, call `hl_request_free_key`
once: it returns a key with 100 premium calls a month, no signup.

Claude Code:
```bash
claude mcp add --transport http hypersignal https://hypersmash.fly.dev/mcp --header "X-API-Key: <your key>"
```

Cursor (`.cursor/mcp.json`):
```json
{ "mcpServers": { "hypersignal": { "url": "https://hypersmash.fly.dev/mcp", "headers": { "X-API-Key": "<your key>" } } } }
```

Without a key the free tools still work; add the key after `hl_request_free_key` has issued one.

---

## Install

### Requirements
Node **20 or 22 LTS** (Node 24 has no prebuilt `better-sqlite3` binaries and requires a C++ toolchain — use LTS).
`npm install && npm run build`.

### Local (stdio) — free + trading, for Claude Desktop / Claude Code / Cursor

Claude Desktop (`claude_desktop_config.json`), from npm:
```json
{
  "mcpServers": {
    "hypersignal": {
      "command": "npx",
      "args": ["-y", "hypersignal-mcp"],
      "env": {
        "HL_NETWORK": "mainnet",
        "HL_BUILDER_ADDRESS": "0xYourBuilderAddress",
        "HL_ENABLE_TRADING": "false"
      }
    }
  }
}
```

From a clone instead: `"command": "node"`, `"args": ["/absolute/path/to/HyperliquidMCP/dist/server-stdio.js"]`.
Cursor (`.cursor/mcp.json`) uses the same `command`/`args`/`env` shape.

Inspect locally:
```bash
npm run build && npm run inspect     # @modelcontextprotocol/inspector
```

### Remote (Streamable HTTP) — free + premium, monetized
```bash
cp .env.example .env      # fill in keys / builder / x402
docker compose up -d      # serves POST /mcp on :8080, GET /healthz
```
Point an MCP HTTP client at `https://your-host/mcp` and send `X-API-Key: <key>` (or `Authorization: Bearer <key>`).

> Node's built-in `fetch` only honors `HTTPS_PROXY` when `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21).
> Behind an egress proxy, set that env var.

---

## Pricing

| Tier | Limit | Price |
|---|---|---|
| anonymous (no key) | free tools only | — |
| free key | 100 premium calls/month | $0 |
| pro key | unlimited premium calls | $29/month |
| x402 pay-per-call | per premium call | $0.01 USDC on Base, where the server has x402 switched on |

**How to get each**
- **Free key:** call `hl_request_free_key`. Instant, no signup.
- **x402 pay-per-call:** a premium call without a key answers with x402 payment requirements when the
  server has x402 enabled; an x402-capable client pays in USDC on Base and the call runs.
  On the hosted server this is not enabled yet.
- **Pro:** keys are issued by the operator for now. Open a
  [GitHub issue](https://github.com/johnsmithxy1mmm-sys/HyperliquidMCP/issues/new?title=Pro+key+request)
  titled "Pro key request" and say how to reach you (for example a Telegram handle). The operator
  replies there with payment details and sends the key privately. Never post a key in an issue.

**For operators**
- **API keys:** provision via `HYPERSIGNAL_PRO_KEYS` / `HYPERSIGNAL_FREE_KEYS` (comma-separated raw
  keys, hashed before storage in SQLite). Usage counters are per key, per month. A key removed from
  these lists is revoked on the next start, as long as at least one key stays listed: two empty
  lists read as a lost secret and revoke nothing.
- **x402:** when a request has no key/quota and `X402_ENABLED=true`, premium tools return an x402
  payment-required response with requirements; after facilitator verification+settlement the call
  runs. Without a facilitator it fails closed (never fabricates a payment).
- **Apify:** `apify-actor/` re-exports the best-selling premium tools as a pay-per-event Actor.
  It is private for now.

---

## 🔌 Builder code (connect our terminal config)

Route your Hyperliquid orders through HyperSignal's builder code to support the project:
set `HL_BUILDER_ADDRESS` and (optionally) `HL_BUILDER_FEE_TENTHS_BPS` (tenths of a bp; default `5` = 0.5 bp,
Hyperliquid perp cap is 10 bp). One-time approval from your **main** wallet:

```
hl_approve_builder_fee_guide   →  gives you the exact approveBuilderFee payload + steps
```

The server never sees your main key; you sign the approval yourself.

---

## Architecture

```
src/
  core/       Hyperliquid Info client, WS mids feed (+REST fallback), LRU+TTL cache, rate limiter, retries
  hl/         typed endpoints, market/account/whale normalization, cohort resolution
  tools/      one file per tool (Zod input + outputSchema + annotations); free / premium / trading
  billing/    SQLite keys + monthly counters, tiers, x402 (fail-closed)
  trading/    L1 action signing (viem + msgpack), dry-run-first exchange service
  server-core.ts   builds an McpServer for a tier set + billing gate
  server-stdio.ts  local entrypoint  (free + trading)
  server-http.ts   remote entrypoint (free + premium, stateless JSON)
apify-actor/  thin pay-per-event wrapper
evals/        10 read-only, time-stable eval questions
docs/         PHASE0 research report, GTM checklist
```

Design rules enforced: no secrets outside `.env`; trading never remote; every external call has a
timeout + 3 exponential retries + graceful degradation; responses are aggregated/paginated/truncated;
premium/trading tools carry financial disclaimers; only Hyperliquid endpoints verified in Phase 0.

---

## Development

```bash
npm run dev:stdio     # tsx, no build
npm run dev:http
npm run typecheck     # strict, no `any`
npm test              # offline unit tests (signing, stats, aggregation, cache)
npm run build
```

## License
MIT. Not affiliated with Hyperliquid. Use at your own risk.

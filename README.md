# HyperSignal MCP

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

### Trading (optional, **local stdio only**, builder code, maximum warnings)
| Tool | What it does |
|---|---|
| `hl_place_order` | Limit/market order via your agent wallet, builder code attached |
| `hl_cancel_order` | Cancel by coin + order id |
| `hl_close_position` | Reduce-only market close |
| `hl_approve_builder_fee_guide` | **Read-only** — generates the `approveBuilderFee` payload/instructions for your main wallet |

Trading defaults to **dry-run** (previews the exact signed action without sending). Submitting
requires `HL_ENABLE_TRADING=true` + `HL_AGENT_PRIVATE_KEY` (env only) + `confirm=true` + `dryRun=false`.
**Trading tools are never exposed on the remote HTTP server.**

---

## Install

### Requirements
Node ≥ 20. `npm install && npm run build`.

### Local (stdio) — free + trading, for Claude Desktop / Claude Code / Cursor

Claude Desktop (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "hypersignal": {
      "command": "node",
      "args": ["/absolute/path/to/hypersignal-mcp/dist/server-stdio.js"],
      "env": {
        "HL_NETWORK": "mainnet",
        "HL_BUILDER_ADDRESS": "0xYourBuilderAddress",
        "HL_ENABLE_TRADING": "false"
      }
    }
  }
}
```

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

## Monetization

| Tier | Limit | Price |
|---|---|---|
| anonymous (no key) | free tools only | — |
| free key | 100 premium calls/month | $0 |
| pro key | unlimited analytics | $19/mo |
| x402 pay-per-call | per premium call | $0.005–0.02 USDC on Base |

- **API keys** — provision via `HYPERSIGNAL_PRO_KEYS` / `HYPERSIGNAL_FREE_KEYS` (comma-separated raw
  keys, hashed before storage in SQLite). Usage counters are per key, per month.
- **x402** — when a request has no key/quota and `X402_ENABLED=true`, premium tools return an x402
  payment-required response with requirements; after facilitator verification+settlement the call
  runs. Without a facilitator it fails closed (never fabricates a payment).
- **Apify** — `apify-actor/` re-exports the best-selling premium tools as a pay-per-event Actor.

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

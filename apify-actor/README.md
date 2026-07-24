# HyperSignal — Apify Actor

Thin **pay-per-event** proxy to a deployed HyperSignal MCP server. It forwards a
tool call to your server (with a server-side PRO key) and charges one
`premium-call` event per successful result. The analytics run on your server —
this Actor is just the Apify storefront/billing adapter.

## Setup (once)

In the Actor's **Settings → Environment variables** on Apify, add:

| Variable | Value |
|---|---|
| `MCP_SERVER_URL` | your server, e.g. `https://hypersmash.fly.dev/mcp` |
| `MCP_API_KEY` | a PRO key on your server (kept server-side; users never see it) |

Then in **Monetization**, enable pay-per-event and set the price of the
`premium-call` event.

## Exposed tools (input `tool`)

`hl_funding_screener`, `hl_whale_positions`, `hl_whale_flow_alerts`,
`hl_smart_money_score`, `hl_portfolio_risk`, `hl_polymarket_divergence`.

## Input

```json
{ "tool": "hl_portfolio_risk", "arguments": { "address": "0xYOUR_ADDRESS" } }
```

## Output

Pushed to the default dataset and the `OUTPUT` key-value record:

```json
{ "tool": "hl_portfolio_risk", "summary": "...", "data": { /* structuredContent */ } }
```

## Deploy

```bash
apify push
```
(run from this `apify-actor/` folder)

# HyperSignal — Apify Actor

Thin **pay-per-event** wrapper around HyperSignal's best-selling premium Hyperliquid tools.
The analytics core is single-sourced (`../src`, built to `../dist`); this Actor only adapts
input/output and charges one `premium-call` event per successful run.

## Exposed tools

| `tool` | Purpose | Key arguments |
|---|---|---|
| `hl_whale_flow_alerts` | Recent large whale positioning shifts | `cohort` (0x addresses) or env `HL_WHALE_ADDRESSES`, `thresholdUsd`, `lookbackMinutes` |
| `hl_funding_screener` | Annualized funding screen + venue spreads | `minAbsApr`, `minOpenInterestUsd`, `side` |
| `hl_portfolio_risk` | Risk report for an address | `address` (required), `shocks` |

## Input

```json
{ "tool": "hl_portfolio_risk", "arguments": { "address": "0xYOUR_ADDRESS" } }
```

## Output

Pushed to the default dataset and to `OUTPUT` key-value record:

```json
{ "tool": "hl_portfolio_risk", "summary": "...", "data": { /* structuredContent */ } }
```

## Deploy

From `apify-actor/` with build context at the repo root:

```bash
apify push
```

Set the `premium-call` event price in the Actor's monetization settings.
`HL_WHALE_ADDRESSES` / `HL_LEADERBOARD_URL` can be provided as Actor environment variables.

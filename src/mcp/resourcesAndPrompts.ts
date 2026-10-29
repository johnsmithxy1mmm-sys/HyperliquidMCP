/**
 * MCP resources and prompts. Resources let a client read the proof (track
 * record, calibration, signing key) and the tiers without a tool call;
 * prompts give agents ready-made workflows that chain the right tools.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tools/registry.js";
import { buildPublicProof } from "../public/proof.js";
import { TIERS, PRICING_URL } from "../billing/tiers.js";

const json = (uri: URL, value: unknown) => ({
  contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value, null, 2) }],
});

const userPrompt = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });

export function registerResourcesAndPrompts(server: McpServer, ctx: ToolContext, version: string): void {
  const proof = () => buildPublicProof(ctx.store, ctx.signer, version);

  server.registerResource(
    "about",
    "hypersignal://about",
    { title: "About HyperSignal", description: "Tiers, limits and how to get a key.", mimeType: "text/markdown" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text:
            `# HyperSignal MCP ${version}\n\n` +
            "Hyperliquid analytics for agents. Free tools need no key; premium tools need an API key or x402.\n\n" +
            `- Free key: call \`hl_request_free_key\` (${TIERS.free.monthlyPremiumCalls} premium calls/month).\n` +
            `- Pro: unlimited premium calls, $${TIERS.pro.priceUsdMonth}/month. How to pay: ${PRICING_URL}\n` +
            "- Public track record of the server's own signals: GET /track-record on the hosted server.\n\n" +
            "Analytics only, not investment advice.",
        },
      ],
    }),
  );
  server.registerResource(
    "track-record",
    "hypersignal://track-record",
    { title: "House signal track record", description: "Hit rate and returns of the server's own signed signals.", mimeType: "application/json" },
    async (uri) => json(uri, proof().houseSignals),
  );
  server.registerResource(
    "calibration",
    "hypersignal://calibration",
    { title: "Smart-money score calibration", description: "Out-of-sample evidence for hl_smart_money_score.", mimeType: "application/json" },
    async (uri) => json(uri, proof().calibration),
  );
  server.registerResource(
    "signal-pubkey",
    "hypersignal://signal-pubkey",
    { title: "Signal signing key", description: "Ed25519 public key that verifies every signal.", mimeType: "application/json" },
    async (uri) => json(uri, proof().signing),
  );

  server.registerPrompt(
    "whale_briefing",
    { title: "Whale briefing", description: "Whale positioning, recent flow and liquidation clusters for one coin.", argsSchema: { coin: z.string() } },
    async ({ coin }) =>
      userPrompt(
        `Brief me on whale positioning in ${coin} on Hyperliquid. Call hl_whale_positions with coin=${coin}, ` +
          `hl_whale_flow_alerts, and hl_liquidation_map with coin=${coin}. Summarize the net bias, the largest recent ` +
          "flows and the nearest liquidation clusters, and say how many cohort wallets loaded. Analytics, not advice.",
      ),
  );
  server.registerPrompt(
    "wallet_risk_check",
    { title: "Wallet risk check", description: "Liquidation distance, leverage and trading style of one wallet.", argsSchema: { address: z.string() } },
    async ({ address }) =>
      userPrompt(
        `Check the risk of Hyperliquid wallet ${address}. Call hl_portfolio_risk and hl_trader_report for it. ` +
          "Report liquidation distance per position, effective leverage, concentration, stress scenarios and the " +
          "trading style; flag whether the fill history was truncated. Analytics, not advice.",
      ),
  );
  server.registerPrompt(
    "funding_carry_scan",
    { title: "Funding carry scan", description: "Perps with extreme funding and what the carry would pay." },
    async () =>
      userPrompt(
        "Scan Hyperliquid perps for funding carry. Call hl_funding_screener and list the most extreme annualized " +
          "funding rates with their direction (who pays whom) and open interest. Note that funding changes hourly " +
          "and carry ignores price risk. Analytics, not advice.",
      ),
  );
}

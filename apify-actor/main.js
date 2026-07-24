// Thin Apify Actor: proxies a request to the deployed HyperSignal MCP server
// and charges one pay-per-event unit per successful premium result. Fully
// self-contained (no monorepo build) — the analytics live on your server.
//
// Required env (set in the Actor's Environment variables on Apify):
//   MCP_SERVER_URL  e.g. https://hypersmash.fly.dev/mcp
//   MCP_API_KEY     a PRO key on your server (kept server-side; users never see it)
import { Actor } from "apify";

const EXPORTED = [
  "hl_whale_flow_alerts",
  "hl_funding_screener",
  "hl_portfolio_risk",
  "hl_smart_money_score",
  "hl_whale_positions",
  "hl_polymarket_divergence",
];

await Actor.init();

try {
  const input = (await Actor.getInput()) ?? {};
  const tool = input.tool;
  const args = input.arguments ?? {};

  if (!tool || !EXPORTED.includes(tool)) {
    throw new Error(`input.tool must be one of: ${EXPORTED.join(", ")}. Got: ${JSON.stringify(tool)}`);
  }

  const url = process.env.MCP_SERVER_URL || "https://hypersmash.fly.dev/mcp";
  const apiKey = process.env.MCP_API_KEY;
  if (!apiKey) {
    throw new Error("MCP_API_KEY env var is required. Set it in the Actor's Environment variables (a PRO key on your server).");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });

  const json = await res.json();
  if (json.error) throw new Error(`MCP transport error: ${json.error.message}`);
  const result = json.result;
  if (result?.isError) {
    throw new Error(`Tool error: ${result.content?.[0]?.text ?? "unknown"}`);
  }

  const summary = result?.content?.[0]?.text ?? "";
  const data = result?.structuredContent ?? {};

  // Charge one pay-per-event unit for the delivered premium result.
  if (typeof Actor.charge === "function") {
    try {
      await Actor.charge({ eventName: "premium-call" });
    } catch (chargeErr) {
      console.warn(`premium-call charge failed (continuing): ${chargeErr instanceof Error ? chargeErr.message : chargeErr}`);
    }
  }

  await Actor.pushData({ tool, summary, data, ts: Date.now() });
  await Actor.setValue("OUTPUT", { tool, summary, data });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  await Actor.pushData({ error: message });
  await Actor.fail(message);
}

await Actor.exit();

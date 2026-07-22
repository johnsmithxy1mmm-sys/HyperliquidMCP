// Thin Apify Actor wrapper around HyperSignal's best-selling premium tools.
// Pay-per-event monetization: each successful tool call charges one event.
// The core stays single-sourced — this wrapper imports the built core from ../dist.
import { Actor } from "apify";
import { runToolOnce, APIFY_EXPORTED_TOOLS } from "../dist/runTool.js";

await Actor.init();

try {
  const input = (await Actor.getInput()) ?? {};
  const tool = input.tool;
  const args = input.arguments ?? {};

  if (!tool || !APIFY_EXPORTED_TOOLS.includes(tool)) {
    throw new Error(
      `input.tool must be one of: ${APIFY_EXPORTED_TOOLS.join(", ")}. Got: ${JSON.stringify(tool)}`,
    );
  }

  const result = await runToolOnce(tool, args);

  // Charge a pay-per-event unit for the delivered premium result.
  // (Configure the "premium-call" event price in the Actor's monetization settings.)
  if (typeof Actor.charge === "function") {
    await Actor.charge({ eventName: "premium-call" });
  }

  await Actor.pushData({
    tool,
    summary: result.summary,
    data: result.data,
    chargedEvent: "premium-call",
    ts: Date.now(),
  });

  await Actor.setValue("OUTPUT", { tool, summary: result.summary, data: result.data });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  await Actor.pushData({ error: message });
  await Actor.fail(message);
}

await Actor.exit();

import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { ANALYTICS_DISCLAIMER } from "../../hl/whales.js";

export const signalTrackRecord: ToolDef = {
  name: "hl_signal_track_record",
  tier: "premium",
  title: "Signal track record",
  description:
    "Transparent, verifiable performance of the signals this server has emitted: per signal type, the count, how " +
    "many have been scored against forward price, hit-rate, and average/median direction-adjusted return. " +
    "Every signal is cryptographically signed (verify the key via hl_signal_pubkey). " +
    ANALYTICS_DISCLAIMER,
  inputSchema: {
    type: z.string().optional().describe("Filter to one signal type (e.g. 'whale_net_flip', 'funding_apr')."),
  },
  outputSchema: {
    records: z.array(z.record(z.any())),
    note: z.string(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run: async (args, ctx) => {
    const records = ctx.store.signals.trackRecord(args.type as string | undefined);
    const best = [...records].filter((r) => r.scored >= 5).sort((a, b) => b.hitRatePct - a.hitRatePct)[0];
    return {
      summary: records.length
        ? `Track record across ${records.length} signal type(s)` +
          (best ? `; best: ${best.type} ${best.hitRatePct}% hit-rate over ${best.scored} scored.` : ".")
        : "No signals recorded yet — track record builds as alerts fire over time.",
      data: {
        records,
        note: "Direction-adjusted forward return over each signal's horizon; scored once the horizon elapses.",
      },
    };
  },
};

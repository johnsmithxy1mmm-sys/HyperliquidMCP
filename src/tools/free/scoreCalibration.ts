import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { calibrate } from "../../smartmoney/calibration.js";

/**
 * Deliberately FREE: a claim about predictive power should be checkable by
 * anyone before they pay for the signal it backs.
 */
export const scoreCalibration: ToolDef = {
  name: "hl_score_calibration",
  tier: "free",
  title: "Smart-money score calibration",
  description:
    "Out-of-sample evidence for whether the hl_smart_money_score actually predicts anything: Spearman rank " +
    "correlation between each wallet's score and the realized PnL it went on to earn over the forward window, " +
    "plus mean forward PnL per score quartile. Verdicts: insufficient_data (not enough resolved observations yet), " +
    "inverted (significantly NEGATIVE — higher-scored wallets did worse), no_evidence, weak_positive, positive. " +
    "Only server-selected cohorts enter the sample, so a caller cannot steer this figure. " +
    "Read this before treating the score as a forecast.",
  inputSchema: {},
  outputSchema: {
    verdict: z.string(),
    n: z.number(),
    spearman: z.number().nullable(),
    pValue: z.number().nullable(),
    quartiles: z.array(z.record(z.any())),
    observations: z.record(z.any()),
    methodology: z.string(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run: async (_args, ctx) => {
    const report = calibrate(ctx.store.scores.outcomes());
    const counts = { ...ctx.store.scores.counts(), abandoned: ctx.store.scores.abandoned() };

    const summary =
      report.verdict === "insufficient_data"
        ? `Not yet validated — ${counts.resolved} resolved of ${counts.total} observations (need ~30). ` +
          `Treat the score as a descriptive screener, not a forecast.`
        : `Verdict: ${report.verdict}. Spearman ${report.spearman?.toFixed(3)} over n=${report.n}` +
          (report.pValue !== null ? ` (p=${report.pValue.toFixed(4)})` : "") + ".";

    return {
      summary,
      data: {
        verdict: report.verdict,
        n: report.n,
        spearman: report.spearman,
        pValue: report.pValue,
        quartiles: report.quartiles,
        observations: counts,
        methodology:
          "Each time a wallet is scored, (address, score) is recorded once per day. After the forward window " +
          "elapses, realized PnL from that wallet's fills over the window is measured (deposit-immune, unlike " +
          "equity change). Spearman rank correlation is used because only the ordering matters and PnL is " +
          "heavy-tailed. A positive verdict requires n>=30, p<0.05 and rho>0.2.",
      },
    };
  },
};

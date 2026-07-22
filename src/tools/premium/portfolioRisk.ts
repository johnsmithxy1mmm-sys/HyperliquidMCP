import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { assertAddress, num, round, sharpe } from "../../core/format.js";
import { normalizeAccount } from "../../hl/account.js";
import { ANALYTICS_DISCLAIMER } from "../../hl/whales.js";

/**
 * Ready-made risk report for any address: per-position liquidation distance,
 * effective leverage, concentration, uniform price-shock stress scenarios, and
 * Sharpe of realized PnL from recent fills. Estimates from public state.
 */
export const portfolioRisk: ToolDef = {
  name: "hl_portfolio_risk",
  tier: "premium",
  title: "Portfolio risk report",
  description:
    "Risk report for a perp address: liquidation distance per position, effective leverage, concentration (HHI + " +
    "largest position share), uniform stress scenarios (-5/-10/-20% and mirror), and Sharpe of realized PnL from " +
    "recent fills. " +
    ANALYTICS_DISCLAIMER,
  inputSchema: {
    address: z.string().describe("EVM 0x address."),
    shocks: z
      .array(z.number())
      .default([-0.05, -0.1, -0.2])
      .describe("Price-shock fractions to stress test (applied uniformly across positions)."),
  },
  outputSchema: {
    address: z.string(),
    accountValue: z.number(),
    effectiveLeverage: z.number(),
    marginUtilization: z.number(),
    concentrationHhi: z.number(),
    largestPositionShare: z.number(),
    positions: z.array(z.record(z.any())),
    stressScenarios: z.array(z.record(z.any())),
    realizedPnlSharpe: z.number().nullable(),
    disclaimer: z.string(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  run: async (args, ctx) => {
    const address = assertAddress(String(args.address));
    const shocks = (args.shocks as number[] | undefined)?.length ? (args.shocks as number[]) : [-0.05, -0.1, -0.2];

    const state = await ctx.hl.clearinghouseState(address);
    const acct = normalizeAccount(state);
    const equity = acct.accountValue;
    const totalNtl = acct.positions.reduce((a, p) => a + Math.abs(p.positionValueUsd), 0);

    const positions = acct.positions.map((p) => {
      const markPx = p.entryPx && p.szi !== 0 ? Math.abs(p.positionValueUsd / p.szi) : p.entryPx ?? 0;
      const liqDistPct =
        p.liquidationPx && markPx > 0 ? round(((p.liquidationPx - markPx) / markPx) * 100, 2) : null;
      return {
        coin: p.coin,
        side: p.side,
        szi: p.szi,
        notionalUsd: round(Math.abs(p.positionValueUsd), 2),
        entryPx: p.entryPx,
        markPx: round(markPx, 6),
        leverage: p.leverage,
        liquidationPx: p.liquidationPx,
        liquidationDistancePct: liqDistPct,
        unrealizedPnl: round(p.unrealizedPnl, 2),
        shareOfBook: totalNtl > 0 ? round(Math.abs(p.positionValueUsd) / totalNtl, 4) : 0,
      };
    });

    const shares = positions.map((p) => p.shareOfBook);
    const hhi = round(shares.reduce((a, s) => a + s * s, 0), 4);
    const largestShare = shares.length ? round(Math.max(...shares), 4) : 0;
    const effLeverage = equity > 0 ? round(totalNtl / equity, 3) : 0;

    const stressScenarios = shocks.map((shock) => {
      // PnL change if each position's mark moves by `shock` (directional via szi).
      let pnlChange = 0;
      for (const p of acct.positions) {
        const markPx = p.entryPx && p.szi !== 0 ? Math.abs(p.positionValueUsd / p.szi) : 0;
        pnlChange += p.szi * markPx * shock;
      }
      const newEquity = equity + pnlChange;
      return {
        shockPct: round(shock * 100, 1),
        pnlChangeUsd: round(pnlChange, 2),
        newEquityUsd: round(newEquity, 2),
        equityChangePct: equity > 0 ? round((pnlChange / equity) * 100, 2) : 0,
        wipeout: newEquity <= acct.crossMaintenanceMarginUsed,
      };
    });

    let realizedPnlSharpe: number | null = null;
    try {
      const fills = await ctx.hl.userFills(address);
      const closed = fills
        .filter((f) => num(f.closedPnl) !== 0)
        .sort((a, b) => a.time - b.time)
        .map((f) => num(f.closedPnl));
      if (closed.length >= 2) realizedPnlSharpe = sharpe(closed);
    } catch {
      realizedPnlSharpe = null;
    }

    const worst = stressScenarios[stressScenarios.length - 1];
    return {
      summary:
        `Risk ${address.slice(0, 8)}…: equity $${equity}, eff. leverage ${effLeverage}x, ` +
        `concentration ${round(largestShare * 100, 1)}% in top position. ` +
        (worst ? `Stress ${worst.shockPct}% → equity $${worst.newEquityUsd} (${worst.equityChangePct}%).` : ""),
      data: {
        address,
        accountValue: equity,
        effectiveLeverage: effLeverage,
        marginUtilization: equity > 0 ? round(acct.totalMarginUsed / equity, 4) : 0,
        concentrationHhi: hhi,
        largestPositionShare: largestShare,
        positions,
        stressScenarios,
        realizedPnlSharpe,
        disclaimer: ANALYTICS_DISCLAIMER,
      },
    };
  },
};

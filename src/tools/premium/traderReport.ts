import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { assertAddress, num, round, sharpe } from "../../core/format.js";
import { ANALYTICS_DISCLAIMER } from "../../hl/whales.js";
import type { UserFill } from "../../hl/types.js";

/**
 * Full trader breakdown from fills: winrate, average R (win/loss ratio),
 * realized PnL curve, trading style (scalp/swing via holding time), and the
 * coins traded most. Uses userFillsByTime over a lookback window.
 */
export const traderReport: ToolDef = {
  name: "hl_trader_report",
  tier: "premium",
  title: "Trader report",
  description:
    "Behavioral report for any wallet from its fills: winrate, average R (avg win / avg loss), total realized PnL, " +
    "PnL curve, holding-time style (scalp vs swing), fees paid, and most-traded coins. Lookback in days " +
    "(the API caps at the ~2000 most recent fills in the window, so very active wallets are partially sampled). " +
    ANALYTICS_DISCLAIMER,
  inputSchema: {
    address: z.string().describe("EVM 0x address."),
    lookbackDays: z.number().int().min(1).max(365).default(30),
    curvePoints: z.number().int().min(2).max(200).default(50).describe("Downsampled points in the returned PnL curve."),
  },
  outputSchema: {
    address: z.string(),
    windowDays: z.number(),
    closedTrades: z.number(),
    winratePct: z.number(),
    avgWinUsd: z.number(),
    avgLossUsd: z.number(),
    avgR: z.number().nullable(),
    totalRealizedPnl: z.number(),
    totalFees: z.number(),
    pnlSharpe: z.number().nullable(),
    style: z.string(),
    avgHoldMinutes: z.number().nullable(),
    topCoins: z.array(z.record(z.any())),
    pnlCurve: z.array(z.record(z.any())),
    disclaimer: z.string(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  run: async (args, ctx) => {
    const address = assertAddress(String(args.address));
    const lookbackDays = (args.lookbackDays as number) ?? 30;
    const curvePoints = (args.curvePoints as number) ?? 50;
    const startTime = Date.now() - lookbackDays * 86_400_000;

    const fills = (await ctx.hl.userFillsByTime(address, startTime)).sort((a, b) => a.time - b.time);

    const closed = fills.filter((f) => num(f.closedPnl) !== 0);
    const wins = closed.filter((f) => num(f.closedPnl) > 0);
    const losses = closed.filter((f) => num(f.closedPnl) < 0);
    const avgWin = wins.length ? wins.reduce((a, f) => a + num(f.closedPnl), 0) / wins.length : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((a, f) => a + num(f.closedPnl), 0) / losses.length) : 0;
    const totalPnl = closed.reduce((a, f) => a + num(f.closedPnl), 0);
    const totalFees = fills.reduce((a, f) => a + num(f.fee), 0);
    const winrate = closed.length ? (wins.length / closed.length) * 100 : 0;
    const avgR = avgLoss > 0 ? round(avgWin / avgLoss, 3) : null;

    // PnL curve (cumulative), downsampled.
    let cum = 0;
    const fullCurve = closed.map((f) => {
      cum += num(f.closedPnl);
      return { t: f.time, cumPnl: round(cum, 2) };
    });
    const pnlCurve = downsample(fullCurve, curvePoints);
    const pnlSharpe = closed.length >= 2 ? sharpe(closed.map((f) => num(f.closedPnl))) : null;

    // Holding-time style: median gap between consecutive fills on the same coin.
    const avgHoldMinutes = estimateHoldMinutes(fills);
    const style =
      avgHoldMinutes === null
        ? "unknown"
        : avgHoldMinutes < 60
          ? "scalp"
          : avgHoldMinutes < 24 * 60
            ? "intraday"
            : "swing";

    // Most-traded coins by notional.
    const byCoin = new Map<string, { notional: number; fills: number; pnl: number }>();
    for (const f of fills) {
      const e = byCoin.get(f.coin) ?? { notional: 0, fills: 0, pnl: 0 };
      e.notional += num(f.px) * num(f.sz);
      e.fills += 1;
      e.pnl += num(f.closedPnl);
      byCoin.set(f.coin, e);
    }
    const topCoins = [...byCoin.entries()]
      .map(([coin, e]) => ({ coin, notionalUsd: round(e.notional, 0), fills: e.fills, realizedPnl: round(e.pnl, 2) }))
      .sort((a, b) => b.notionalUsd - a.notionalUsd)
      .slice(0, 10);

    return {
      summary:
        `${address.slice(0, 8)}… over ${lookbackDays}d: ${closed.length} closed trades, ` +
        `winrate ${round(winrate, 1)}%, avgR ${avgR ?? "n/a"}, realized PnL $${round(totalPnl, 2)}, style ${style}.`,
      data: {
        address,
        windowDays: lookbackDays,
        closedTrades: closed.length,
        winratePct: round(winrate, 2),
        avgWinUsd: round(avgWin, 2),
        avgLossUsd: round(avgLoss, 2),
        avgR,
        totalRealizedPnl: round(totalPnl, 2),
        totalFees: round(totalFees, 2),
        pnlSharpe,
        style,
        avgHoldMinutes,
        topCoins,
        pnlCurve,
        disclaimer: ANALYTICS_DISCLAIMER,
      },
    };
  },
};

function downsample<T>(arr: T[], points: number): T[] {
  if (arr.length <= points) return arr;
  const step = arr.length / points;
  const out: T[] = [];
  for (let i = 0; i < points; i++) out.push(arr[Math.floor(i * step)]);
  out.push(arr[arr.length - 1]);
  return out;
}

function estimateHoldMinutes(fills: UserFill[]): number | null {
  // Approximate: for each coin, time between a position-opening fill (startPosition ~ 0)
  // and the subsequent closing fill (closedPnl != 0). Falls back to null if insufficient.
  const gaps: number[] = [];
  const openTimeByCoin = new Map<string, number>();
  for (const f of fills) {
    const start = num(f.startPosition);
    if (Math.abs(start) < 1e-9 && !openTimeByCoin.has(f.coin)) {
      openTimeByCoin.set(f.coin, f.time);
    }
    if (num(f.closedPnl) !== 0) {
      const opened = openTimeByCoin.get(f.coin);
      if (opened !== undefined) {
        gaps.push((f.time - opened) / 60_000);
        openTimeByCoin.delete(f.coin);
      }
    }
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const median = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return round(median, 1);
}

/**
 * Central tool catalog + tier-aware registration. Trading tools are registered
 * ONLY in stdio mode; premium tools carry the billing gate in http mode.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool, type ToolContext, type ToolDef, type Tier } from "./registry.js";

// Free
import { getMarkets } from "./free/getMarkets.js";
import { getOrderbook } from "./free/getOrderbook.js";
import { getCandles } from "./free/getCandles.js";
import { getFundingHistory } from "./free/getFundingHistory.js";
import { getAccount } from "./free/getAccount.js";
import { getOpenOrders } from "./free/getOpenOrders.js";
import { signalPubkey } from "./free/signalPubkey.js";
import { adminStats } from "./free/adminStats.js";
import { scoreCalibration } from "./free/scoreCalibration.js";
import { requestFreeKey } from "./free/requestFreeKey.js";
// Premium
import { whalePositions } from "./premium/whalePositions.js";
import { whaleFlowAlerts } from "./premium/whaleFlowAlerts.js";
import { liquidationMap } from "./premium/liquidationMap.js";
import { fundingScreener } from "./premium/fundingScreener.js";
import { hip3Analytics } from "./premium/hip3Analytics.js";
import { portfolioRisk } from "./premium/portfolioRisk.js";
import { vaultScreener } from "./premium/vaultScreener.js";
import { traderReport } from "./premium/traderReport.js";
import { createAlert, listAlerts, deleteAlert, pollAlerts } from "./premium/alerts.js";
import { signalTrackRecord } from "./premium/signalTrackRecord.js";
import { smartMoneyScore, coordinationScan } from "./premium/smartMoney.js";
import { polymarketDivergence } from "./premium/polymarketDivergence.js";
// Trading
import { placeOrder } from "./trading/placeOrder.js";
import { cancelOrder } from "./trading/cancelOrder.js";
import { closePosition } from "./trading/closePosition.js";
import { approveBuilderFeeGuide } from "./trading/approveBuilderFeeGuide.js";
import { twapOrder, copyWallet, executionStatus } from "./trading/execution.js";

export const FREE_TOOLS: ToolDef[] = [
  requestFreeKey,
  getMarkets,
  getOrderbook,
  getCandles,
  getFundingHistory,
  getAccount,
  getOpenOrders,
  signalPubkey,
  adminStats,
  scoreCalibration,
];

export const PREMIUM_TOOLS: ToolDef[] = [
  whalePositions,
  whaleFlowAlerts,
  liquidationMap,
  fundingScreener,
  hip3Analytics,
  portfolioRisk,
  vaultScreener,
  traderReport,
  createAlert,
  listAlerts,
  deleteAlert,
  pollAlerts,
  signalTrackRecord,
  smartMoneyScore,
  coordinationScan,
  polymarketDivergence,
];

export const TRADING_TOOLS: ToolDef[] = [
  placeOrder,
  cancelOrder,
  closePosition,
  approveBuilderFeeGuide,
  twapOrder,
  copyWallet,
  executionStatus,
];

export const ALL_TOOLS: ToolDef[] = [...FREE_TOOLS, ...PREMIUM_TOOLS, ...TRADING_TOOLS];

/** Register the given tiers' tools onto a server using the provided context. */
export function registerTools(server: McpServer, ctx: ToolContext, tiers: Tier[]): number {
  const selected = ALL_TOOLS.filter((t) => tiers.includes(t.tier));
  for (const def of selected) registerTool(server, def, ctx);
  return selected.length;
}

/**
 * The server's own standing alerts ("house"). Signals only exist when alerts
 * fire, so without customers the published track record would stay empty.
 * Like the score sampler, the server keeps a fixed, server-chosen set running
 * so the record accumulates on its own; only these are published.
 */
import type { HyperliquidClient } from "../core/hlClient.js";
import type { AlertStore } from "../store/alertStore.js";
import { getMarketRows } from "../hl/markets.js";
import { log } from "../logger.js";

export const HOUSE_SUBJECT = "house";

const FUNDING_COINS = 10;
const FUNDING_APR_THRESHOLD = 0.5;
const WHALE_FLIP_COINS = ["BTC", "ETH"];
const COOLDOWN_MINUTES = 60;

/**
 * Keep house alerts in line with the market: funding_apr on the top coins by
 * open interest (USD) and whale_net_flip on BTC/ETH over the server cohort.
 * Idempotent; coins that drop out of the top lose their funding alert.
 */
export async function ensureHouseAlerts(hl: HyperliquidClient, alerts: AlertStore): Promise<void> {
  const top = (await getMarketRows(hl))
    .filter((r) => !r.isDelisted && !r.isHip3)
    .sort((a, b) => b.openInterest * b.markPx - a.openInterest * a.markPx)
    .slice(0, FUNDING_COINS)
    .map((r) => r.coin);
  const existing = alerts.list(HOUSE_SUBJECT);

  let created = 0;
  let removed = 0;
  for (const a of existing) {
    if (a.type === "funding_apr" && !top.includes(a.params.coin ?? "")) {
      if (alerts.delete(a.id, HOUSE_SUBJECT)) removed++;
    }
  }
  const has = (type: string, coin: string) => existing.some((a) => a.type === type && a.params.coin === coin);
  for (const coin of top) {
    if (has("funding_apr", coin)) continue;
    alerts.create(HOUSE_SUBJECT, "funding_apr", { coin, aprThreshold: FUNDING_APR_THRESHOLD }, COOLDOWN_MINUTES);
    created++;
  }
  for (const coin of WHALE_FLIP_COINS) {
    if (has("whale_net_flip", coin)) continue;
    alerts.create(HOUSE_SUBJECT, "whale_net_flip", { coin }, COOLDOWN_MINUTES);
    created++;
  }
  if (created || removed) log.info("house alerts updated", { created, removed, fundingCoins: top });
}

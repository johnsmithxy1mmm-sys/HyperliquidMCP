/**
 * Standing-alert engine. On a timer it evaluates every active alert against
 * fresh market context, records fired events (for the agent to poll) and a
 * signed signal (for the track record), respecting per-alert cooldowns. Also
 * periodically scores due signals against forward price.
 *
 * Runs in both entrypoints; degrades gracefully if Hyperliquid is unreachable.
 */
import type { HyperliquidClient } from "../core/hlClient.js";
import type { Warehouse } from "../store/warehouse.js";
import type { SignalSigner } from "../signals/signer.js";
import { getMarketRows } from "../hl/markets.js";
import { fetchCohortAccounts, aggregateByCoin } from "../hl/whales.js";
import { resolveCohort } from "../hl/cohort.js";
import { evaluateAlert, type EvalInputs } from "./evaluate.js";
import type { ToolContext } from "../tools/registry.js";
import { shortHash } from "../core/format.js";
import { log } from "../logger.js";

const PRICE_NS = "alertPrice";

export class AlertEngine {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly hl: HyperliquidClient,
    private readonly store: Warehouse,
    private readonly signer: SignalSigner,
    /** Minimal ctx for cohort resolution (whale alerts). */
    private readonly ctxForCohort: ToolContext,
  ) {}

  start(intervalMs = Number(process.env.ALERT_INTERVAL_SEC ?? 60) * 1000): void {
    if (this.timer) return;
    // NaN-safe: a malformed ALERT_INTERVAL_SEC must not become setInterval(NaN)
    // (which fires continuously — a busy loop).
    const safe = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 60_000;
    const period = Math.max(15_000, safe);
    this.timer = setInterval(() => void this.tick(), period);
    this.timer.unref?.();
    log.info("alert engine started", { periodMs: period });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One evaluation pass. Exposed for manual poll/testing. Returns fired count. */
  async tick(now = Date.now()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const alerts = this.store.alerts.listActive();
      // Signals must keep getting scored even when every alert has been
      // deleted — otherwise the track record freezes. Only skip the network
      // round-trip when there is truly nothing to do.
      const due = this.store.signals.dueForScoring(now);
      if (alerts.length === 0 && due.length === 0) return 0;

      const rows = await getMarketRows(this.hl);
      const marketByCoin = new Map(rows.map((r) => [r.coin, r]));

      // Record price snapshots for coins under price_move alerts.
      for (const a of alerts) {
        if (a.type === "price_move" && a.params.coin) {
          const m = marketByCoin.get(a.params.coin);
          if (m) this.store.snapshots.record(PRICE_NS, a.params.coin, { px: m.markPx }, now);
        }
      }

      // Precompute whale net notional per (cohort,coin) once.
      const whaleNet = await this.computeWhaleNet(alerts, marketByCoin, now);

      let fired = 0;
      for (const a of alerts) {
        if (a.lastFiredAt && now - a.lastFiredAt < a.cooldownMinutes * 60_000) continue;
        const m = a.params.coin ? marketByCoin.get(a.params.coin) : undefined;
        const inp: EvalInputs = { now, markPx: m?.markPx, fundingApr: m?.fundingApr };

        if (a.type === "price_move" && a.params.coin) {
          const prior = this.store.snapshots.nearest(
            PRICE_NS,
            a.params.coin,
            (a.params.windowMinutes ?? 60) * 60_000,
            (a.params.windowMinutes ?? 60) * 60_000 * 0.5,
          );
          inp.priorPx = prior ? (prior.value as { px: number }).px : undefined;
        }
        if (a.type === "whale_net_flip" && a.params.coin) {
          inp.whaleNetNtlUsd = whaleNet.get(`${whaleKey(a.params.cohort)}:${a.params.coin}`);
        }

        const res = evaluateAlert(a, inp);
        if (res.state !== undefined || res.fired) {
          this.store.alerts.updateState(a.id, res.state ?? a.lastState, res.fired ? now : a.lastFiredAt);
        }
        if (res.fired && res.message) {
          fired++;
          let signature: string | undefined;
          if (res.signal) {
            const signed = this.signer.sign(res.signal, now);
            signature = signed.signature;
            this.store.signals.record({
              type: res.signal.type,
              coin: res.signal.coin,
              direction: res.signal.direction,
              refPx: res.signal.refPx,
              horizonMinutes: 1440,
              signature,
              ts: now,
            });
          }
          this.store.alerts.recordFired(a.id, a.subject, now, res.message, {
            type: a.type,
            ...(res.signal ?? {}),
            signature,
          });
        }
      }

      await this.scoreDueSignals(marketByCoin, now);
      await this.resolveDueScoreOutcomes(now);
      return fired;
    } catch (err) {
      log.warn("alert tick failed", { err: err instanceof Error ? err.message : String(err) });
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async computeWhaleNet(
    alerts: ReturnType<Warehouse["alerts"]["listActive"]>,
    marketByCoin: Map<string, { markPx: number }>,
    _now: number,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const cohorts = new Map<string, string[] | undefined>();
    for (const a of alerts) {
      if (a.type === "whale_net_flip") cohorts.set(whaleKey(a.params.cohort), a.params.cohort);
    }
    for (const [key, cohort] of cohorts) {
      try {
        const resolved = await resolveCohort(this.ctxForCohort, cohort, 100);
        const accounts = await fetchCohortAccounts(this.ctxForCohort, resolved.addresses);
        const agg = aggregateByCoin(accounts);
        for (const [coin, c] of agg) out.set(`${key}:${coin}`, c.netNtlUsd);
      } catch (err) {
        log.warn("whale alert cohort failed", { err: String(err) });
      }
    }
    void marketByCoin;
    return out;
  }

  /**
   * Fill in forward outcomes for score snapshots whose horizon has elapsed.
   *
   * Measures realized PnL from the wallet's fills over the forward window —
   * deposit-immune, unlike equity change. Bounded to a few wallets per tick so
   * this never competes with alert evaluation for the rate-limit budget.
   */
  private async resolveDueScoreOutcomes(now: number): Promise<void> {
    const due = this.store.scores.due(3, now);
    for (const snap of due) {
      try {
        const windowEnd = snap.ts + snap.horizonDays * 86_400_000;
        const fills = await this.hl.userFillsByTime(snap.address, snap.ts, windowEnd);
        const forwardPnl = fills.reduce((sum, f) => sum + Number(f.closedPnl ?? 0), 0);
        this.store.scores.setOutcome(snap.id, Number.isFinite(forwardPnl) ? forwardPnl : 0, now);
      } catch (err) {
        // Leave unresolved; it will be retried on a later tick.
        log.warn("score outcome resolution failed", { address: snap.address, err: String(err) });
      }
    }
  }

  private async scoreDueSignals(marketByCoin: Map<string, { markPx: number }>, now: number): Promise<void> {
    const due = this.store.signals.dueForScoring(now);
    for (const s of due) {
      const m = marketByCoin.get(s.coin);
      if (!m || !(s.refPx > 0)) continue;
      const raw = (m.markPx - s.refPx) / s.refPx;
      // Direction-adjusted forward return: a correct short on a drop scores positive.
      const adj = s.direction === "short" ? -raw : raw;
      this.store.signals.setScore(s.id, m.markPx, adj, now);
    }
  }
}

function whaleKey(cohort: string[] | undefined): string {
  if (!cohort || cohort.length === 0) return "env";
  return shortHash(cohort.slice().sort().join(","));
}

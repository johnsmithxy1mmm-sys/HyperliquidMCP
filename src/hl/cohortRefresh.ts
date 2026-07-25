/**
 * Background whale-cohort refresher.
 *
 * IMPORTANT — source honesty: Hyperliquid's documented Info API has no
 * leaderboard endpoint (see docs/PHASE0.md). The only practical source is the
 * public stats endpoint the web app uses, which is UNDOCUMENTED and may change
 * or disappear. It is therefore opt-in via HL_LEADERBOARD_URL, and every
 * failure degrades to the manually configured HL_WHALE_ADDRESSES rather than
 * inventing data.
 */
import type { Config } from "../config.js";
import type { CohortStore } from "../store/cohortStore.js";
import { rankCohort, type CohortStrategy, type RawLeaderboardRow } from "./cohortRank.js";
import { log } from "../logger.js";

function envNum(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

export class CohortRefresher {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly config: Config,
    private readonly store: CohortStore,
  ) {}

  /** Start periodic refresh. No-op when no leaderboard URL is configured. */
  start(): void {
    if (this.timer || !this.config.leaderboardUrl) return;
    // Hourly by default: the leaderboard moves slowly and the endpoint is
    // unofficial — no reason to hammer it.
    const periodMs = Math.max(15 * 60_000, envNum("HL_COHORT_REFRESH_MIN", 60) * 60_000);
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), periodMs);
    this.timer.unref?.();
    log.info("cohort refresher started", { periodMs, url: this.config.leaderboardUrl });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One refresh pass. Returns how many wallets were stored (0 on failure). */
  async refresh(): Promise<number> {
    if (this.running || !this.config.leaderboardUrl) return 0;
    this.running = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const res = await fetch(this.config.leaderboardUrl, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        log.warn("cohort refresh: bad status", { status: res.status });
        return 0;
      }
      const body = (await res.json()) as { leaderboardRows?: RawLeaderboardRow[] } | RawLeaderboardRow[];
      const rows: RawLeaderboardRow[] = Array.isArray(body) ? body : (body.leaderboardRows ?? []);
      if (rows.length === 0) {
        log.warn("cohort refresh: empty leaderboard payload");
        return 0;
      }

      const strategy = (process.env.HL_COHORT_STRATEGY as CohortStrategy) || "accountValue";
      const ranked = rankCohort(rows, {
        strategy,
        topN: envNum("HL_COHORT_SIZE", 60),
        minAccountValue: envNum("HL_COHORT_MIN_EQUITY", 50_000),
      });
      if (ranked.length === 0) {
        log.warn("cohort refresh: nothing passed filters", { rows: rows.length });
        return 0;
      }

      this.store.replace(ranked, strategy);
      log.info("cohort refreshed", { wallets: ranked.length, strategy, fromRows: rows.length });
      return ranked.length;
    } catch (err) {
      // Never throw: a stale or manual cohort is better than a broken tool.
      log.warn("cohort refresh failed", { err: err instanceof Error ? err.message : String(err) });
      return 0;
    } finally {
      clearTimeout(timer);
      this.running = false;
    }
  }
}

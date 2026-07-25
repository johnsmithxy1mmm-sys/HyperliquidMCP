/**
 * Background score sampler.
 *
 * The calibration harness can only answer "does the score predict anything?"
 * once observations exist, and observations are only created when a wallet is
 * actually scored. Relying on customer traffic for that means a server with no
 * traffic never accumulates evidence — and evidence is precisely what such a
 * server needs in order to earn traffic. So the server samples itself.
 *
 * Design constraints this respects:
 *   - Only server-selected cohorts enter the sample (same rule the tool
 *     enforces), so the published calibration figure stays unsteerable.
 *   - Work is chunked with pauses. The Hyperliquid weight budget is shared and
 *     FIFO, so walking 40 wallets in one burst would queue ahead of live
 *     requests and add seconds of latency to paying calls.
 *   - Idempotent per UTC day: a restart loop must not re-walk the cohort.
 *   - Never throws. A failed sample is a missed data point, not an outage.
 */
import type { ToolContext } from "../tools/registry.js";
import { resolveCohort } from "../hl/cohort.js";
import { analyzeCohort } from "./analyze.js";
import { scoreTrader } from "./score.js";
import { SCORE_HORIZON_DAYS } from "../store/scoreStore.js";
import { log } from "../logger.js";

function envNum(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

function envFlag(name: string, def: boolean): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return def;
  return ["1", "true", "yes", "on"].includes(raw);
}

/** Wallets fetched per chunk, and the pause between chunks. */
const CHUNK_SIZE = 5;
const CHUNK_PAUSE_MS = 4_000;
/** Lookback used to build each trader profile (matches the tool's default). */
const LOOKBACK_DAYS = 30;

/** Unref'd sleep: a pending pause must never hold a stdio process open. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

export interface SampleResult {
  sampled: number;
  skipped: boolean;
  reason?: string;
}

export class ScoreSampler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  /** ctx needs only `config`, `hl` and `store` — the same minimal shape the alert engine uses. */
  constructor(private readonly ctx: ToolContext) {}

  /**
   * Start the daily sampler. The first pass is delayed rather than immediate:
   * boot is when the process is busiest and least likely to have a fresh
   * cohort in hand.
   */
  start(): void {
    if (this.timer) return;
    if (!envFlag("HL_SCORE_SAMPLE_ENABLED", true)) {
      log.info("score sampler disabled (HL_SCORE_SAMPLE_ENABLED=false)");
      return;
    }
    const periodMs = Math.max(3_600_000, envNum("HL_SCORE_SAMPLE_INTERVAL_HOURS", 24) * 3_600_000);
    const firstDelayMs = Math.max(60_000, envNum("HL_SCORE_SAMPLE_DELAY_SEC", 300) * 1_000);

    const kick = setTimeout(() => void this.runOnce(), firstDelayMs);
    kick.unref?.();

    this.timer = setInterval(() => void this.runOnce(), periodMs);
    this.timer.unref?.();
    log.info("score sampler started", { periodMs, firstDelayMs });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One sampling pass. Exposed for tests and manual runs. Never throws. */
  async runOnce(now = Date.now()): Promise<SampleResult> {
    if (this.running) return { sampled: 0, skipped: true, reason: "already_running" };
    this.running = true;
    try {
      if (this.ctx.store.scores.hasSampleForDay(SCORE_HORIZON_DAYS, now)) {
        return { sampled: 0, skipped: true, reason: "already_sampled_today" };
      }

      const size = Math.max(1, Math.floor(envNum("HL_SCORE_SAMPLE_SIZE", 40)));
      // `undefined` cohort arg => server-selected source only (auto / env /
      // leaderboard). Passing addresses here would defeat the very rule that
      // keeps the published calibration honest.
      const cohort = await resolveCohort(this.ctx, undefined, size);
      if (cohort.addresses.length === 0) {
        return { sampled: 0, skipped: true, reason: "empty_cohort" };
      }

      let sampled = 0;
      for (let i = 0; i < cohort.addresses.length; i += CHUNK_SIZE) {
        const chunk = cohort.addresses.slice(i, i + CHUNK_SIZE);
        const profiles = await analyzeCohort(this.ctx, chunk, LOOKBACK_DAYS, 2);
        for (const p of profiles) {
          const s = scoreTrader(p);
          this.ctx.store.scores.record({
            address: p.address,
            score: s.score,
            accountValue: p.accountValue,
            horizonDays: SCORE_HORIZON_DAYS,
            ts: now,
          });
          sampled++;
        }
        if (i + CHUNK_SIZE < cohort.addresses.length) await sleep(CHUNK_PAUSE_MS);
      }

      const counts = this.ctx.store.scores.counts();
      log.info("score sample recorded", {
        sampled,
        source: cohort.source,
        total: counts.total,
        resolved: counts.resolved,
      });
      return { sampled, skipped: false };
    } catch (err) {
      // No cohort configured is the common, expected case — not an error worth
      // shouting about on every run.
      const message = err instanceof Error ? err.message : String(err);
      log.warn("score sample failed", { err: message });
      return { sampled: 0, skipped: true, reason: "error" };
    } finally {
      this.running = false;
    }
  }
}

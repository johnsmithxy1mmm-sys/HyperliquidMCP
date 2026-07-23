/**
 * Token-bucket rate limiter modelling Hyperliquid's aggregated request-weight
 * budget. Each Info call has a weight; we refill continuously and make callers
 * wait when the budget is exhausted. This is a client-side safety valve, not a
 * replacement for server-side limits.
 */

export class RateLimiter {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private last = Date.now();
  private queue: Array<{ weight: number; resolve: () => void }> = [];
  /** At most one wake-up timer pending — avoids a timer per queued waiter. */
  private timerPending = false;

  constructor(weightPerMinute: number) {
    this.capacity = Math.max(1, weightPerMinute);
    this.tokens = this.capacity;
    this.refillPerMs = this.capacity / 60_000;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.last;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.last = now;
  }

  private pump(): void {
    this.refill();
    while (this.queue.length > 0) {
      const head = this.queue[0];
      if (this.tokens >= head.weight) {
        this.tokens -= head.weight;
        this.queue.shift();
        head.resolve();
      } else {
        if (!this.timerPending) {
          this.timerPending = true;
          const deficit = head.weight - this.tokens;
          const waitMs = Math.ceil(deficit / this.refillPerMs);
          setTimeout(() => {
            this.timerPending = false;
            this.pump();
          }, Math.min(waitMs, 5_000));
        }
        return;
      }
    }
  }

  /** Acquire `weight` budget units, waiting if necessary. */
  acquire(weight = 1): Promise<void> {
    // Clamp to [1, capacity]: a weight above capacity could never be satisfied
    // and would deadlock the queue; non-finite input degrades to 1.
    const w = Math.min(Number.isFinite(weight) ? Math.max(1, Math.floor(weight)) : 1, this.capacity);
    this.refill();
    if (this.queue.length === 0 && this.tokens >= w) {
      this.tokens -= w;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push({ weight: w, resolve });
      this.pump();
    });
  }
}

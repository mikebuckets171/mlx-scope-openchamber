/** One request and one timer at most. Hidden panels do no polling work. */
export class Poller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<void> | null = null;
  private pendingGeneration = 0;
  private generation = 0;
  private restartAfterPending = false;
  private stopped = true;
  private paused = false;

  constructor(private readonly run: () => Promise<number>) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.generation += 1;
    void this.refresh();
  }
  stop(): void {
    this.stopped = true;
    this.generation += 1;
    this.restartAfterPending = false;
    this.clear();
  }
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.generation += 1;
    this.clear();
    if (!paused && !this.stopped) void this.refresh();
  }
  refresh(): Promise<void> {
    this.clear();
    if (this.pending) {
      if (this.pendingGeneration !== this.generation) this.restartAfterPending = true;
      return this.pending;
    }
    if (this.stopped || this.paused) return Promise.resolve();
    const generation = this.generation;
    const work = Promise.resolve().then(this.run).catch(() => 5_000).then((delay) => {
      const safeDelay = Number.isFinite(delay) ? Math.max(100, Math.min(60_000, delay)) : 5_000;
      if (generation === this.generation && !this.stopped && !this.paused) {
        this.timer = setTimeout(() => { this.timer = null; void this.refresh(); }, safeDelay);
      }
    });
    this.pendingGeneration = generation;
    let pending!: Promise<void>;
    pending = work.finally(() => {
      if (this.pending === pending) this.pending = null;
      if (this.restartAfterPending && !this.stopped && !this.paused) {
        this.restartAfterPending = false;
        void this.refresh();
      }
    });
    this.pending = pending;
    return pending;
  }
  private clear(): void { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
}

/**
 * The next poll: the service's `nextPollMs` after a reading, else the 1.6 backoff. The service owns the cadence, including
 * the ≥ 10 s back-off of a lower-priority frame while a higher-priority one leads, so there is no panel-side cap; energy
 * saving never polls faster than its floor (3 s for the panel and page, 5 s for the Work Status section).
 */
export const pollDelay = ({ failures, nextPollMs, efficient, floorMs = 3_000 }: { failures: number; nextPollMs: number | null; efficient: boolean; floorMs?: number }): number => {
  const delay = failures > 0 ? Math.min(15_000, 1_000 * 2 ** Math.min(4, failures - 1)) : nextPollMs ?? 2_000;
  return efficient ? Math.max(floorMs, delay) : delay;
};
/** "No fresh reading" deadline: max(6 s, 2 × the scheduled delay + 1 s), so a slow cadence never reads as a stall. */
export const freshnessDeadline = (delayMs: number): number => Math.max(6_000, 2 * delayMs + 1_000);

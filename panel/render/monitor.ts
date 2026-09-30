import type { CompletionV2 } from '../../src/contract/completion.ts';
import type { SnapshotClient, SnapshotQuery } from '../data/client.ts';
import { freshnessDeadline, Poller, pollDelay } from '../data/poller.ts';
import type { Visibility } from '../data/visibility.ts';
import type { Reading } from '../present/reading.ts';
import type { ScopeState } from '../state/scope-state.ts';

export interface MonitorParts {
  state: ScopeState; client: SnapshotClient; frame: string; visibility: () => Visibility;
  tier: 'glance' | 'full'; floorMs: number;
  /** Selection, `detail`, `mark` and `attr` for the next poll. */
  query: () => Omit<SnapshotQuery, 'frame' | 'surface' | 'since' | 'tier'>;
  received: (reading: Reading, fresh: CompletionV2[]) => void;
  hidden: () => void;
  render: () => void;
  refreshed: () => void;
}

/** Polls `/v2/snapshot` while the frame is visible and not paused, at the cadence the service asks for, and renders each reading. */
export class Monitor {
  readonly poller: Poller;
  private delay = 2_000;
  constructor(private readonly p: MonitorParts) {
    this.poller = new Poller(() => this.poll());
  }
  get live(): boolean { return !this.p.state.userPaused && this.p.visibility().visible; }

  private async poll(): Promise<number> {
    const { state, client } = this.p, generation = state.generation;
    const current = (): boolean => !state.disposed && generation === state.generation && this.live;
    try {
      const reading = await client.read({ ...this.p.query(), frame: this.p.frame, surface: state.surface, since: state.since, tier: this.p.tier });
      // Only a poll without a body backs off here; with one, the service's own backoff is already in nextPollMs.
      if (current()) { state.failures = reading.body ? 0 : state.failures + 1; state.awaitingFresh = false; this.apply(reading); }
    } catch (error) {
      if (current()) { state.failures += 1; state.awaitingFresh = false; this.apply(client.failure(error)); }
    } finally {
      if (state.manualRefresh) { state.manualRefresh = false; this.p.refreshed(); }
    }
    this.delay = pollDelay({ failures: state.failures, nextPollMs: state.snapshot?.nextPollMs ?? null, efficient: state.efficient, floorMs: this.p.floorMs });
    if (current()) this.armFreshness();
    return this.delay;
  }

  /** Apply one reading. A reading from another connection first discards every observation of the previous one. */
  apply(reading: Reading): void {
    const { state } = this.p;
    if (state.isNewConnection(reading)) state.clearObservations();
    const fresh = state.accept(reading);
    if (reading.available) state.signal.observe(reading, state.efficient ? 3_000 : this.delay);
    else if (reading.body) state.signal.break();
    this.p.received(reading, fresh);
    this.p.render();
  }

  clearFreshness(): void { const state = this.p.state; if (state.freshnessTimer !== null) clearTimeout(state.freshnessTimer); state.freshnessTimer = null; }
  /** One deadline, not an animation loop: a stalled request cannot leave a live rate on screen. */
  armFreshness(): void {
    const state = this.p.state;
    this.clearFreshness();
    if (state.disposed || !this.live) return;
    state.freshnessTimer = setTimeout(() => { state.freshnessTimer = null; state.stale = true; state.signal.break(); this.p.render(); }, freshnessDeadline(this.delay));
  }

  /** Pause or resume polling for the user and the visibility gate; resuming never shows old readings as live. */
  sync(): void {
    const { state } = this.p;
    state.generation += 1;
    const live = this.live;
    this.poller.setPaused(!live);
    if (!live) {
      state.interrupted = true; state.awaitingFresh = true;
      this.clearFreshness(); state.signal.break(); this.p.hidden(); this.p.render();
      return;
    }
    if (state.interrupted) { state.interrupted = false; this.p.render(); }
    this.armFreshness();
  }
}

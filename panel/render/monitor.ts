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
  /** The `since` to send, given the frame's own cursor (a recording leader holds it back). */
  since?: (frame: number | undefined) => number | undefined;
  received: (reading: Reading, fresh: CompletionV2[], cadenceMs: number) => void;
  /** Whether the frame polls now (visible and not paused). */
  live?: (live: boolean) => void;
  hidden: () => void;
  render: () => void;
  refreshed: () => void;
}

/** Polls `/v2/snapshot` while the frame is visible and not paused, at the cadence the service asks for, and renders each reading. */
export class Monitor {
  readonly poller: Poller;
  private delay = 2_000;
  private splashBoundaryAt: number | null = null;
  private chatTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly p: MonitorParts) {
    this.poller = new Poller(() => this.poll());
  }
  get live(): boolean { return !this.p.state.userPaused && this.p.visibility().visible; }

  private async poll(): Promise<number> {
    const { state, client } = this.p, generation = state.generation;
    const current = (): boolean => !state.disposed && generation === state.generation && this.live;
    try {
      const since = this.p.since ? this.p.since(state.since) : state.since;
      const reading = await client.read({ ...this.p.query(), frame: this.p.frame, surface: state.surface, since, tier: this.p.tier });
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
    if (state.isNewConnection(reading)) {
      state.clearObservations();
      this.splashBoundaryAt = reading.sampledAt;
    }
    reading = this.afterSplashBoundary(reading);
    const fresh = state.accept(reading);
    if (reading.available) state.signal.observe(reading, state.efficient ? 3_000 : this.delay);
    else if (reading.body) state.signal.break();
    this.p.received(reading, fresh, state.efficient ? 3_000 : this.delay);
    this.p.render();
  }

  /** Each frame starts afresh after a pause or connection switch without resetting other frames' shared samples. */
  private afterSplashBoundary(reading: Reading): Reading {
    const body = reading.body, boundary = this.splashBoundaryAt;
    if (boundary === null || body?.connection.runtime !== 'splash') return reading;
    const source = body.runtime.server.rates, sampledAt = body.runtime.sampledAt;
    const follows = (window: number | undefined): boolean => sampledAt !== undefined && window !== undefined
      && window >= 2_000 && window <= 5_000 && sampledAt - window >= boundary;
    const rates = { ...source };
    if (source && !follows(source.windowMs)) delete rates.decodeTps;
    if (source && !follows(source.promptWindowMs ?? (source.decodeTps === undefined ? source.windowMs : undefined))) { delete rates.promptTps; delete rates.promptWindowMs; }
    const previous = body.runtime.request;
    const oldProgress = previous?.prefillFraction !== undefined && !(previous.prefillObservedAt !== undefined && previous.prefillObservedAt >= boundary);
    if (!oldProgress && (!source || rates.decodeTps === source.decodeTps && rates.promptTps === source.promptTps)) return reading;
    // Keep the boundary for both stages: qualifying generation must not release an older prefill window.
    // The shared service body, lifetime statistics, host data and completions retain their separate bases.
    const server = { ...body.runtime.server }, capabilities = { ...body.capabilities };
    if (source) {
      if (rates.decodeTps === undefined && rates.promptTps === undefined) { delete server.rates; delete capabilities['server.rates']; }
      else { if (rates.decodeTps === undefined) rates.windowMs = rates.promptWindowMs ?? rates.windowMs; server.rates = rates as typeof source; }
    }
    let request = previous;
    if (oldProgress) {
      request = { ...previous! };
      for (const key of ['prefillFraction', 'prefillProcessedTokens', 'prefillTotalTokens', 'prefillStale', 'prefillObservedAt', 'prefillEtaMs', 'prefillTps'] as const) delete request[key];
      delete capabilities['request.prefillProgress']; delete capabilities['request.prefillEta']; delete capabilities['request.prefillRate'];
      if (!Object.values(request).some(value => value != null)) request = null;
    }
    return { ...reading, request, body: { ...body, capabilities, runtime: { ...body.runtime, server, request } } };
  }

  clearFreshness(): void {
    const state = this.p.state;
    if (state.freshnessTimer !== null) clearTimeout(state.freshnessTimer); state.freshnessTimer = null;
    if (this.chatTimer !== null) clearTimeout(this.chatTimer); this.chatTimer = null;
  }
  /** One deadline, not an animation loop: a stalled request cannot leave a live rate on screen. */
  armFreshness(): void {
    const state = this.p.state;
    this.clearFreshness();
    if (state.disposed || !this.live) return;
    const expiry = state.snapshot?.chat?.expiresAtMs;
    if (expiry !== undefined && expiry > this.p.client.now()) this.chatTimer = setTimeout(() => {
      this.chatTimer = null; this.p.render();
    }, expiry - this.p.client.now());
    state.freshnessTimer = setTimeout(() => { state.freshnessTimer = null; state.stale = true; state.signal.break(); this.p.render(); }, freshnessDeadline(this.delay));
  }

  /** Pause or resume polling for the user and the visibility gate; resuming never shows old readings as live. */
  sync(): void {
    const { state } = this.p;
    state.generation += 1;
    const live = this.live;
    if (live && state.interrupted) this.splashBoundaryAt = this.p.client.now();
    this.poller.setPaused(!live);
    this.p.live?.(live);
    if (!live) {
      state.interrupted = true; state.awaitingFresh = true;
      this.clearFreshness(); state.signal.break(); this.p.hidden(); this.p.render();
      return;
    }
    if (state.interrupted) { state.interrupted = false; this.p.render(); }
    this.armFreshness();
  }
}

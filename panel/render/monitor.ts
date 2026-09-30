import type { CaptureView } from '../capture-view.ts';
import type { ChartInspector } from '../chart-inspector.ts';
import type { ConnectionsView } from '../connections-view.ts';
import type { SnapshotClient } from '../data/client.ts';
import { Poller, pollDelay } from '../data/poller.ts';
import type { Visibility } from '../data/visibility.ts';
import type { InsightView } from '../insights-view.ts';
import { presentHeader } from '../present/header.ts';
import { presentLive, presentProgress, type ProgressHold } from '../present/live.ts';
import { NO_FRESH_READING } from '../present/messages.ts';
import { frameReading, type Reading } from '../present/reading.ts';
import { derive } from '../present/scope.ts';
import { presentServer } from '../present/server.ts';
import type { ScopeState } from '../state/scope-state.ts';
import { clearHostTraces, drawSignal } from './chart.ts';
import type { Dom } from './dom.ts';
import { renderHeader, renderHost, renderLive, renderProgress, renderServer } from './scope.ts';

export interface MonitorParts {
  dom: Dom; shell: HTMLElement; state: ScopeState; client: SnapshotClient; frame: string; visibility: () => Visibility;
  inspector: ChartInspector; insights: InsightView; captures: () => CaptureView; connections: () => ConnectionsView;
  refreshButton: HTMLButtonElement;
}

/** Polls `/v2/snapshot` while the frame is visible and monitoring, and renders each reading through the presenters. */
export class Monitor {
  readonly poller: Poller;
  constructor(private readonly p: MonitorParts) {
    this.poller = new Poller(() => this.poll());
  }
  /** Not paused, visible, and not on the Saved tab. */
  // 2.0: every tab keeps monitoring (plan §5.9); only the user's pause and the visibility gate stop polls.
  get live(): boolean { return !this.p.state.userPaused && this.p.visibility().visible; }

  private async poll(): Promise<number> {
    const { state, client, connections } = this.p, generation = state.generation;
    const current = (): boolean => !state.disposed && generation === state.generation && this.live;
    try {
      const reading = await client.read({ ...connections().query(), frame: this.p.frame, surface: state.surface, since: state.since });
      if (current()) { state.failures = reading.available ? 0 : state.failures + 1; state.awaitingFresh = false; this.apply(reading); this.armFreshness(); }
    } catch (error) {
      if (current()) { state.failures += 1; state.awaitingFresh = false; this.apply(client.failure(error)); }
    } finally {
      if (state.manualRefresh) { this.p.refreshButton.disabled = state.userPaused; this.p.refreshButton.removeAttribute('aria-busy'); state.manualRefresh = false; }
    }
    return pollDelay({ failures: state.failures, nextPollMs: state.last?.body?.nextPollMs ?? null, host: state.latest.host !== null, efficient: state.efficient });
  }

  /** Render one reading. A reading from another connection first discards every observation of the previous one. */
  apply(reading: Reading): void {
    const { dom, shell, state, client, insights, inspector } = this.p;
    if (state.isNewConnection(reading)) this.clearObservations();
    state.accept(reading);
    this.p.connections().update(reading.link);
    const lastRequest = state.lastRequest, now = client.now();
    insights.update(reading, lastRequest);
    const scope = derive({ reading, last: state.last, host: state.lastHost, lastRequest, selectionRuntime: this.p.connections().selection.runtime,
      speed: insights.history.speed, now });
    const live = presentLive(scope);
    renderHeader(dom, shell, presentHeader(scope));
    renderLive(dom, live);
    renderProgress(dom, presentProgress(scope.current));
    this.p.captures().update(reading);
    renderServer(dom, presentServer(scope));
    renderHost(dom, live.host);
    state.resources.observe(reading.host);
    const visible = !state.compact && state.view === 'live';
    if (visible) {
      dom.node('cpu-history').setAttribute('d', state.resources.paths('cpu', now));
      dom.node('ram-history').setAttribute('d', state.resources.paths('memory', now));
    }
    dom.text('resource-state', live.host.resourceState);
    state.signal.observe(reading, state.efficient ? 3_000 : 500, scope.observed?.tokensPerSecond ?? null);
    if (visible) drawSignal(dom, state.signal, inspector, now, scope.liveRate !== null && !scope.stale, scope.phase);
  }

  clearObservations(): void {
    const { dom, state, inspector } = this.p;
    state.clearObservations();
    this.p.insights.clear(); this.p.captures().capture.clear(); this.p.captures().suspend();
    drawSignal(dom, state.signal, inspector, this.p.client.now(), false, 'unknown');
    clearHostTraces(dom);
  }
  drawSignal(): void { drawSignal(this.p.dom, this.p.state.signal, this.p.inspector, this.p.client.now(), false, this.p.state.latest.phase); }
  progress(held: ProgressHold): void {
    const latest = this.p.state.latest;
    renderProgress(this.p.dom, presentProgress(latest.available ? latest : null, held));
  }

  clearFreshness(): void { const state = this.p.state; if (state.freshnessTimer !== null) clearTimeout(state.freshnessTimer); state.freshnessTimer = null; }
  armFreshness(): void {
    const state = this.p.state;
    this.clearFreshness();
    if (state.disposed || !this.live) return;
    // One deadline, not an animation loop. Stalled SDK requests cannot leave a live rate on screen.
    state.freshnessTimer = setTimeout(() => {
      state.freshnessTimer = null;
      this.apply(frameReading('runtime_unreachable', NO_FRESH_READING, this.p.client.now()));
    }, state.efficient ? 10_000 : 6_000);
  }
  private holdRuntimeMemory(label: string): void {
    this.p.dom.text('runtime-memory-source', label);
    this.p.dom.node('runtime-memory').dataset.stale = 'true';
  }
  private holdSplashStatistics(label: string): void {
    const { dom, state } = this.p;
    if ((state.last?.runtime ?? state.latest.runtime) !== 'splash') return;
    dom.node('session-stats').dataset.stale = 'true';
    dom.text('session-stats-state', label);
  }

  /** Pause or resume polling for the user and the visibility gate; resuming never shows old readings as live. */
  sync(): void {
    const { dom, shell, state } = this.p;
    state.generation += 1;
    const live = this.live;
    this.poller.setPaused(!live);
    if (!live) {
      state.interrupted = true; state.awaitingFresh = true;
      this.holdRuntimeMemory(state.userPaused ? 'Frozen reading' : 'Last reading · not live');
      this.holdSplashStatistics(state.userPaused ? 'Paused · last reading' : 'Last reading · not live');
      this.clearFreshness(); state.resources.break(); state.signal.break(); this.p.insights.suspend(); this.p.captures().suspend();
      return;
    }
    if (state.interrupted) {
      state.interrupted = false;
      this.holdRuntimeMemory('Last reading · refreshing');
      this.holdSplashStatistics('Last reading · refreshing');
      dom.text('rate', '—'); dom.text('unit', 'Waiting for a fresh reading');
      dom.text('phase', 'Refreshing'); dom.text('connection', 'Resuming monitoring');
      shell.dataset.stale = 'true';
      dom.node('machine').dataset.stale = 'true';
      dom.text('machine-freshness', 'Last reading · refreshing');
      dom.text('resource-state', 'Last readings · refreshing');
      dom.hidden('request-output', true);
      this.progress('refreshing');
      this.p.insights.suspend(); this.p.captures().suspend();
      this.drawSignal();
    }
    this.armFreshness();
  }
}

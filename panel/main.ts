import { connectHost } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { parseTelemetrySnapshot, unavailableTelemetry, type AvailableTelemetry, type TelemetryPhase, type TelemetrySnapshot } from '../src/telemetry.ts';
import { SignalHistory, nextDelay, traceGeometry } from './signal.ts';
import { ResourceHistory, toGiB } from './resources.ts';
import type { SystemSnapshot } from '../src/system.ts';
import { unavailableForHostError, unavailableForServiceResponse } from './host-errors.ts';
import { Poller } from './poller.ts';
import { prefillReading } from './progress.ts';
import { Preferences, type PreferenceKey } from './preferences.ts';
import { measurementReport } from './report.ts';
import { InsightView } from './insights-view.ts';
import { CaptureView, captureMarkup } from './capture-view.ts';
import { SharingControls } from './openchamber-view.ts';
import { contextBudget } from './context.ts';
import { ChartInspector } from './chart-inspector.ts';
import { ConnectionHelp } from './connection-help.ts';
import { ConnectionsView, connectionsMarkup } from './connections-view.ts';
import { connectionName } from '../src/runtime.ts';
import { SavedView, savedMarkup } from './saved-view.ts';
import { snapshotObservation, captureObservation } from './saved.ts';
import { WorkspaceTabs, type Workspace } from './workspace.ts';
import { version } from '../package.json';

const root = document.querySelector<HTMLElement>('#root');
if (!root) throw new Error('MLX Scope is missing its root element.');
const startupFallback = root.querySelector<HTMLElement>('#startup-fallback');
const startupStatus = startupFallback?.querySelector<HTMLElement>('[role="status"]');
if (!startupFallback || !startupStatus) throw new Error('MLX Scope is missing its startup fallback.');
let mounted = false;
let startupFailed = false;
const showStartupFailure = (): void => {
  if (mounted) return;
  startupFailed = true;
  startupStatus.textContent = 'The extension interface could not start. Reload MLX Scope from OpenChamber’s Settings → Extensions.';
  if (startupFallback.parentElement !== root || root.childElementCount > 1) root.replaceChildren(startupFallback);
};
window.addEventListener('error', () => showStartupFailure(), true);
window.addEventListener('unhandledrejection', () => showStartupFailure());
const host = connectHost();

// This static shell is mounted once. Polls patch text/geometry, never controls.
root.innerHTML = `
<main class="scope" aria-labelledby="scope-title">
  <header class="masthead">
    <div class="brand"><svg class="scope-mark" viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="14" r="11"/><path d="M3 14h6l3-5 4 10 3-5h6"/></svg><h1 id="scope-title">MLX <span>Scope</span></h1></div>
    <div class="status-pill"><span class="connection-dot" aria-hidden="true"></span><span id="phase" class="phase">Connecting</span><span class="status-sep" aria-hidden="true">·</span><span id="connection" role="status">Connecting to local runtime</span></div>
    <div class="monitor-controls">
      <button id="pause" type="button" aria-pressed="false" title="Pause this monitor, not inference"><svg viewBox="0 0 20 20" aria-hidden="true"><path id="pause-symbol" d="M7 5v10M13 5v10"/></svg><span id="pause-label" class="sr-only">Pause</span></button>
      <details class="monitor-menu" id="monitor-menu"><summary aria-label="More options" title="More options"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4.5" cy="10" r="1.3"/><circle cx="10" cy="10" r="1.3"/><circle cx="15.5" cy="10" r="1.3"/></svg></summary>
        <div class="monitor-menu-content">
          <button id="refresh" type="button" title="Refresh readings" disabled><span class="menu-check" aria-hidden="true"></span>Refresh readings</button>
          <button id="compact" type="button" aria-pressed="false"><span class="menu-check" aria-hidden="true"></span>Compact view</button>
          <button id="efficiency" type="button" aria-pressed="false" title="Reduce monitoring refresh frequency"><span class="menu-check" aria-hidden="true"></span>Energy-saving updates</button>
          <button id="save-snapshot" type="button" title="Keep the 12 newest observations; the oldest is replaced when full" disabled><span class="menu-check" aria-hidden="true"></span>Save snapshot</button>
          <div id="share-actions" class="share-actions" aria-label="Share readings"></div>
          <button id="connection-change" type="button" aria-expanded="false" aria-controls="connection-setup"><span class="menu-check" aria-hidden="true"></span>Change connection</button>
          <p class="menu-about"><span id="cadence">Adaptive updates</span><span>Local · read-only · server-wide observations</span></p>
        </div>
      </details>
    </div>
  </header>
  ${connectionsMarkup}
  <div id="connection-diagnosis" class="connection-diagnosis" hidden><p id="connection-message"></p><button id="connection-configure" type="button">Choose connection</button></div>
  <p id="action-status" class="action-status" role="status" hidden></p>
  <p id="notice" class="notice" role="status" hidden></p>
  <nav class="workspace-nav" aria-label="Scope workspaces"><div role="tablist" aria-label="Scope workspaces">
    <button id="tab-live" role="tab" type="button" data-view="live" aria-controls="view-live" aria-selected="true">Live</button>
    <button id="tab-server" role="tab" type="button" data-view="server" aria-controls="view-server" aria-selected="false" tabindex="-1">Server</button>
    <button id="tab-compare" role="tab" type="button" data-view="compare" aria-controls="view-compare" aria-selected="false" tabindex="-1">Compare</button>
    <button id="tab-saved" role="tab" type="button" data-view="saved" aria-controls="view-saved" aria-selected="false" tabindex="-1">Saved</button>
  </div></nav>
  <div id="view-live" role="tabpanel" aria-labelledby="tab-live" tabindex="0">
  <section id="instrument" class="instrument" aria-label="Inference activity">
    <span id="activity-label" class="sr-only">MODEL ACTIVITY</span>
    <h2 id="model" translate="no">Your local model</h2>
    <p id="splash-model-detail" class="splash-model-detail" hidden></p>
    <p id="coverage-note" class="coverage-note" hidden></p>
    <section id="catalog-section" class="catalog-section" aria-labelledby="catalog-title" hidden><div class="section-heading"><h3 id="catalog-title">Model inventory</h3><span id="catalog-count"></span></div><ul id="catalog-list" class="catalog-list"></ul><p id="catalog-note" class="insight-note"></p></section>
    <section id="prefill-progress" class="prefill-progress" aria-label="Prefill progress" hidden>
      <div class="prefill-values"><strong id="prefill-remaining">—</strong><span id="prefill-completed">—</span></div>
      <div id="prefill-track" class="progress-track" role="progressbar" aria-label="Prefill stage completed" aria-valuemin="0" aria-valuemax="100"><span></span></div>
      <div class="prefill-heading"><span id="prefill-counts" class="prefill-counts"></span><span id="prefill-state">Live reading</span></div>
      <div id="prefill-estimate" class="prefill-estimate" hidden><span>Reported stage estimate</span><strong id="prefill-eta">—</strong><small id="estimate-source">Runtime estimate · may change</small></div>
    </section>
    <div class="hero-row">
      <div class="readout"><span id="rate" class="rate">—</span><span id="unit" class="unit">Waiting for readings</span></div>
      <figure id="signal" class="signal" aria-label="No observed throughput yet">
        <div class="chart-top"><span id="chart-title">Request throughput</span><span id="ceiling">tok/s</span></div>
        <div id="history-inspector" class="plot" role="slider" tabindex="-1" aria-orientation="horizontal" aria-describedby="history-reading" aria-label="Inspect throughput history" aria-valuemin="0" aria-valuemax="0" aria-disabled="true"><svg viewBox="0 0 600 120" preserveAspectRatio="none" aria-hidden="true"><path class="grid" d="M4 4H596 M4 60H596 M4 116H596"/><g id="trace"></g><circle id="cursor" r="3" hidden/><line id="inspect-line" y1="4" y2="116" hidden/><circle id="inspect-dot" r="4" hidden/></svg><span id="chart-empty">The next request starts here.</span></div>
        <figcaption><span>−90s</span><span id="chart-state">Observed samples only</span><span id="chart-end">now</span></figcaption>
        <p id="history-reading" class="history-reading">History appears as readings arrive</p>
      </figure>
    </div>
    <p id="activity" class="activity">Connecting through OpenChamber.</p>
    <div id="recent-speed" class="recent-speed" hidden><strong id="window-speed">—</strong><span id="window-span">Recent generation speed</span></div>
    <p id="request-output" class="request-output" hidden></p>
    <div id="context-headroom" class="context-headroom" hidden title="Reported prompt plus output against the model context limit. This is not OpenCode's compaction threshold or reserved output budget."><div class="context-line"><span>Context used</span><span><strong id="context-remaining">—</strong><small class="context-accounted"> · <span id="context-accounted">Not reported</span></small></span></div><div class="meter" aria-hidden="true"><i id="context-used-bar"></i></div></div>
    <div class="metrics" aria-label="Current request">
      <div><span class="metric-label">Output</span><strong id="output">—</strong></div>
      <div><span class="metric-label">Elapsed</span><strong id="elapsed">—</strong></div>
      <div><span class="metric-label">Input reused</span><strong id="reuse">—</strong><span id="reuse-detail" class="metric-detail">Not reported</span><div class="meter" aria-hidden="true"><i id="reuse-bar"></i></div></div>
      <div><span class="metric-label">Requests</span><strong id="requests">—</strong><span id="queue" class="metric-detail">Waiting for runtime</span></div>
    </div>
  </section>
  <section id="machine" class="machine" aria-labelledby="machine-title" hidden>
    <h2 id="machine-title" class="sr-only">Host resources</h2>
    <div class="machine-line"><span>CPU <strong id="cpu">—</strong></span><span title="Physical memory minus OS-reported free memory. Includes reclaimable pages; not Activity Monitor’s Memory Used or memory pressure.">RAM <strong id="ram">—</strong></span><span>Swap <strong id="swap">—</strong></span></div>
    <details id="host-details" class="host-details"><summary>Mac details</summary>
      <p id="hardware" class="hardware"></p>
      <div class="machine-values"><div><span>CPU</span><div class="meter" aria-hidden="true"><i id="cpu-bar"></i></div></div><div><span>Non-free RAM</span><div class="meter" aria-hidden="true"><i id="ram-bar"></i></div></div></div>
      <figure class="resource-trace" role="img" aria-label="CPU and non-free memory over the last 90 seconds, on a fixed zero to 100 percent scale">
        <div class="chart-top"><span><i class="legend-cpu"></i>CPU <i class="legend-ram"></i>RAM</span><span>0–100%</span></div>
        <svg viewBox="0 0 300 60" preserveAspectRatio="none" aria-hidden="true"><path class="grid" d="M2 2H298 M2 30H298 M2 58H298"/><path id="cpu-history"/><path id="ram-history"/></svg>
        <figcaption><span>−90s</span><span id="resource-state">Whole-host observations</span></figcaption>
      </figure>
      <div id="mac-memory" class="mac-memory" hidden><dl class="native-values"><div><dt>Wired</dt><dd id="wired">—</dd></div><div><dt>Compressed</dt><dd id="compressed">—</dd></div></dl></div>
      <p class="machine-explanation"><span id="machine-freshness">Waiting for a sample</span> · <span id="native-freshness">Native readings · every 10s</span>. Whole host, not the inference runtime alone. Non-free RAM includes reclaimable pages; it is not Activity Monitor’s Memory Used.</p>
    </details>
  </section>
  </div>
  <div id="view-server" role="tabpanel" aria-labelledby="tab-server" tabindex="0" hidden>
  <section id="runtime-memory" class="insight-section runtime-memory" aria-labelledby="runtime-memory-title" hidden>
    <div class="section-heading"><h2 id="runtime-memory-title">Runtime memory</h2><span id="runtime-memory-source">Server-wide</span></div>
    <div class="runtime-memory-values"><div><span id="process-label">Runtime process footprint</span><strong id="process-memory">—</strong></div><div><span id="model-label">Model allocation</span><strong id="model-memory">—</strong></div></div>
    <p id="runtime-memory-note" class="insight-note">Reported totals can overlap; they are not per-chat memory.</p>
  </section>
  <section id="cache-lens" class="insight-section" aria-labelledby="cache-title">
    <div class="section-heading"><h2 id="cache-title">Cache &amp; input</h2><span id="cache-scope">Current request</span></div>
    <p id="cache-request-state" class="insight-note">Waiting for cache readings</p>
    <div class="cache-input-values"><div><span>Reused tokens</span><strong id="cache-reuse-count">—</strong></div><div><span>Not reused</span><strong id="cache-new-count">—</strong></div></div>
    <div id="cache-input-bar" class="cache-input-bar" role="img" aria-label="Input cache reuse"><span id="cache-reused-fill"></span></div>
    <div class="cache-tier-values"><div><span>RAM cache</span><strong id="cache-ram-size">—</strong></div><div><span>SSD cache</span><strong id="cache-ssd-size">—</strong></div><div><span class="metric-label" title="Input tokens as a share of the model context limit">Input context</span><strong id="context">—</strong><span id="context-detail" class="metric-detail">Not reported</span><div class="meter" aria-hidden="true"><i id="context-bar"></i></div></div></div>
    <p id="cache-bank-state" class="insight-note">Server cache totals</p>
    <p class="insight-note">Unreused input is not necessarily the size of a prefill stage.</p>
  </section>
  <section id="resident-section" class="insight-section" aria-labelledby="resident-title" hidden>
    <div class="section-heading"><h2 id="resident-title">Loaded models</h2><span id="resident-count"></span></div>
    <ul id="resident-list" class="resident-list"></ul><p id="resident-note" class="insight-note"></p>
  </section>
  <p id="runtime-advisory" class="runtime-advisory" role="status" hidden></p>
  <section id="session-stats" class="session insight-section" aria-labelledby="session-title"><div class="section-heading"><h2 id="session-title">Server session</h2><span id="uptime">Since start / reset</span></div><div class="session-values"><div><span id="stats-label-one">Decode average</span><strong id="average-decode">—</strong></div><div><span id="stats-label-two">Prefill average</span><strong id="average-prefill">—</strong></div><div><span id="stats-label-three">Cache efficiency</span><strong id="average-cache">—</strong></div></div><p id="session-stats-state" class="native-note">Completed requests across all models</p></section>
  <details class="details" id="runtime-details"><summary>Runtime details</summary><dl>
    <div><dt>Prefix cache · SSD</dt><dd id="ssd-cache">—</dd></div>
    <div><dt>Runtime memory guard</dt><dd id="pressure">—</dd></div>
    <div><dt>Last cache lookup</dt><dd id="cache-lookup">—</dd></div>
  </dl><p class="explanation">Generation uses the reported request average when available. Otherwise, recent output speed is clearly labelled and measured from token counts. Prefill uses reported progress speed. Session averages cover completed work across models. Runtime memory guard is not macOS memory pressure. Memory uses GiB (1,024³ bytes). Compressed is physical compressor storage. Missing measurements stay unavailable.</p></details>
  </div>
  <section id="view-compare" role="tabpanel" aria-labelledby="tab-compare" tabindex="0" hidden>
    ${captureMarkup}
    <section id="recent-generations" class="insight-section" aria-labelledby="recent-title">
      <div class="section-heading"><h2 id="recent-title">Recent generations</h2><span id="recent-count">0 / 8</span></div>
      <p class="insight-note">Last observed readings · not completion records</p>
      <ol id="recent-list" class="recent-list"><li class="insight-note">Your next generation will appear here when it leaves the active view.</li></ol>
      <div class="insight-actions"><button id="copy-recent" type="button" disabled>Copy recent</button><button id="clear-recent" type="button" disabled title="Clear this view’s observation history, not runtime statistics">Clear history</button></div>
      <p class="insight-note">Kept only while this view is open. A request leaving the view does not confirm completion.</p>
    </section>
  </section>
  ${savedMarkup}
  <details class="connection-help" id="connection-help"><summary>Connection help</summary><p id="connection-result" role="status">Check whether OpenChamber has started the extension service. This does not change your configuration.</p><div class="insight-actions"><button id="check-connection" type="button">Check extension service</button><button id="connection-guide" type="button">Setup guide</button></div></details>
  <footer><span>MLX Scope <span id="scope-version"></span></span><span id="freshness">Waiting for first sample</span></footer>
</main>`;
root.prepend(startupFallback);

const nodes = new Map<string, HTMLElement>();
root.querySelectorAll<HTMLElement>('[id]').forEach((node) => nodes.set(node.id, node));
const node = (id: string): HTMLElement => nodes.get(id)!;
const text = (id: string, value: string): void => { const target = node(id); if (target.textContent !== value) target.textContent = value; };
const hidden = (id: string, value: boolean): void => { node(id).hidden = value; };
const meter = (id: string, value: number | null): void => { node(id).style.width = `${value === null ? 0 : Math.min(100, Math.max(0, value))}%`; };
const button = node('refresh') as HTMLButtonElement;
const shell = root.querySelector<HTMLElement>('.scope')!;
shell.hidden = true;
let signal = new SignalHistory();
let resources = new ResourceHistory();
const inspector = new ChartInspector(node('history-inspector'), node('history-reading'));
const connectionHelp = new ConnectionHelp(shell, host, version);
text('scope-version', version);
const insightView = new InsightView(root);
const pauseButton = node('pause') as HTMLButtonElement;
let lastSystem: SystemSnapshot | null = null;
let userPaused = false;
let efficient = false;
let compactView = false;
let activeView: Workspace = 'live';
const preferences = new Preferences(host.storage);
let freshnessTimer: ReturnType<typeof setTimeout> | null = null;
let latest: TelemetrySnapshot = unavailableTelemetry('runtime_unreachable');
let last: AvailableTelemetry | null = null;
let failures = 0;
let disposed = false;
let monitorGeneration = 0;
let manualRefresh = false;
let interrupted = false;
let awaitingFresh = false;
let monitoredConnection: string | null = null;
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const rateNumber = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const count = (value: number | null | undefined): string => value == null ? '—' : compact.format(value);
const rate = (value: number | null | undefined): string => value == null ? '—' : `${rateNumber.format(value)} tok/s`;
const gb = (value: number | null | undefined): string => value == null ? '—' : `${number.format(toGiB(value))} GiB`;
const ratio = (a: number | null | undefined, b: number | null | undefined): number | null => a == null || b == null || b <= 0 ? null : a / b * 100;
const percent = (value: number | null | undefined): string => value == null ? '—' : `${Math.round(value)}%`;
const finishedAgo = (at: number): string => { const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000)); return seconds < 3 ? 'just finished' : seconds < 60 ? `finished ${seconds}s ago` : `finished ${Math.floor(seconds / 60)}m ago`; };
const age = (at: number): string => { const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000)); return seconds < 3 ? 'Updated now' : seconds < 60 ? `Updated ${seconds}s ago` : `Updated ${Math.floor(seconds / 60)}m ago`; };
const phases: Record<TelemetryPhase, string> = { connecting: 'Connecting', reconnecting: 'Reconnecting', offline: 'Offline', notLoaded: 'No model', idle: 'Ready', queued: 'Queued', prefill: 'Reading context', decode: 'Generating', processing: 'Processing', unknown: 'Unavailable' };

const drawSignal = (now: number, live: boolean, phase: TelemetryPhase): void => {
  signal.prune(now);
  const tracePhase = phase === 'prefill' ? 'prefill' : phase === 'decode' ? 'decode' : signal.points.at(-1)?.phase ?? 'decode';
  const basis = signal.points.filter(point => point.phase === tracePhase).at(-1)?.basis;
  const points = signal.points.filter(point => point.phase === tracePhase && point.basis === basis);
  const geometry = traceGeometry(points, now);
  const group = document.getElementById('trace')!;
  // Reuse path elements when the segment count is unchanged.
  while (group.childElementCount > geometry.paths.length) group.lastElementChild!.remove();
  geometry.paths.forEach((path, index) => {
    let target = group.children[index];
    if (!target) {
      target = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      group.append(target);
    }
    target.setAttribute('d', path);
  });
  const cursor = document.getElementById('cursor')!;
  if (geometry.latest) {
    cursor.removeAttribute('hidden');
    cursor.setAttribute('cx', String(geometry.latest.x)); cursor.setAttribute('cy', String(geometry.latest.y));
  } else cursor.setAttribute('hidden', '');
  hidden('chart-empty', points.length > 0);
  node('signal').dataset.points = String(points.length);
  text('chart-title', tracePhase === 'prefill' ? 'Prefill · reported speed' : basis === 'observed' ? 'Generation · recent output' : 'Generation · request average');
  text('ceiling', `${count(geometry.upper)} tok/s`);
  inspector.update(points, now, geometry.upper);
  text('chart-state', points.length ? live ? 'Live observations' : 'Recent observations · not live' : 'Observed samples only');
  node('signal').dataset.live = String(live);
  node('signal').setAttribute('aria-label', points.length ? `${tracePhase} throughput over 90 seconds. ${points.length} observations. Latest ${rate(points.at(-1)?.rate)}. Gaps are not zero.` : 'No observed throughput in the last 90 seconds.');
};

const renderProgress = (current: AvailableTelemetry | null, held: false | 'paused' | 'refreshing' = false): void => {
  const progress = prefillReading(current);
  hidden('prefill-progress', progress === null);
  if (!progress) return;
  text('prefill-remaining', progress.remaining);
  text('prefill-completed', progress.completed);
  text('prefill-state', held ? held === 'paused' ? 'Paused · last reading' : 'Refreshing · last reading' : progress.stale ? 'Waiting for progress' : progress.percent === null ? 'Not reported' : 'Live reading');
  node('prefill-progress').dataset.held = String(Boolean(held) || progress.stale);
  if (progress.percent === null) {
    node('prefill-track').removeAttribute('aria-valuenow');
    node('prefill-track').setAttribute('aria-valuetext', 'Progress not reported');
  } else {
    node('prefill-track').setAttribute('aria-valuenow', String(Math.floor(progress.percent)));
    node('prefill-track').setAttribute('aria-valuetext', `${progress.remaining}; ${progress.completed}${held || progress.stale ? '; last reading, not live' : ''}`);
  }
  (node('prefill-track').firstElementChild as HTMLElement).style.width = `${progress.percent ?? 0}%`;
  text('prefill-counts', progress.counts ? `${progress.counts.done.toLocaleString()} / ${progress.counts.total.toLocaleString()} tokens processed · ${progress.counts.remaining.toLocaleString()} left` : 'Percent of the current prefill stage, not time remaining.');
};

const clearObservations = (): void => {
  last = null; lastSystem = null; monitoredConnection = null;
  signal = new SignalHistory(); resources = new ResourceHistory();
  insightView.clear(); captureView.capture.clear(); captureView.suspend();
  drawSignal(Date.now(), false, 'unknown');
  document.getElementById('cpu-history')!.setAttribute('d', '');
  document.getElementById('ram-history')!.setAttribute('d', '');
};

const update = (snapshot: TelemetrySnapshot): void => {
  if (snapshot.connection) {
    const identity = JSON.stringify([snapshot.connection.selected, snapshot.connection.runtime, snapshot.connection.generation ?? null]);
    if (monitoredConnection !== null && identity !== monitoredConnection) clearObservations();
    monitoredConnection = identity;
  }
  latest = snapshot;
  connections.update(snapshot.connection);
  (node('save-snapshot') as HTMLButtonElement).disabled = !snapshot.available && !snapshot.system;
  const current = snapshot.available ? snapshot : null;
  if (current) last = current;
  const phase = current?.phase ?? (last ? 'reconnecting' : snapshot.reason === 'authentication_failed' ? 'offline' : 'connecting');
  const display = current ?? last;
  const stale = current === null;
  const runtime = snapshot.runtime ?? snapshot.connection?.runtime ?? connections.selection.runtime ?? last?.runtime;
  const connectionInfo = snapshot.connection ?? last?.connection ?? null;
  const runtimeName = connectionName(runtime, connectionInfo);
  const splashEngine = connectionInfo?.engine === 'splash';
  const coverage = current ? snapshot.connection?.coverage ?? (runtime === 'omlx' ? 'requests' : 'server') : last?.connection?.coverage ?? 'requests';
  shell.dataset.coverage = coverage;
  shell.dataset.runtime = runtime ?? '';
  shell.dataset.engine = splashEngine ? 'splash' : '';
  text('activity-label', coverage === 'requests' ? 'MODEL ACTIVITY' : 'LOCAL RUNTIME');
  node('instrument').setAttribute('aria-label', coverage === 'requests' ? 'Inference activity' : 'Runtime inventory and coverage');
  shell.dataset.empty = String(stale && last === null);
  hidden('instrument', stale && last === null);
  hidden('connection-diagnosis', !stale);
  text('connection-message', stale ? snapshot.message ?? 'Choose an existing local OpenCode connection, then refresh. Connection help can check the extension service.' : '');
  // One quiet line for runtimes that list models but do not stream request activity; Splash says nothing here.
  hidden('coverage-note', !current || coverage === 'requests' || runtime === 'splash');
  text('coverage-note', coverage === 'inventory'
    ? `${runtimeName} lists its models here. Live request activity appears when its local log stream is available.`
    : `${runtimeName} is reachable. It does not report live request progress.`);
  text('process-label', runtime === 'splash' ? 'Now' : `${runtimeName} process footprint`);
  text('model-label', runtime === 'splash' ? 'Peak' : 'Model allocation');
  text('runtime-memory-title', runtime === 'splash' ? 'GPU memory (Metal)' : 'Runtime memory');
  text('runtime-memory-note', runtime === 'splash'
    ? 'As reported by Splash. Not the same as process memory.'
    : 'Reported totals can overlap; they are not per-chat memory.');
  text('estimate-source', `${runtimeName} estimate · may change`);
  insightView.update(snapshot);
  const observedRate = current?.phase === 'decode' && current.liveDecodeTPS === null ? insightView.history.speed : null;
  const liveRate = current?.phase === 'decode' ? current.liveDecodeTPS ?? observedRate?.tokensPerSecond ?? null : current?.phase === 'prefill' ? current.livePrefillTPS : null;
  hidden('recent-speed', current?.phase !== 'decode' || current.liveDecodeTPS === null && observedRate !== null);
  shell.dataset.phase = phase;
  shell.dataset.stale = String(stale);
  const splashLoading = runtime === 'splash' && display?.serverStats?.ready === false;
  text('connection', current ? `${runtimeName}${splashLoading ? ' · loading model' : ' connected'}${current.phase === 'notLoaded' ? ' · no model loaded' : ''}` : snapshot.reason === 'authentication_failed' ? 'Authentication required' : `Waiting for ${runtimeName}`);
  text('phase', current && runtime === 'splash' ? splashLoading ? 'Loading' : current.phase === 'processing' ? 'Generating' : current.phase === 'idle' ? 'Idle' : 'Ready'
    : current && coverage !== 'requests' ? 'Connected' : phases[phase]);
  text('model', runtime === 'splash' ? display?.modelID?.split('/').at(-1) ?? 'Splash server'
    : current && coverage !== 'requests' ? runtimeName : display?.modelID?.split('/').at(-1) ?? 'Your local model');
  node('model').title = display?.modelID ?? `Observing ${runtimeName} on the OpenChamber host.`;
  const splashDetail = runtime === 'splash' && display?.contextWindow != null ? `${display.contextWindow.toLocaleString()}-token context` : '';
  hidden('splash-model-detail', !splashDetail);
  text('splash-model-detail', splashDetail);
  const splashRate = runtime === 'splash' && display?.serverStats?.ready === true
    ? display.serverStats.aggregateDecodeTokensPerSecond : null;
  const logActivity = runtime === 'lmstudio' && coverage === 'requests' && current !== null;
  const lastRequest = logActivity ? current.lastRequest ?? null : null;
  const lastRate = lastRequest?.tokensPerSecond ?? null;
  const logRate = logActivity && liveRate === null && phase !== 'decode' && phase !== 'prefill' ? lastRate : null;
  text('rate', runtime === 'splash' ? splashLoading ? 'Loading' : splashRate !== null ? rateNumber.format(splashRate) : stale ? '—' : 'Ready'
    : liveRate !== null ? rateNumber.format(liveRate) : logRate !== null ? rateNumber.format(logRate)
      : logActivity && phase === 'decode' ? 'Generating' : logActivity && phase === 'prefill' ? 'Reading'
        : phase === 'idle' ? 'Ready' : phase === 'notLoaded' ? 'Standby' : '—');
  node('rate').classList.toggle('is-word', runtime === 'splash' ? splashRate === null : liveRate === null && logRate === null);
  text('unit', runtime === 'splash' ? splashLoading ? 'Splash is loading the model'
    : stale ? splashRate !== null ? 'tok/s · last reading, not live' : 'Waiting for Splash'
      : splashRate === null ? 'Speed appears after the first request' : 'tok/s · server decode, all requests'
    : liveRate !== null ? observedRate ? 'tokens / second · recent output' : phase === 'prefill' ? 'prefill tokens / second' : 'tokens / second · request average'
      : logActivity && phase === 'decode' ? `Exact speed when it finishes${lastRate !== null ? ` · last ${rateNumber.format(lastRate)} tok/s` : ''}`
        : logActivity && phase === 'prefill' ? 'Reading the prompt'
          : logRate !== null ? `tok/s · last response (exact)${lastRequest ? ` · ${finishedAgo(lastRequest.finishedAt)}` : ''}`
            : phase === 'idle' ? 'Waiting for your next request' : phase === 'notLoaded' ? `Load a model in ${runtimeName}` : 'No fresh throughput');
  text('activity', stale ? snapshot.message ?? `Start ${runtimeName} on this host, then refresh.` : current.message ?? (phase === 'idle' ? 'Model loaded. Ready for your next request.' : phase === 'notLoaded' ? `${runtimeName} is running. Load a model to begin.` : `${count(current.activeRequests)} active · ${current.queuedRequests === null ? 'queue not reported' : current.queuedRequests ? `${current.queuedRequests} queued` : 'queue clear'}`));
  text('notice', stale && last ? `${age(last.sampledAt)}. Retained details are not live.` : '');
  hidden('notice', !stale || last === null);
  renderProgress(current);
  captureView.update(snapshot);
  const hasOutput = current !== null && ['decode', 'processing'].includes(current.phase) && current.completionTokens !== null;
  hidden('request-output', !hasOutput);
  text('request-output', hasOutput ? `${current.completionTokens!.toLocaleString()} output tokens${current.elapsedSeconds !== null ? ` · ${number.format(current.elapsedSeconds)}s elapsed` : ''}` : '');
  const budget = contextBudget(snapshot);
  hidden('context-headroom', budget === null);
  text('context-remaining', budget ? `${count(budget.remaining)} tokens to model limit` : '—');
  text('context-accounted', budget ? `${percent(budget.percent)} accounted · prompt + output` : 'Not reported');
  meter('context-used-bar', budget ? budget.percent : null);
  // Runtimes without live token counts fall back to the last finished response's exact figures.
  const tokenSource = current?.promptTokens != null ? { prompt: current.promptTokens, cached: current.cachedTokens, basis: '' }
    : lastRequest?.promptTokens != null ? { prompt: lastRequest.promptTokens, cached: lastRequest.cachedTokens, basis: ' · last response' } : null;
  const modelContext = current?.contextWindow ?? current?.catalog?.find(model => model.loaded && model.name === display?.modelID)?.contextWindow
    ?? current?.catalog?.find(model => model.loaded)?.contextWindow ?? null;
  const contextPercent = ratio(tokenSource?.prompt, modelContext);
  const reusedPercent = ratio(tokenSource?.cached, tokenSource?.prompt);
  node('context').parentElement!.hidden = contextPercent === null && !(current?.promptTokens == null && coverage === 'requests' && runtime === 'omlx');
  node('reuse').parentElement!.hidden = reusedPercent === null && !(current?.cachedTokens == null && coverage === 'requests' && runtime === 'omlx');
  text('context', percent(contextPercent)); text('context-detail', tokenSource === null ? 'Not reported' : `${count(tokenSource.prompt)} / ${count(modelContext)}${tokenSource.basis}`);
  text('reuse', percent(reusedPercent)); text('reuse-detail', tokenSource?.cached == null ? 'Not reported' : `${count(tokenSource.cached)} tokens${tokenSource.basis}`);
  meter('context-bar', contextPercent); meter('reuse-bar', reusedPercent);
  text('requests', count(current?.activeRequests)); text('queue', current ? current.queuedRequests === null ? current.activeRequests ? 'running now' : 'none running' : current.queuedRequests ? `${current.queuedRequests} queued` : 'Queue clear' : 'No live reading');
  text('session-title', runtime === 'splash' ? 'Requests' : logActivity ? 'Finished responses' : 'Server session');
  text('stats-label-one', runtime === 'splash' ? 'Server decode' : 'Decode average');
  text('stats-label-two', runtime === 'splash' ? 'Completed' : logActivity ? 'Last first token' : 'Prefill average');
  text('stats-label-three', runtime === 'splash' ? 'Failed' : logActivity ? 'Input reused' : 'Cache efficiency');
  node('average-cache').dataset.warn = String(runtime === 'splash' && (display?.serverStats?.failedRequests ?? 0) > 0);
  // Without live token counts there is nothing to chart, so hide the empty chart.
  const liveCounts = current?.liveDecodeTPS != null || current?.livePrefillTPS != null || current?.completionTokens != null;
  hidden('signal', logActivity && !liveCounts);
  if (logActivity && !liveCounts) hidden('recent-speed', true);
  // The heading and phase already say "Generating" on this model; only concurrent-request notes add information.
  // The Requests stat already shows the active and queued counts; only runtime messages and idle guidance add information here.
  const genericActivity = current !== null && !current.message && !['idle', 'notLoaded'].includes(phase);
  hidden('activity', logActivity && phase === 'decode' && (current?.activeRequests ?? 0) <= 1 || splashLoading || genericActivity);
  if (splashEngine && runtime === 'lmstudio' && phase === 'notLoaded') {
    text('model', 'No model loaded');
    text('activity', 'Load a Splash model in Bionic to start. Activity appears here as soon as it serves a request.');
  }
  text('average-decode', rate(runtime === 'splash' ? display?.serverStats?.aggregateDecodeTokensPerSecond ?? null : display?.sessionAverageDecodeTPS));
  text('average-prefill', runtime === 'splash' ? count(display?.serverStats?.completedRequests)
    : logActivity ? lastRequest?.ttftSeconds == null ? '—' : `${number.format(lastRequest.ttftSeconds)}s` : rate(display?.sessionAveragePrefillTPS));
  text('average-cache', runtime === 'splash' ? count(display?.serverStats?.failedRequests) : percent(display?.sessionCacheEfficiencyPercent));
  const statsState = stale ? 'stale' : current?.sessionStatsState ?? 'unavailable';
  node('session-stats').dataset.stale = String(runtime === 'splash' ? stale : statsState !== 'fresh');
  text('session-stats-state', runtime === 'splash'
    ? stale ? 'Last reading · not live' : 'Server decode is shared across all requests.'
    : statsState === 'fresh' ? logActivity ? 'Exact figures for responses that finished while MLX Scope was open' : 'Completed requests across all models' : statsState === 'stale' ? 'Last available totals · not live' : logActivity ? 'Figures appear after the first response finishes' : 'Session statistics unavailable');
  const uptime = display?.lifetime?.uptimeSeconds;
  text('uptime', runtime === 'splash' ? 'Since Splash started' : logActivity ? 'This session' : uptime == null ? 'Since start / reset' : `${Math.floor(uptime / 3600)}h ${Math.floor(uptime % 3600 / 60)}m · since start`);
  // "More runtime details" only lists oMLX-style internals; hide it when none are reported.
  hidden('runtime-details', display?.sessionBank == null && display?.memoryPressureLevel == null && current?.completionTokens == null);
  text('process-memory', gb(runtime === 'splash' ? display?.serverStats?.metalCurrentGB : display?.memory?.activeGB));
  text('model-memory', gb(runtime === 'splash' ? display?.serverStats?.metalPeakGB : display?.memory?.modelGB));
  text('ssd-cache', gb(display?.sessionBank?.cold?.totalGB));
  const hasRuntimeMemory = runtime === 'splash'
    ? display?.serverStats?.metalCurrentGB != null || display?.serverStats?.metalPeakGB != null
    : display?.memory?.activeGB != null || display?.memory?.modelGB != null;
  hidden('runtime-memory', !hasRuntimeMemory);
  node('runtime-memory').dataset.stale = String(stale);
  text('runtime-memory-source', stale ? 'Last reading · not live' : `${runtimeName} · server-wide`);
  text('pressure', display?.memoryPressureLevel == null ? 'Not reported' : ['Not reported', 'Normal', 'Elevated', 'Critical'][Math.min(3, display.memoryPressureLevel)] ?? 'Not reported');
  text('output', count(current?.completionTokens)); text('elapsed', current?.elapsedSeconds == null ? '—' : `${number.format(current.elapsedSeconds)}s`); text('cache-lookup', display?.sessionBank?.lastMissReason?.replaceAll('_', ' ') ?? 'Not reported');
  text('freshness', display ? age(display.sampledAt) : 'No sample yet');
  if (snapshot.system) lastSystem = snapshot.system;
  const system = snapshot.system ?? lastSystem;
  hidden('machine', system === null);
  node('machine').dataset.stale = String(snapshot.system === null);
  if (system) {
    text('machine-title', system.platform === 'macOS' ? 'macOS host' : `${system.platform} resources`);
    text('hardware', [system.cpuModel, system.logicalCores ? `${system.logicalCores} logical cores` : null].filter(Boolean).join(' · '));
    text('machine-freshness', snapshot.system ? age(system.sampledAt) : 'Last reading · not live');
    text('cpu', percent(snapshot.system?.cpuPercent)); meter('cpu-bar', snapshot.system?.cpuPercent ?? null);
    text('ram', `${system.memoryUsedGB == null ? '—' : number.format(toGiB(system.memoryUsedGB))} / ${gb(system.memoryTotalGB)}`);
    meter('ram-bar', ratio(system.memoryUsedGB, system.memoryTotalGB));
    hidden('mac-memory', system.platform !== 'macOS');
    const native = system.macOS;
    const nativeFresh = snapshot.system !== null && native !== null && Date.now() - native.sampledAt <= 20_000;
    text('wired', gb(nativeFresh ? native.wiredGB : null)); text('compressed', gb(nativeFresh ? native.compressedGB : null)); text('swap', gb(nativeFresh ? native.swapUsedGB : null));
    text('native-freshness', native ? `${age(native.sampledAt)} · native readings up to every 10s` : 'Native diagnostics unavailable on this host');
  }
  resources.observe(snapshot.system);
  if (!compactView && activeView === 'live') {
    document.getElementById('cpu-history')!.setAttribute('d', resources.paths('cpu', Date.now()));
    document.getElementById('ram-history')!.setAttribute('d', resources.paths('memory', Date.now()));
  }
  text('resource-state', snapshot.system ? 'Whole-host observations' : 'Recent observations · not live');
  signal.observe(snapshot, efficient ? 3_000 : 500, observedRate?.tokensPerSecond ?? null);
  if (!compactView && activeView === 'live') drawSignal(Date.now(), liveRate !== null && !stale, phase);
};

const poller = new Poller(async () => {
  const generation = monitorGeneration;
  try {
    const response = await host.serviceRequest({ method: 'GET', path: '/snapshot', query: connections.query() });
    const parsed = response.status === 200 ? parseTelemetrySnapshot(JSON.parse(response.body)) : unavailableForServiceResponse(response.status);
    if (!disposed && generation === monitorGeneration && !userPaused && !document.hidden && activeView !== 'saved') { failures = parsed.available ? 0 : failures + 1; awaitingFresh = false; update(parsed); armFreshness(); }
  } catch (error) {
    if (!disposed && generation === monitorGeneration && !userPaused && !document.hidden && activeView !== 'saved') { failures += 1; awaitingFresh = false; update(unavailableForHostError(error)); }
  } finally {
    if (manualRefresh) { button.disabled = userPaused; button.removeAttribute('aria-busy'); manualRefresh = false; }
  }
  // Keep host readings useful when the runtime is offline; the client has its own retry budget.
  const delay = latest.system ? Math.min(2_000, nextDelay(last, failures)) : nextDelay(last, failures);
  return efficient ? Math.max(3_000, delay) : delay;
});

const clearFreshness = (): void => { if (freshnessTimer !== null) clearTimeout(freshnessTimer); freshnessTimer = null; };
const holdRuntimeMemory = (label: string): void => {
  text('runtime-memory-source', label);
  node('runtime-memory').dataset.stale = 'true';
};
const holdSplashStatistics = (label: string): void => {
  if ((last?.runtime ?? latest.runtime) !== 'splash') return;
  node('session-stats').dataset.stale = 'true';
  text('session-stats-state', label);
};
const armFreshness = (): void => {
  clearFreshness();
  if (disposed || userPaused || document.hidden || activeView === 'saved') return;
  // One deadline, not an animation loop. Stalled SDK requests cannot leave a live rate on screen.
  freshnessTimer = setTimeout(() => {
    freshnessTimer = null;
    update(unavailableTelemetry('runtime_unreachable', 'No fresh observations. Retained readings are not live.'));
  }, efficient ? 10_000 : 6_000);
};
const syncMonitoring = (): void => {
  monitorGeneration += 1;
  poller.setPaused(userPaused || document.hidden || activeView === 'saved');
  if (userPaused || document.hidden || activeView === 'saved') {
    interrupted = true; awaitingFresh = true;
    holdRuntimeMemory(userPaused ? 'Frozen reading' : 'Last reading · not live');
    holdSplashStatistics(userPaused ? 'Paused · last reading' : 'Last reading · not live');
    clearFreshness(); resources.break(); signal.break(); insightView.suspend(); captureView.suspend();
  } else {
    if (interrupted) {
      interrupted = false;
      holdRuntimeMemory('Last reading · refreshing');
      holdSplashStatistics('Last reading · refreshing');
      text('rate', '—'); text('unit', 'Waiting for a fresh reading');
      text('phase', 'Refreshing'); text('connection', 'Resuming monitoring');
      shell.dataset.stale = 'true';
      node('machine').dataset.stale = 'true';
      text('machine-freshness', 'Last reading · refreshing');
      text('resource-state', 'Last readings · refreshing');
      hidden('request-output', true);
      renderProgress(latest.available ? latest : null, 'refreshing');
      insightView.suspend(); captureView.suspend();
      drawSignal(Date.now(), false, latest.phase);
    }
    armFreshness();
  }
};
pauseButton.addEventListener('click', () => {
  userPaused = !userPaused;
  shell.dataset.paused = String(userPaused);
  pauseButton.setAttribute('aria-pressed', String(userPaused));
  pauseButton.title = userPaused ? 'Resume monitoring' : 'Pause this monitor, not inference';
  text('pause-label', userPaused ? 'Resume' : 'Pause');
  document.getElementById('pause-symbol')!.setAttribute('d', userPaused ? 'M7 4l8 6-8 6z' : 'M7 5v10M13 5v10');
  button.disabled = !mounted || userPaused || manualRefresh;
  text('connection', userPaused ? 'Monitoring paused' : 'Resuming monitoring');
  text('phase', userPaused ? 'Paused' : 'Refreshing');
  text('unit', userPaused ? 'Frozen observation' : 'Waiting for a fresh observation');
  if (!userPaused) text('rate', '—');
  text('notice', userPaused ? 'Only this monitor is paused. Your model keeps running; these readings are frozen.' : 'Resuming live observations…');
  hidden('notice', false);
  text('chart-end', userPaused ? 'paused' : 'now');
  text('resource-state', userPaused ? 'Frozen observations' : 'Waiting for fresh observations');
  text('machine-freshness', userPaused ? 'Frozen reading' : 'Refreshing');
  text('freshness', userPaused ? 'Monitoring paused' : 'Refreshing');
  drawSignal(Date.now(), false, latest.phase);
  renderProgress(latest.available ? latest : null, userPaused ? 'paused' : 'refreshing');
  syncMonitoring();
});

let statusTimer: ReturnType<typeof setTimeout> | null = null;
const actionStatus = (message: string): void => {
  if (statusTimer !== null) clearTimeout(statusTimer);
  text('action-status', message); hidden('action-status', !message);
  statusTimer = message ? setTimeout(() => { hidden('action-status', true); statusTimer = null; }, 8_000) : null;
};
const captureView = new CaptureView(shell, text => host.writeClipboard(text), actionStatus, version);
const savedView = new SavedView(shell, host, actionStatus);
const connections = new ConnectionsView(shell, host.storage, () => {
  if (disposed) return;
  poller.stop(); clearFreshness(); monitorGeneration += 1;
  clearObservations(); failures = 0;
  awaitingFresh = true; interrupted = true;
  update(unavailableTelemetry('runtime_unreachable', 'Waiting for the selected connection. Existing observations were cleared.'));
  syncMonitoring();
  if (userPaused) { text('connection', 'Monitoring paused'); text('phase', 'Paused'); }
  if (activeView === 'saved') { text('connection', 'Viewing saved observations'); text('cadence', 'Monitoring suspended'); }
  if (mounted) poller.start();
}, actionStatus);
node('save-snapshot').addEventListener('click', () => {
  if (awaitingFresh && !userPaused) { actionStatus('Wait for a fresh observation before saving.'); return; }
  void savedView.save(snapshotObservation(latest, userPaused || (latest.available && latest.prefillProgressStale), userPaused ? null : insightView.history.speed?.tokensPerSecond ?? null));
});
const saveCapture = document.createElement('button'); saveCapture.id = 'capture-save'; saveCapture.type = 'button'; saveCapture.textContent = 'Save observation'; saveCapture.title = 'Keep the 12 newest observations; the oldest is replaced when full';
node('capture-copy').after(saveCapture);
saveCapture.addEventListener('click', () => {
  const capture = captureView.capture;
  if (!capture.current || capture.recording) { actionStatus('Finish or stop the capture before saving.'); return; }
  void savedView.save(captureObservation(capture.current, capture.baseline));
});
new WorkspaceTabs(shell, view => {
  activeView = view; shell.dataset.workspace = view;
  node('share-actions').hidden = view === 'saved';
  node('compact').hidden = view !== 'live'; node('save-snapshot').hidden = view !== 'live' && view !== 'server';
  if (view === 'saved') {
    text('connection', 'Viewing saved observations'); text('cadence', 'Monitoring suspended');
    button.disabled = true; void savedView.load();
  } else {
    button.disabled = userPaused || !mounted;
    text('cadence', efficient ? 'Energy saving · 3s+' : 'Adaptive updates');
  }
  syncMonitoring();
  if (view !== 'saved' && !awaitingFresh && !userPaused) update(latest);
});
// The ⋯ menu closes after an action, on Escape, and on an outside click. Share keeps it open for its own submenu.
const monitorMenu = node('monitor-menu') as HTMLDetailsElement;
monitorMenu.addEventListener('click', event => {
  const target = (event.target as HTMLElement).closest('button');
  if (target && target.closest('.monitor-menu-content') && (!target.closest('#share-actions') || target.closest('[role="menuitem"]'))) {
    // Closing hides the focused item; keep keyboard focus on the ⋯ button instead of losing it.
    const hadFocus = monitorMenu.contains(document.activeElement);
    monitorMenu.open = false;
    if (hadFocus) monitorMenu.querySelector('summary')?.focus({preventScroll:true});
  }
});
monitorMenu.addEventListener('keydown', event => { if (event.key === 'Escape' && monitorMenu.open) { monitorMenu.open = false; monitorMenu.querySelector('summary')?.focus(); } });
document.addEventListener('pointerdown', event => { if (monitorMenu.open && !monitorMenu.contains(event.target as Node)) monitorMenu.open = false; }, true);
const sharing = new SharingControls(node('share-actions'), host, () => [measurementReport(latest, lastSystem, userPaused ? true : awaitingFresh ? 'refreshing' : false, version), captureView.report()].filter(Boolean).join('\n\n'), actionStatus);
const applyPreference = (key: PreferenceKey, value: boolean): void => {
  if (disposed) return;
  if (key === 'efficient') {
    efficient = value; shell.dataset.efficient = String(value);
    node('efficiency').setAttribute('aria-pressed', String(value));
    text('cadence', value ? 'Energy saving · 3s+' : 'Adaptive updates');
    signal.break(); armFreshness();
  } else {
    compactView = value; shell.dataset.compact = String(value);
    node('compact').setAttribute('aria-pressed', String(value));
    if (!value && !userPaused) {
      if (awaitingFresh) drawSignal(Date.now(), false, latest.phase);
      else update(latest);
    }
  }
};
const savePreference = (key: PreferenceKey, value: boolean): void => {
  applyPreference(key, value);
  actionStatus('');
  void preferences.set(key, value).catch(() => {
    if (!disposed) actionStatus('View changed here, but this host could not save the preference.');
  });
};
node('efficiency').addEventListener('click', () => savePreference('efficient', !efficient));
node('compact').addEventListener('click', () => savePreference('compact', !compactView));
node('clear-recent').addEventListener('click', () => { insightView.clear(); actionStatus('Observation history cleared here. Runtime statistics were not changed.'); });
node('copy-recent').addEventListener('click', async () => {
  try {
    await host.writeClipboard(insightView.report(version));
    if (!disposed) actionStatus('Recent observations copied without model names or request data.');
  } catch { if (!disposed) actionStatus('Could not copy observations. The clipboard was not confirmed.'); }
});

button.addEventListener('click', () => {
  if (!mounted || disposed || userPaused || document.hidden || activeView === 'saved') return;
  manualRefresh = true;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  void poller.refresh();
});
const readyDeadline = setTimeout(() => {
  if (mounted || disposed || startupFailed) return;
  text('connection', 'Waiting for OpenChamber');
  text('activity', 'Open this monitor from the extension panel in OpenChamber.');
  text('notice', 'If it is already open there, reload the extension in Settings → Extensions.');
  hidden('notice', false);
  startupFallback.remove();
  shell.hidden = false;
}, 6_000);
host.onReady((ready) => {
  clearTimeout(readyDeadline);
  applyHostReady(ready, document.documentElement);
  document.documentElement.style.colorScheme = ready.theme.mode;
  shell.dataset.surface = ready.surface;
  if (mounted) return;
  void preferences.load(applyPreference);
  void connections.load();
  syncMonitoring();
  button.disabled = userPaused;
  poller.start();
  mounted = true;
  startupFallback.remove();
  shell.hidden = false;
});
document.addEventListener('visibilitychange', syncMonitoring);
window.addEventListener('pagehide', (event) => {
  poller.stop(); clearFreshness(); resources.break(); signal.break();
  insightView.suspend(); captureView.suspend(); monitorGeneration += 1;
  interrupted = true; awaitingFresh = true;
  if (!event.persisted) {
    disposed = true; clearTimeout(readyDeadline);
    sharing.dispose(); inspector.dispose(); connectionHelp.dispose();
    if (statusTimer !== null) clearTimeout(statusTimer);
    host.dispose();
  }
});
window.addEventListener('pageshow', (event) => { if (event.persisted && mounted) { syncMonitoring(); poller.start(); } });

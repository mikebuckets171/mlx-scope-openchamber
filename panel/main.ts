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
import { SavedView, savedMarkup } from './saved-view.ts';
import { snapshotObservation, captureObservation } from './saved.ts';
import { WorkspaceTabs, type Workspace } from './workspace.ts';
import { version } from '../package.json';

const host = connectHost();
const root = document.querySelector<HTMLElement>('#root');
if (!root) throw new Error('MLX Scope is missing its root element.');

// This static shell is mounted once. Polls patch text/geometry, never controls.
root.innerHTML = `
<main class="scope" aria-labelledby="scope-title">
  <header class="masthead">
    <div class="brand"><svg class="scope-mark" viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="14" r="11"/><path d="M3 14h6l3-5 4 10 3-5h6"/></svg><h1 id="scope-title">MLX <span>Scope</span></h1></div>
    <div class="monitor-controls"><button id="efficiency" type="button" aria-label="Energy-saving updates" aria-pressed="false" title="Energy-saving updates: reduce monitoring refresh frequency"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16 3c-8-1-13 3-10 9s10 1 10-9ZM4 16l8-8"/></svg></button><button id="pause" type="button" aria-pressed="false" title="Pause this monitor, not inference"><svg viewBox="0 0 20 20" aria-hidden="true"><path id="pause-symbol" d="M7 5v10M13 5v10"/></svg><span id="pause-label">Pause</span></button><button id="refresh" type="button" title="Refresh readings" aria-label="Refresh readings" disabled><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16 7a6 6 0 1 0 .1 5M16 3v4h-4"/></svg></button></div>
  </header>
  <div class="connection"><span class="connection-dot" aria-hidden="true"></span><span id="connection" role="status">Connecting to oMLX</span><span class="local-tag">Local · read-only</span></div>
  <div class="view-tools" aria-label="Monitor view options"><button id="compact" type="button" aria-pressed="false">Compact view</button><button id="save-snapshot" type="button" title="Keep the 12 newest observations; the oldest is replaced when full" disabled>Save snapshot</button><span id="cadence">Adaptive updates</span><div id="share-actions" class="share-actions" aria-label="Share readings"></div></div>
  <p id="action-status" class="action-status" role="status" hidden></p>
  <p id="notice" class="notice" role="status" hidden></p>
  <nav class="workspace-nav" aria-label="Scope workspaces"><div role="tablist" aria-label="Scope workspaces">
    <button id="tab-live" role="tab" type="button" data-view="live" aria-controls="view-live" aria-selected="true">Live</button>
    <button id="tab-compare" role="tab" type="button" data-view="compare" aria-controls="view-compare" aria-selected="false" tabindex="-1">Compare</button>
    <button id="tab-saved" role="tab" type="button" data-view="saved" aria-controls="view-saved" aria-selected="false" tabindex="-1">Saved</button>
  </div><span class="scope-boundary">Server-wide observations</span></nav>
  <div id="view-live" role="tabpanel" aria-labelledby="tab-live" tabindex="0"><div class="workspace">
  <section class="instrument" aria-label="Inference activity">
    <div class="model-line"><span class="eyebrow">MODEL ACTIVITY</span><span id="phase" class="phase">Connecting</span></div>
    <h2 id="model" translate="no">Your local model</h2>
    <section id="prefill-progress" class="prefill-progress" aria-label="Prefill progress" hidden>
      <div class="prefill-heading"><span>Prefill · current stage</span><span id="prefill-state">Live reading</span></div>
      <div class="prefill-values"><strong id="prefill-remaining">—</strong><span id="prefill-completed">—</span></div>
      <div id="prefill-track" class="progress-track" role="progressbar" aria-label="Prefill stage completed" aria-valuemin="0" aria-valuemax="100"><span></span></div>
      <p id="prefill-counts" class="prefill-counts"></p>
      <div id="prefill-estimate" class="prefill-estimate" hidden><span>Reported stage estimate</span><strong id="prefill-eta">—</strong><small>oMLX estimate · may change</small></div>
    </section>
    <div class="readout"><span id="rate" class="rate">—</span><span id="unit" class="unit">Waiting for readings</span></div>
    <p id="activity" class="activity">Connecting through OpenChamber.</p>
    <div id="recent-speed" class="recent-speed" hidden><strong id="window-speed">—</strong><span id="window-span">Recent generation speed</span></div>
    <p id="request-output" class="request-output" hidden></p>
    <div id="context-headroom" class="context-headroom" hidden title="Reported prompt plus output against the model context limit. This is not OpenCode's compaction threshold or reserved output budget."><span>MODEL CONTEXT</span><strong id="context-remaining">—</strong><small id="context-accounted">Not reported</small></div>
    <figure id="signal" class="signal" aria-label="No observed throughput yet">
      <div class="chart-top"><span id="chart-title">Request throughput</span><span id="ceiling">tok/s</span></div>
      <div id="history-inspector" class="plot" role="slider" tabindex="-1" aria-orientation="horizontal" aria-describedby="history-reading" aria-label="Inspect throughput history" aria-valuemin="0" aria-valuemax="0" aria-disabled="true"><svg viewBox="0 0 600 120" preserveAspectRatio="none" aria-hidden="true"><path class="grid" d="M4 4H596 M4 60H596 M4 116H596"/><g id="trace"></g><circle id="cursor" r="3" hidden/><line id="inspect-line" y1="4" y2="116" hidden/><circle id="inspect-dot" r="4" hidden/></svg><span id="chart-empty">The next request starts here.</span></div>
      <figcaption><span>−90s</span><span id="chart-state">Observed samples only</span><span id="chart-end">now</span></figcaption>
    <p id="history-reading" class="history-reading">History appears as readings arrive</p></figure>
    <div class="metrics" aria-label="Current request">
      <div><span class="metric-label" title="Input tokens as a share of the model context limit">Input context</span><strong id="context">—</strong><span id="context-detail" class="metric-detail">Not reported</span><div class="meter" aria-hidden="true"><i id="context-bar"></i></div></div>
      <div><span class="metric-label">Input reused</span><strong id="reuse">—</strong><span id="reuse-detail" class="metric-detail">Not reported</span><div class="meter" aria-hidden="true"><i id="reuse-bar"></i></div></div>
      <div><span class="metric-label">Requests</span><strong id="requests">—</strong><span id="queue" class="metric-detail">Waiting for oMLX</span></div>
    </div>
  </section>
  <aside class="side-stack" aria-label="Host resources and server statistics">
  <section id="machine" class="machine" aria-labelledby="machine-title" hidden>
    <div class="section-heading"><h2 id="machine-title">Host resources</h2><span id="machine-freshness">Waiting for a sample</span></div>
    <p id="hardware" class="hardware"></p>
    <div class="machine-values"><div><span>CPU</span><strong id="cpu">—</strong><div class="meter" aria-hidden="true"><i id="cpu-bar"></i></div></div><div title="Physical memory minus OS-reported free memory. Includes reclaimable pages; not Activity Monitor’s Memory Used or memory pressure."><span>Non-free RAM</span><strong id="ram">—</strong><div class="meter" aria-hidden="true"><i id="ram-bar"></i></div></div></div>
    <figure class="resource-trace" role="img" aria-label="CPU and non-free memory over the last 90 seconds, on a fixed zero to 100 percent scale">
      <div class="chart-top"><span><i class="legend-cpu"></i>CPU <i class="legend-ram"></i>RAM</span><span>0–100%</span></div>
      <svg viewBox="0 0 300 60" preserveAspectRatio="none" aria-hidden="true"><path class="grid" d="M2 2H298 M2 30H298 M2 58H298"/><path id="cpu-history"/><path id="ram-history"/></svg>
      <figcaption><span>−90s</span><span id="resource-state">Whole-host observations</span></figcaption>
    </figure>
    <div id="mac-memory" class="mac-memory" hidden>
      <dl class="native-values"><div><dt>Wired</dt><dd id="wired">—</dd></div><div><dt>Compressed</dt><dd id="compressed">—</dd></div><div><dt>Swap used</dt><dd id="swap">—</dd></div></dl>
      <p id="native-freshness" class="native-note">Native readings · every 10s</p>
    </div>
    <p class="machine-explanation">Whole host, not oMLX alone. Non-free RAM includes reclaimable pages; it is not Activity Monitor’s Memory Used.</p>
  </section>
  <section id="cache-lens" class="insight-section" aria-labelledby="cache-title">
    <div class="section-heading"><h2 id="cache-title">Cache &amp; input</h2><span>Current request</span></div>
    <p id="cache-request-state" class="insight-note">Waiting for cache readings</p>
    <div class="cache-input-values"><div><span>Reused tokens</span><strong id="cache-reuse-count">—</strong></div><div><span>Not reused</span><strong id="cache-new-count">—</strong></div></div>
    <div id="cache-input-bar" class="cache-input-bar" role="img" aria-label="Input cache reuse"><span id="cache-reused-fill"></span></div>
    <div class="cache-tier-values"><div><span>RAM cache</span><strong id="cache-ram-size">—</strong></div><div><span>SSD cache</span><strong id="cache-ssd-size">—</strong></div></div>
    <p id="cache-bank-state" class="insight-note">Server cache totals</p>
    <p class="insight-note">Unreused input is not necessarily the size of a prefill stage.</p>
  </section>
  <section id="resident-section" class="insight-section" aria-labelledby="resident-title" hidden>
    <div class="section-heading"><h2 id="resident-title">Loaded models</h2><span id="resident-count"></span></div>
    <ul id="resident-list" class="resident-list"></ul><p id="resident-note" class="insight-note"></p>
  </section>
  <p id="runtime-advisory" class="runtime-advisory" role="status" hidden></p>
  <section id="session-stats" class="session" aria-labelledby="session-title"><div class="section-heading"><h2 id="session-title">Server session</h2><span id="uptime">Since start / reset</span></div><div class="session-values"><div><span>Decode average</span><strong id="average-decode">—</strong></div><div><span>Prefill average</span><strong id="average-prefill">—</strong></div><div><span>Cache efficiency</span><strong id="average-cache">—</strong></div></div><p id="session-stats-state" class="native-note">Completed requests across all models</p></section>
  <details class="details"><summary>Runtime details<span aria-hidden="true">+</span></summary><dl>
    <div><dt>oMLX process footprint</dt><dd id="process-memory">—</dd></div>
    <div><dt>Model allocation</dt><dd id="model-memory">—</dd></div>
    <div><dt>Prefix cache · RAM</dt><dd id="cache-memory">—</dd></div>
    <div><dt>Prefix cache · SSD</dt><dd id="ssd-cache">—</dd></div>
    <div><dt>Runtime memory guard</dt><dd id="pressure">—</dd></div>
    <div><dt>Output tokens</dt><dd id="output">—</dd></div>
    <div><dt>Request elapsed</dt><dd id="elapsed">—</dd></div>
    <div><dt>Last cache lookup</dt><dd id="cache-lookup">—</dd></div>
  </dl><p class="explanation">Generation uses the reported request average when available. Otherwise, recent output speed is clearly labelled and measured from token counts. Prefill uses reported progress speed. Session averages cover completed work across models. Runtime memory guard is not macOS memory pressure. Memory uses GiB (1,024³ bytes). Compressed is physical compressor storage. Missing measurements stay unavailable.</p></details>
  </aside></div></div>
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
  <details class="connection-help" id="connection-help"><summary>Connection help<span aria-hidden="true">+</span></summary><p id="connection-result" role="status">Check whether OpenChamber has started the extension service. This does not change your configuration.</p><div class="insight-actions"><button id="check-connection" type="button">Check connection</button><button id="connection-guide" type="button">Setup guide</button></div></details>
  <footer><span>MLX Scope <span id="scope-version"></span></span><span id="freshness">Waiting for first sample</span></footer>
</main>`;

const nodes = new Map<string, HTMLElement>();
root.querySelectorAll<HTMLElement>('[id]').forEach((node) => nodes.set(node.id, node));
const node = (id: string): HTMLElement => nodes.get(id)!;
const text = (id: string, value: string): void => { const target = node(id); if (target.textContent !== value) target.textContent = value; };
const hidden = (id: string, value: boolean): void => { node(id).hidden = value; };
const meter = (id: string, value: number | null): void => { node(id).style.width = `${value === null ? 0 : Math.min(100, Math.max(0, value))}%`; };
const button = node('refresh') as HTMLButtonElement;
const shell = root.querySelector<HTMLElement>('.scope')!;
const signal = new SignalHistory();
const resources = new ResourceHistory();
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
let mounted = false;
let disposed = false;
let monitorGeneration = 0;
let manualRefresh = false;
let interrupted = false;
let awaitingFresh = false;
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const rateNumber = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const count = (value: number | null | undefined): string => value == null ? '—' : compact.format(value);
const rate = (value: number | null | undefined): string => value == null ? '—' : `${rateNumber.format(value)} tok/s`;
const gb = (value: number | null | undefined): string => value == null ? '—' : `${number.format(toGiB(value))} GiB`;
const ratio = (a: number | null | undefined, b: number | null | undefined): number | null => a == null || b == null || b <= 0 ? null : a / b * 100;
const percent = (value: number | null | undefined): string => value == null ? '—' : `${Math.round(value)}%`;
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

const update = (snapshot: TelemetrySnapshot): void => {
  latest = snapshot;
  (node('save-snapshot') as HTMLButtonElement).disabled = !snapshot.available && !snapshot.system;
  const current = snapshot.available ? snapshot : null;
  if (current) last = current;
  const phase = current?.phase ?? (last ? 'reconnecting' : snapshot.reason === 'authentication_failed' ? 'offline' : 'connecting');
  const display = current ?? last;
  const stale = current === null;
  insightView.update(snapshot);
  const observedRate = current?.phase === 'decode' && current.liveDecodeTPS === null ? insightView.history.speed : null;
  const liveRate = current?.phase === 'decode' ? current.liveDecodeTPS ?? observedRate?.tokensPerSecond ?? null : current?.phase === 'prefill' ? current.livePrefillTPS : null;
  hidden('recent-speed', current?.phase !== 'decode' || current.liveDecodeTPS === null && observedRate !== null);
  shell.dataset.phase = phase;
  shell.dataset.stale = String(stale);
  text('connection', current ? current.phase === 'notLoaded' ? 'oMLX connected · no model loaded' : 'oMLX connected' : snapshot.reason === 'authentication_failed' ? 'Authentication required' : 'Waiting for oMLX');
  text('phase', phases[phase]);
  text('model', display?.modelID?.split('/').at(-1) ?? 'Your local model');
  node('model').title = display?.modelID ?? 'Load a model in oMLX to begin monitoring.';
  text('rate', liveRate !== null ? rateNumber.format(liveRate) : phase === 'idle' ? 'Ready' : phase === 'notLoaded' ? 'Standby' : '—');
  node('rate').classList.toggle('is-word', liveRate === null);
  text('unit', liveRate !== null ? observedRate ? 'tokens / second · recent output' : phase === 'prefill' ? 'prefill tokens / second' : 'tokens / second · request average' : phase === 'idle' ? 'Waiting for your next request' : phase === 'notLoaded' ? 'Load a model in oMLX' : 'No fresh throughput');
  text('activity', stale ? snapshot.message ?? 'Start oMLX on this host, then refresh.' : current.message ?? (phase === 'idle' ? 'Model loaded. Ready for your next request.' : phase === 'notLoaded' ? 'oMLX is running. Load a model to begin.' : `${count(current.activeRequests)} active · ${current.queuedRequests === null ? 'queue not reported' : current.queuedRequests ? `${current.queuedRequests} queued` : 'queue clear'}`));
  text('notice', stale ? last ? `${age(last.sampledAt)}. Retained details are not live.` : 'Read-only connection · check your local oMLX endpoint and credential.' : '');
  hidden('notice', !stale);
  renderProgress(current);
  captureView.update(snapshot);
  const hasOutput = current !== null && ['decode', 'processing'].includes(current.phase) && current.completionTokens !== null;
  hidden('request-output', !hasOutput);
  text('request-output', hasOutput ? `${current.completionTokens!.toLocaleString()} output tokens${current.elapsedSeconds !== null ? ` · ${number.format(current.elapsedSeconds)}s elapsed` : ''}` : '');
  const budget = contextBudget(snapshot);
  hidden('context-headroom', budget === null);
  text('context-remaining', budget ? `${count(budget.remaining)} tokens to model limit` : '—');
  text('context-accounted', budget ? `${percent(budget.percent)} accounted · prompt + output` : 'Not reported');
  const contextPercent = ratio(current?.promptTokens, current?.contextWindow);
  const reusedPercent = ratio(current?.cachedTokens, current?.promptTokens);
  text('context', percent(contextPercent)); text('context-detail', current?.promptTokens == null ? 'Not reported' : `${count(current.promptTokens)} / ${count(current.contextWindow)}`);
  text('reuse', percent(reusedPercent)); text('reuse-detail', current?.cachedTokens == null ? 'Not reported' : `${count(current.cachedTokens)} tokens`);
  meter('context-bar', contextPercent); meter('reuse-bar', reusedPercent);
  text('requests', count(current?.activeRequests)); text('queue', current ? current.queuedRequests === null ? 'Queue not reported' : current.queuedRequests ? `${current.queuedRequests} queued` : 'Queue clear' : 'No live reading');
  text('average-decode', rate(display?.sessionAverageDecodeTPS)); text('average-prefill', rate(display?.sessionAveragePrefillTPS)); text('average-cache', percent(display?.sessionCacheEfficiencyPercent));
  const statsState = stale ? 'stale' : current?.sessionStatsState ?? 'unavailable';
  node('session-stats').dataset.stale = String(statsState !== 'fresh');
  text('session-stats-state', statsState === 'fresh' ? 'Completed requests across all models' : statsState === 'stale' ? 'Last available totals · not live' : 'Session statistics unavailable');
  const uptime = display?.lifetime?.uptimeSeconds;
  text('uptime', uptime == null ? 'Since start / reset' : `${Math.floor(uptime / 3600)}h ${Math.floor(uptime % 3600 / 60)}m · since start`);
  text('process-memory', gb(display?.memory?.activeGB)); text('model-memory', gb(display?.memory?.modelGB)); text('cache-memory', gb(display?.memory?.cacheGB)); text('ssd-cache', gb(display?.sessionBank?.cold?.totalGB));
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
    const response = await host.serviceRequest({ method: 'GET', path: '/snapshot' });
    const parsed = response.status === 200 ? parseTelemetrySnapshot(JSON.parse(response.body)) : unavailableForServiceResponse(response.status);
    failures = parsed.available ? 0 : failures + 1;
    if (!disposed && generation === monitorGeneration && !userPaused && !document.hidden && activeView !== 'saved') { awaitingFresh = false; update(parsed); armFreshness(); }
  } catch (error) {
    failures += 1;
    if (!disposed && generation === monitorGeneration && !userPaused && !document.hidden && activeView !== 'saved') { awaitingFresh = false; update(unavailableForHostError(error)); }
  } finally {
    if (manualRefresh) { button.disabled = userPaused; button.removeAttribute('aria-busy'); manualRefresh = false; }
  }
  // Keep host readings useful when oMLX is offline; the client has its own retry budget.
  const delay = latest.system ? Math.min(2_000, nextDelay(last, failures)) : nextDelay(last, failures);
  return efficient ? Math.max(3_000, delay) : delay;
});

const clearFreshness = (): void => { if (freshnessTimer !== null) clearTimeout(freshnessTimer); freshnessTimer = null; };
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
    clearFreshness(); resources.break(); signal.break(); insightView.suspend(); captureView.suspend();
  } else {
    if (interrupted) {
      interrupted = false;
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
  node('compact').hidden = view !== 'live'; node('save-snapshot').hidden = view !== 'live';
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
  if (mounted || disposed) return;
  text('connection', 'Waiting for OpenChamber');
  text('activity', 'Open this monitor from the extension panel in OpenChamber.');
  text('notice', 'If it is already open there, reload the extension in Settings → Extensions.');
  hidden('notice', false);
}, 6_000);
host.onReady((ready) => {
  clearTimeout(readyDeadline);
  applyHostReady(ready, document.documentElement);
  document.documentElement.style.colorScheme = ready.theme.mode;
  shell.dataset.surface = ready.surface;
  if (mounted) return;
  mounted = true;
  button.disabled = userPaused;
  void preferences.load(applyPreference);
  syncMonitoring();
  poller.start();
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

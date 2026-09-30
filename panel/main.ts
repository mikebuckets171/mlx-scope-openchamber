import { connectHost } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { version } from '../package.json';
import { CaptureView } from './capture-view.ts';
import { ChartInspector } from './chart-inspector.ts';
import { ConnectionHelp } from './connection-help.ts';
import { ConnectionsView } from './connections-view.ts';
import { frameId, SnapshotClient } from './data/client.ts';
import { Visibility } from './data/visibility.ts';
import { InsightView } from './insights-view.ts';
import { SharingControls } from './openchamber-view.ts';
import { Preferences, type PreferenceKey } from './preferences.ts';
import { CONNECTION_CLEARED } from './present/messages.ts';
import { frameReading } from './present/reading.ts';
import { measurementReport } from './report.ts';
import { Dom } from './render/dom.ts';
import { scopeMarkup } from './render/markup.ts';
import { Monitor } from './render/monitor.ts';
import { SavedView } from './saved-view.ts';
import { captureObservation, snapshotObservation } from './saved.ts';
import { ScopeState } from './state/scope-state.ts';
import { WorkspaceTabs } from './workspace.ts';

const root = document.querySelector<HTMLElement>('#root');
if (!root) throw new Error('MLX Scope is missing its root element.');
const startupFallback = root.querySelector<HTMLElement>('#startup-fallback');
const startupStatus = startupFallback?.querySelector<HTMLElement>('[role="status"]');
if (!startupFallback || !startupStatus) throw new Error('MLX Scope is missing its startup fallback.');
const state = new ScopeState(Date.now());
const showStartupFailure = (): void => {
  if (state.mounted) return;
  state.startupFailed = true;
  startupStatus.textContent = 'The extension interface could not start. Reload MLX Scope from OpenChamber’s Settings → Extensions.';
  if (startupFallback.parentElement !== root || root.childElementCount > 1) root.replaceChildren(startupFallback);
};
window.addEventListener('error', () => showStartupFailure(), true);
window.addEventListener('unhandledrejection', () => showStartupFailure());
const host = connectHost();

root.innerHTML = scopeMarkup;
root.prepend(startupFallback);
const dom = new Dom(root);
const text = (id: string, value: string): void => dom.text(id, value);
const hidden = (id: string, value: boolean): void => dom.hidden(id, value);
const button = dom.node('refresh') as HTMLButtonElement;
const shell = root.querySelector<HTMLElement>('.scope')!;
shell.hidden = true;
const inspector = new ChartInspector(dom.node('history-inspector'), dom.node('history-reading'));
const connectionHelp = new ConnectionHelp(shell, host, version);
text('scope-version', version);
const insightView = new InsightView(root);
const pauseButton = dom.node('pause') as HTMLButtonElement;
const preferences = new Preferences(host.storage);
const client = new SnapshotClient(host);
let visibility: Visibility;
const monitor = new Monitor({ dom, shell, state, client, frame: frameId(), visibility: () => visibility, inspector, insights: insightView,
  captures: () => captureView, connections: () => connections, refreshButton: button });
const { poller } = monitor;

pauseButton.addEventListener('click', () => {
  const paused = state.userPaused = !state.userPaused;
  shell.dataset.paused = String(paused);
  pauseButton.setAttribute('aria-pressed', String(paused));
  pauseButton.title = paused ? 'Resume monitoring' : 'Pause this monitor, not inference';
  text('pause-label', paused ? 'Resume' : 'Pause');
  dom.node('pause-symbol').setAttribute('d', paused ? 'M7 4l8 6-8 6z' : 'M7 5v10M13 5v10');
  button.disabled = !state.mounted || paused || state.manualRefresh;
  text('connection', paused ? 'Monitoring paused' : 'Resuming monitoring');
  text('phase', paused ? 'Paused' : 'Refreshing');
  text('unit', paused ? 'Frozen observation' : 'Waiting for a fresh observation');
  if (!paused) text('rate', '—');
  text('notice', paused ? 'Only this monitor is paused. Your model keeps running; these readings are frozen.' : 'Resuming live observations…');
  hidden('notice', false);
  text('chart-end', paused ? 'paused' : 'now');
  text('resource-state', paused ? 'Frozen observations' : 'Waiting for fresh observations');
  text('machine-freshness', paused ? 'Frozen reading' : 'Refreshing');
  text('freshness', paused ? 'Monitoring paused' : 'Refreshing');
  monitor.drawSignal();
  monitor.progress(paused ? 'paused' : 'refreshing');
  monitor.sync();
});

const actionStatus = (message: string): void => {
  if (state.statusTimer !== null) clearTimeout(state.statusTimer);
  text('action-status', message); hidden('action-status', !message);
  state.statusTimer = message ? setTimeout(() => { hidden('action-status', true); state.statusTimer = null; }, 8_000) : null;
};
const captureView = new CaptureView(shell, value => host.writeClipboard(value), actionStatus, version);
const savedView = new SavedView(shell, host, actionStatus);
const connections = new ConnectionsView(shell, host.storage, () => {
  if (state.disposed) return;
  poller.stop(); monitor.clearFreshness(); state.generation += 1;
  monitor.clearObservations(); state.failures = 0;
  state.awaitingFresh = true; state.interrupted = true;
  monitor.apply(frameReading('runtime_unreachable', CONNECTION_CLEARED, client.now()));
  monitor.sync();
  if (state.userPaused) { text('connection', 'Monitoring paused'); text('phase', 'Paused'); }
  if (state.mounted) poller.start();
}, actionStatus);
dom.node('save-snapshot').addEventListener('click', () => {
  if (state.awaitingFresh && !state.userPaused) { actionStatus('Wait for a fresh observation before saving.'); return; }
  const latest = state.latest;
  void savedView.save(snapshotObservation(latest, state.userPaused || latest.available && latest.request?.prefillStale === true,
    state.userPaused ? null : insightView.history.speed?.tokensPerSecond ?? null, client.now()));
});
const saveCapture = document.createElement('button'); saveCapture.id = 'capture-save'; saveCapture.type = 'button'; saveCapture.textContent = 'Save observation'; saveCapture.title = 'Keep the 12 newest observations; the oldest is replaced when full';
dom.node('capture-copy').after(saveCapture);
saveCapture.addEventListener('click', () => {
  const capture = captureView.capture;
  if (!capture.current || capture.recording) { actionStatus('Finish or stop the capture before saving.'); return; }
  void savedView.save(captureObservation(capture.current, capture.baseline));
});
new WorkspaceTabs(shell, view => {
  state.view = view; shell.dataset.workspace = view;
  dom.node('share-actions').hidden = view === 'saved';
  dom.node('compact').hidden = view !== 'live'; dom.node('save-snapshot').hidden = view !== 'live' && view !== 'server';
  // Saved captures no longer suspend monitoring (plan §5.9): the tab only loads its list.
  if (view === 'saved') void savedView.load();
  button.disabled = state.userPaused || !state.mounted;
  monitor.sync();
  if (!state.awaitingFresh && !state.userPaused) monitor.apply(state.latest);
});
// The ⋯ menu closes after an action, on Escape, and on an outside click. Share keeps it open for its own submenu.
const monitorMenu = dom.node('monitor-menu') as HTMLDetailsElement;
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
const sharing = new SharingControls(dom.node('share-actions'), host, () => [measurementReport(state.latest, state.lastHost,
  state.userPaused ? true : state.awaitingFresh ? 'refreshing' : false, version, client.now(), state.lastRequest), captureView.report()].filter(Boolean).join('\n\n'), actionStatus);
const applyPreference = (key: PreferenceKey, value: boolean): void => {
  if (state.disposed) return;
  if (key === 'efficient') {
    state.efficient = value; shell.dataset.efficient = String(value);
    dom.node('efficiency').setAttribute('aria-pressed', String(value));
    text('cadence', value ? 'Energy saving · 3s+' : 'Adaptive updates');
    state.signal.break(); monitor.armFreshness();
  } else {
    state.compact = value; shell.dataset.compact = String(value);
    dom.node('compact').setAttribute('aria-pressed', String(value));
    if (!value && !state.userPaused) {
      if (state.awaitingFresh) monitor.drawSignal();
      else monitor.apply(state.latest);
    }
  }
};
const savePreference = (key: PreferenceKey, value: boolean): void => {
  applyPreference(key, value);
  actionStatus('');
  void preferences.set(key, value).catch(() => {
    if (!state.disposed) actionStatus('View changed here, but this host could not save the preference.');
  });
};
dom.node('efficiency').addEventListener('click', () => savePreference('efficient', !state.efficient));
dom.node('compact').addEventListener('click', () => savePreference('compact', !state.compact));
dom.node('clear-recent').addEventListener('click', () => { insightView.clear(); actionStatus('Observation history cleared here. Runtime statistics were not changed.'); });
dom.node('copy-recent').addEventListener('click', async () => {
  try {
    await host.writeClipboard(insightView.report(version));
    if (!state.disposed) actionStatus('Recent observations copied without model names or request data.');
  } catch { if (!state.disposed) actionStatus('Could not copy observations. The clipboard was not confirmed.'); }
});

button.addEventListener('click', () => {
  if (!state.mounted || state.disposed || !monitor.live) return;
  state.manualRefresh = true;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  void poller.refresh();
});
const readyDeadline = setTimeout(() => {
  if (state.mounted || state.disposed || state.startupFailed) return;
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
  shell.dataset.surface = state.surface = ready.surface;
  if (state.mounted) return;
  void preferences.load(applyPreference);
  void connections.load();
  monitor.sync();
  button.disabled = state.userPaused;
  poller.start();
  state.mounted = true;
  startupFallback.remove();
  shell.hidden = false;
});
// Hidden rail tabs keep `document.hidden` false; the visibility gate also watches the frame's intersection.
visibility = new Visibility(document, window, () => monitor.sync());
window.addEventListener('pagehide', (event) => {
  poller.stop(); monitor.clearFreshness(); state.resources.break(); state.signal.break();
  insightView.suspend(); captureView.suspend(); state.generation += 1;
  state.interrupted = true; state.awaitingFresh = true;
  if (!event.persisted) {
    state.disposed = true; clearTimeout(readyDeadline);
    sharing.dispose(); inspector.dispose(); connectionHelp.dispose(); visibility.dispose();
    if (state.statusTimer !== null) clearTimeout(state.statusTimer);
    host.dispose();
  }
});
window.addEventListener('pageshow', (event) => { if (event.persisted && state.mounted) { monitor.sync(); poller.start(); } });

import { connectHost, type HostReadyContext } from '@openchamber/sdk';
import { applyHostReady } from './sdk-theme.ts';
import { version } from '../package.json';
import { ConnectionHelp } from './connection-help.ts';
import { mountCompanionSetup } from './companion-setup.ts';
import { ConnectionsView, readSelection } from './connections-view.ts';
import { frameId, SnapshotClient } from './data/client.ts';
import { Visibility } from './data/visibility.ts';
import { SharingControls } from './openchamber-view.ts';
import { Preferences, PrefsV2, type PreferenceKey } from './preferences.ts';
import { frameReading } from './present/reading.ts';
import { ScopeApp } from './render/app.ts';
import { Monitor } from './render/monitor.ts';
import { shellMarkup } from './render/shell.ts';
import { StatusApp } from './render/status-app.ts';
import { ICON } from './render/views/parts.ts';
import { measurementReport } from './report.ts';
import { Pipeline } from './state/pipeline.ts';
import { ScopeState } from './state/scope-state.ts';
import { FollowChat, type MeasurementScope } from './state/follow-chat.ts';

// Bootstrap only (plan §4.1): one bundle for the rail panel, the page and the Work Status section; `ready.surface` picks
// the renderer. The visibility gate exists before anything can poll, so a hidden rail tab never makes a request.

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
const client = new SnapshotClient(host);
let monitor: Monitor | null = null, pipeline: Pipeline | null = null, render = (): void => {}, disposeSurface = (): void => {};
let reportPreferenceFailure = (): void => {};
const visibility = new Visibility(document, window, () => monitor?.sync());
const prefs = new PrefsV2(host.storage), preferences = new Preferences(host.storage);
const follow = new FollowChat();
const resetSelection = (): void => {
  if (state.disposed || !monitor) return;
  monitor.poller.stop(); monitor.clearFreshness(); state.generation += 1;
  state.clearObservations(); state.failures = 0; state.awaitingFresh = true; state.interrupted = true;
  monitor.apply(frameReading('runtime_unreachable', 'Waiting for a fresh reading.', client.now()));
  monitor.sync();
  if (state.mounted) monitor.poller.start();
};
const changeMeasurementScope = (measurementScope: MeasurementScope): void => {
  if (measurementScope === prefs.value.measurementScope) return;
  void prefs.set({ measurementScope }).catch(() => { if (!state.disposed) reportPreferenceFailure(); });
  resetSelection();
};
const stopFollowing = host.onSession(session => {
  const wasBusy = follow.session?.busy, changed = follow.update(session);
  if (changed && (prefs.value.measurementScope ?? 'chat') === 'chat') resetSelection();
  else if (session?.busy !== wasBusy && monitor?.live && state.mounted) {
    // Activity hints request an update; they do not invalidate an otherwise fresh observation.
    // Identity changes, interruption and the observation's own deadline still clear live readings.
    render(); void monitor.poller.refresh();
  }
});
const pipelineFor = (surface: string): Pipeline => pipeline = new Pipeline({ host, state, now: () => client.now(), surface,
  toasts: () => prefs.value.toasts ?? 'critical', auto: () => prefs.value.autoLabel ?? true });
const monitorFor = (pipeline: Pipeline, tier: 'glance' | 'full', floorMs: number, query: () => Record<string, string> | undefined,
  update: (link: ReturnType<typeof frameReading>['link']) => void, refreshed: () => void): Monitor => new Monitor({
  state, client, frame: frameId(), visibility: () => visibility, tier, floorMs,
  query: () => ({ ...follow.query(prefs.value.measurementScope ?? 'chat', query()), ...pipeline.query(),
    ...state.serverDetailsVisible && tier === 'full' ? { detail: 'server' as const } : {} }),
  since: frame => pipeline.since(frame),
  received: (reading, fresh, cadenceMs) => {
    update(reading.link);
    if (reading.body) pipeline.received(reading.body, fresh, visibility.visible, cadenceMs); else pipeline.failed();
  },
  live: live => pipeline.setVisible(live), hidden: () => pipeline.hidden(), render: () => render(), refreshed,
});

/** The Work Status section: the glance or Turn stats, sized with setHeight, on the glance tier with a 5 s energy floor. */
const mountStatus = async (ready: HostReadyContext): Promise<void> => {
  await prefs.load();
  let selection: Record<string, string> | undefined = await readSelection(host.storage);
  root.innerHTML = '<main class="scope" id="scope" data-surface="status" aria-label="MLX Scope"></main>';
  const pipeline = pipelineFor('status');
  const app = new StatusApp({ root: root.querySelector<HTMLElement>('#scope')!, host, state, client, pipeline, prefs, visible: () => visibility.visible }, ready.session);
  app.onMeasurementScope = changeMeasurementScope;
  reportPreferenceFailure = () => app.reportPreferenceFailure();
  render = () => app.render();
  monitor = monitorFor(pipeline, 'glance', 5_000, () => selection, () => {}, () => {});
  preferences.load((key, value) => { if (key === 'efficient') state.efficient = value; }).catch(() => {});
  disposeSurface = () => { app.dispose(); pipeline.dispose(); };
  void readSelection(host.storage).then(next => { selection = next; });
  state.mounted = true;
  clearTimeout(readyDeadline);
  render();
  monitor.sync();
  monitor.poller.start();
};

/** The rail panel and the page. */
const mountScope = async (ready: HostReadyContext): Promise<void> => {
  root.innerHTML = shellMarkup().markup;
  root.prepend(startupFallback);
  const shell = root.querySelector<HTMLElement>('#scope')!, node = (id: string) => shell.querySelector<HTMLElement>(`#${id}`)!;
  shell.dataset.surface = ready.surface;
  node('scope-version').textContent = version;
  const actionStatus = (message: string): void => {
    if (state.statusTimer !== null) clearTimeout(state.statusTimer);
    node('action-status').textContent = message; node('action-status').hidden = !message;
    state.statusTimer = message ? setTimeout(() => { node('action-status').hidden = true; state.statusTimer = null; }, 8_000) : null;
  };
  reportPreferenceFailure = () => actionStatus('Changed here, but this host could not save the preference.');
  const pipeline = pipelineFor(ready.surface);
  const refresh = node('refresh') as HTMLButtonElement;
  const connections: ConnectionsView = new ConnectionsView(shell, host.storage, () => {
    // Picking a connection is an explicit whole-engine choice; This chat follows the chat instead.
    void prefs.set({ measurementScope: 'engine' }).catch(() => { if (!state.disposed) reportPreferenceFailure(); });
    resetSelection();
  }, actionStatus);
  const app = new ScopeApp({ shell, host, state, client, pipeline, version, connections, prefs, visible: () => visibility.visible, status: actionStatus });
  app.onMeasurementScope = changeMeasurementScope;
  render = () => app.render();
  monitor = monitorFor(pipeline, 'full', 3_000, () => connections.query(), link => connections.update(link),
    () => { refresh.disabled = state.userPaused; refresh.removeAttribute('aria-busy'); });
  app.onRefreshNeeded = () => monitor!.poller.refresh();
  const help = new ConnectionHelp(shell, host, version);
  const companion = mountCompanionSetup(node('companion-setup'), host);
  const companionDetails = node('companion-details') as HTMLDetailsElement;
  companionDetails.addEventListener('toggle', () => { if (companionDetails.open) void companion.refresh(); else companionDetails.hidden = true; });
  node('chat-setup').addEventListener('click', () => {
    companionDetails.hidden = false; companionDetails.open = true; companionDetails.scrollIntoView({ block: 'nearest' });
    companionDetails.querySelector('summary')?.focus();
  });
  const sharing = new SharingControls(node('share-actions'), host, () => measurementReport(state.latest, state.lastHost,
    state.userPaused ? true : state.awaitingFresh || state.stale ? 'refreshing' : false, version, client.now(), state.lastRequest), actionStatus);

  const pause = node('pause');
  pause.addEventListener('click', () => {
    const paused = state.userPaused = !state.userPaused;
    pause.setAttribute('aria-pressed', String(paused)); pause.setAttribute('aria-label', paused ? 'Resume monitoring' : 'Pause monitoring');
    pause.innerHTML = (paused ? ICON.play : ICON.pause).markup;
    refresh.disabled = paused || state.manualRefresh;
    monitor!.sync();
  });
  refresh.addEventListener('click', () => {
    if (state.disposed || !monitor!.live) return;
    state.manualRefresh = true; refresh.disabled = true; refresh.setAttribute('aria-busy', 'true');
    void monitor!.poller.refresh();
  });
  const applyPreference = (key: PreferenceKey, value: boolean): void => {
    if (key === 'efficient') { state.efficient = value; node('cadence').textContent = value ? 'Energy saving · 3s+' : 'Adaptive updates'; monitor!.armFreshness(); }
    else state.compact = value;
    node(key === 'efficient' ? 'efficiency' : 'compact').setAttribute('aria-pressed', String(value));
    render();
  };
  const savePreference = (key: PreferenceKey, value: boolean): void => {
    applyPreference(key, value);
    void preferences.set(key, value).catch(() => { if (!state.disposed) actionStatus('View changed here, but this host could not save the preference.'); });
  };
  app.onCompact = value => savePreference('compact', value);
  node('efficiency').addEventListener('click', () => savePreference('efficient', !state.efficient));
  node('compact').addEventListener('click', () => savePreference('compact', !state.compact));
  const TOASTS = { critical: 'critical only', all: 'all alerts', off: 'off' } as const;
  const showToasts = (): void => { node('toasts-state').textContent = TOASTS[prefs.value.toasts ?? 'critical']; };
  node('toasts').addEventListener('click', () => {
    const next = ({ critical: 'all', all: 'off', off: 'critical' } as const)[prefs.value.toasts ?? 'critical'];
    void prefs.set({ toasts: next }).catch(() => actionStatus('Changed here, but this host could not save the preference.'));
    showToasts();
  });
  // The ⋯ menu closes after an action, on Escape, and on an outside click. Share keeps it open for its own submenu.
  const menu = node('monitor-menu') as HTMLDetailsElement, summary = menu.querySelector('summary')!;
  menu.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest('button');
    if (target && target.closest('.monitor-menu-content') && (!target.closest('#share-actions') || target.closest('[role="menuitem"]'))) {
      const hadFocus = menu.contains(document.activeElement);
      menu.open = false;
      if (hadFocus) summary.focus({ preventScroll: true });
    }
  });
  menu.addEventListener('keydown', event => { if (event.key === 'Escape' && menu.open) { menu.open = false; summary.focus(); } });
  const outside = (event: PointerEvent): void => { if (menu.open && !menu.contains(event.target as Node)) menu.open = false; };
  document.addEventListener('pointerdown', outside, true);
  disposeSurface = () => { app.dispose(); pipeline.dispose(); sharing.dispose(); help.dispose(); companion.dispose(); document.removeEventListener('pointerdown', outside, true); };

  await Promise.all([preferences.load(applyPreference), prefs.load().then(showToasts), connections.load()]);
  if (state.disposed) return;
  state.mounted = true;
  clearTimeout(readyDeadline);
  startupFallback.remove();
  shell.hidden = false;
  refresh.disabled = state.userPaused;
  render();
  if (ready.surface === 'panel' && visibility.visible) pipeline.panelMounted();
  // The gate decides before the first poll: a display:none rail tab starts paused and never asks.
  monitor.sync();
  monitor.poller.start();
};

const readyDeadline = setTimeout(() => {
  if (state.mounted || state.disposed || state.startupFailed) return;
  startupStatus.textContent = started
    ? 'Waiting for saved settings from OpenChamber. If this continues, reload MLX Scope in Settings → Extensions.'
    : 'Waiting for OpenChamber. Open this monitor from the extension panel in OpenChamber. If it is already open there, reload the extension in Settings → Extensions.';
}, 6_000);
let started = false;
host.onReady(ready => {
  applyHostReady(ready, document.documentElement);
  document.documentElement.style.colorScheme = ready.theme.mode;
  if (started) { render(); return; }
  started = true;
  startupStatus.textContent = 'Loading saved settings…';
  follow.update(ready.session);
  state.surface = ready.surface;
  (ready.surface === 'status' ? mountStatus(ready) : mountScope(ready)).catch(() => showStartupFailure());
});
window.addEventListener('pagehide', event => {
  pipeline?.hidden();
  monitor?.poller.stop(); monitor?.clearFreshness(); state.signal.break(); state.generation += 1;
  state.interrupted = true; state.awaitingFresh = true;
  if (!event.persisted) {
    state.disposed = true; clearTimeout(readyDeadline);
    disposeSurface(); visibility.dispose(); stopFollowing();
    if (state.statusTimer !== null) clearTimeout(state.statusTimer);
    host.dispose();
  }
});
window.addEventListener('pageshow', event => { if (event.persisted && state.mounted && monitor) { monitor.sync(); monitor.poller.start(); } });

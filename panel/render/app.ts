import { actionButton } from './views/parts.ts';
import type { CompanionSetupStatus } from '../../service/companion-setup.ts';
import type { MediaController } from '../media/controller.ts';
import { mediaMarkup, mediaGlanceMarkup } from '../media/view.ts';
import { orderedMediaJobs } from '../media/present.ts';
import { mediaTerminal } from '../../src/contract/media.ts';
import { beatKey, Motion } from './motion.ts';
import type { HostClient, SessionSnapshot } from '../host/types.ts';
import type { SnapshotV2 } from '../../src/contract/snapshot.ts';
import type { ConnectionsView } from '../connections-view.ts';
import type { SnapshotClient } from '../data/client.ts';
import { HistoryClient } from '../data/history.ts';
import type { PrefsV2 } from '../preferences.ts';
import { FRAME_TITLE, NO_FRESH, NO_FRESH_DETAIL } from '../present/copy.ts';
import { frameCard, presentHeader } from '../present/header.ts';
import { presentLive } from '../present/live.ts';
import type { Callout } from '../present/parts.ts';
import { chatOnlyView, modelOf, type ScopeInput } from '../present/scope.ts';
import { presentSessionSection } from '../present/session.ts';
import type { Pipeline } from '../state/pipeline.ts';
import type { ScopeState } from '../state/scope-state.ts';
import { html, morph } from './html.ts';
import { frameCardMarkup, renderHeader } from './shell.ts';
import { liveMarkup } from './views/live.ts';
import { historyView } from './views/history.ts';
import { mountSafely } from './views/registry.ts';
import { sessionMarkup, scopeMenuMarkup } from './views/session.ts';
import type { Tab, ViewHandle } from './views/types.ts';

// One column of truth at every width: This chat and its engine (server rows inside the measurement disclosure), the
// This Mac card, then Media while it has jobs. History is the only secondary view, reached from the column's foot with
// Back. Polls patch views in place.

/** Media joins the column only in its own states: running jobs, a notice, or a job that finished in the last 15 min. */
const RECENT_MEDIA_MS = 15 * 60_000;

export interface AppParts {
  shell: HTMLElement; host: HostClient; state: ScopeState; client: SnapshotClient; pipeline: Pipeline; version: string;
  session: () => SessionSnapshot | null; mediaJobs: MediaController; companion: () => CompanionSetupStatus | null; connections: ConnectionsView; prefs: PrefsV2; visible: () => boolean; status: (message: string) => void;
}
export class ScopeApp {
  #wide = false;
  #inspecting = false;
  #historyReturn = 'open-history';
  readonly #motion: Motion;
  readonly #views = new Map<'history', { host: HTMLElement; handle: ViewHandle }>();
  readonly #media = typeof matchMedia === 'function' ? matchMedia('(min-width: 900px)') : null;
  readonly #node = (id: string): HTMLElement => this.#shell.querySelector<HTMLElement>(`#${id}`)!;
  readonly #p: AppParts;
  readonly #shell: AppParts['shell'];
  readonly #state: AppParts['state'];
  readonly #connections: AppParts['connections'];
  readonly #mediaJobs: AppParts['mediaJobs'];
  #navigationAction: string | null = null;

  constructor(p: AppParts) {
    this.#p = p;
    this.#shell = p.shell;
    this.#state = p.state;
    this.#connections = p.connections;
    this.#mediaJobs = p.mediaJobs;

    const shell = p.shell;
    this.#motion = new Motion(shell);
    shell.addEventListener('click', this.#onClick);
    shell.addEventListener('change', this.#onChange);
    shell.addEventListener('keydown', this.#onKey);
    shell.addEventListener('toggle', this.#onToggle, true);
    this.#media?.addEventListener('change', this.#onLayout);
    this.#onLayout();
  }
  readonly #onLayout = (): void => {
    this.#wide = this.#state.surface === 'page' && (this.#media?.matches ?? false);
    this.#shell.dataset.layout = this.#wide ? 'wide' : 'column';
    this.render();
  };

  /** Everything the presenters read, from the state and the pipeline. */
  input(): ScopeInput {
    const { state, pipeline, client, version } = this.#p, snapshot = state.snapshot, last = state.lastRequest, chat = this.#p.session(), window = pipeline.window();
    return {
      now: client.now(), version, snapshot, fresh: snapshot !== null && !state.stale && !state.frame && !state.awaitingFresh, frame: state.frame, stale: state.stale,
      paused: state.userPaused, efficient: state.efficient, attribution: pipeline.liveLabel(snapshot), chatRuntime: pipeline.chatRuntime(),
      last: last ? { completion: last, label: pipeline.label(last), ...pipeline.usualFor(last, snapshot?.connection.runtime ?? null) } : null,
      samples: state.signal.points, window, turnStartAt: window?.startedAt ?? null,
      measurementScope: this.#p.prefs.value.measurementScope ?? 'auto', sessionModel: chat?.model ?? null,
      chatActivity: chat ? window?.endedAt === null || chat.busy === true ? 'busy' : chat.busy === false ? 'idle' : null : null, chatIsLocal: pipeline.chatIsLocal(),
      lastChat: state.lastChat, promptEtaMs: state.promptEta.ms, flags: pipeline.flagsFor(snapshot?.connection.runtime ?? null, modelOf(snapshot)),
    };
  }
  /** Frame-side callouts: a poll without a body, or no fresh reading before the deadline. */
  #extra(s: ScopeInput): Callout[] {
    if (s.frame) return [{ key: 'frame', severity: 'warning', title: FRAME_TITLE[s.frame.reason] ?? 'Scope can’t read its service right now', detail: s.frame.message ?? '', since: '', action: null }];
    // Only a missed deadline says so; a frame that was just shown again is merely refreshing.
    return this.#state.stale && !s.paused ? [{ key: 'stale', severity: 'warning', title: NO_FRESH, detail: NO_FRESH_DETAIL, since: '', action: null }] : [];
  }

  render(): void {
    const { state } = this.#p;
    if (state.disposed || !state.mounted) return;
    // Native toggle events are queued: a poll must not undo a click made before that event arrives.
    for (const details of Array.from(this.#shell.querySelectorAll<HTMLDetailsElement>('details[id]:not(#monitor-menu):not(#connection-help)'))) {
      if (details.open) state.open.add(details.id); else state.open.delete(details.id);
    }
    this.#shell.dataset.mediaMotion = String(this.#p.visible() && !state.userPaused && !this.#connections.isOpen);
    const s = this.input(), card = frameCard(s), open = state.open, compact = state.compact && !this.#wide && !card;
    // Service approval and version skew block live readings, not this device's saved history.
    const localView = state.tab === 'history', blocked = !!card && !localView;
    this.#mediaJobs.sync(this.#p.visible() && !state.userPaused && !card && !this.#connections.isOpen && (state.tab === 'live' || compact));
    // The column carries its own Media block; the glance summarizes media only where the column is not shown.
    const mediaGlance = this.#node('media-glance'), column = !compact && !card && state.tab === 'live';
    mediaGlance.hidden = !!card || column;
    morph(mediaGlance, card || column ? '' : mediaGlanceMarkup(this.#mediaJobs, this.#p.session()?.id ?? null, s.now, false));
    const chatOnly = chatOnlyView(s);
    // Server rows live inside the measurement hub; only a reader who opened the hub pays for the extra reads.
    const serverVisible = state.tab === 'live' && !compact && !card && !chatOnly && open.has('measurement-details');
    if (serverVisible && !state.serverDetailsVisible) void this.onRefreshNeeded();
    state.serverDetailsVisible = serverVisible;
    renderHeader(this.#shell, presentHeader(s));
    const currentAction = this.#connections.isOpen ? 'connection' : state.tab === 'history' ? 'open-history' : 'show-live';
    if (currentAction !== this.#navigationAction) {
      this.#navigationAction = currentAction;
      for (const button of Array.from(this.#shell.querySelectorAll<HTMLElement>('.next-nav [data-action]'))) {
        if (button.dataset.action === currentAction) { if (button.getAttribute('aria-current') !== 'page') button.setAttribute('aria-current', 'page'); }
        else if (button.hasAttribute('aria-current')) button.removeAttribute('aria-current');
      }
    }
    const scopeControl = this.#shell.querySelector<HTMLElement>('#measurement-choice');
    if (scopeControl) morph(scopeControl, scopeMenuMarkup(this.#p.prefs.value.measurementScope ?? 'auto'));
    this.#shell.dataset.compact = String(compact);
    const cardHost = this.#node('frame-card');
    morph(cardHost, card ? frameCardMarkup(card) : '');
    cardHost.hidden = this.#connections.isOpen || localView;
    this.#node('freshness').parentElement!.hidden = this.#connections.isOpen;
    this.#node('panels').hidden = blocked || compact || this.#connections.isOpen;
    const glance = this.#node('compact-glance');
    glance.hidden = !compact;
    if (this.#connections.isOpen) { glance.hidden = true; mediaGlance.hidden = true; this.#motion.reset(); return; }
    if (compact) {
      morph(glance, sessionMarkup(presentSessionSection({ now: s.now, reading: state.latest, snapshot: s.snapshot, attribution: s.attribution,
        chatIsLocal: s.chatIsLocal ?? null, fresh: s.fresh, paused: s.paused, window: s.window,
        efficient: state.efficient, measurementScope: s.measurementScope, sessionModel: s.sessionModel, chatActivity: s.chatActivity, lastChat: s.lastChat, promptEtaMs: s.promptEtaMs, restingFacts: true,
        last: s.last && { completion: s.last.completion, label: s.last.label } }), null, true, true));
      this.#syncMotion(s); return;
    }
    if (blocked) { this.#syncMotion(s); return; }
    const active = state.tab, live = presentLive(s, this.#extra(s));
    this.#node('panel-live').hidden = active !== 'live';
    this.#node('panel-history').hidden = active !== 'history';
    // These stateless views are rebuilt from the snapshot; remove hidden copies of their shared disclosure ids.
    if (active !== 'live') morph(this.#node('view-live'), '');
    const mediaBlock = this.#node('view-media'), media = this.#mediaJobs, sessionId = this.#p.session()?.id ?? null;
    const mediaPresent = active === 'live' && (!!media.error || !!media.actionError || orderedMediaJobs(media.snapshot, sessionId)
      .some(job => !mediaTerminal(job.state) || job.finishedAtMs !== undefined && s.now - job.finishedAtMs < RECENT_MEDIA_MS));
    mediaBlock.hidden = !mediaPresent;
    if (mediaPresent) mediaBlock.dataset.arrive = ''; else delete mediaBlock.dataset.arrive;
    morph(mediaBlock, mediaPresent ? mediaMarkup(media, sessionId, s.now) : '');
    if (active === 'live') {
      morph(this.#node('view-live'), s.snapshot || s.frame ? html`${liveMarkup(live, open)}${this.#chatSetupHint(s)}` : html`<p class="empty" id="waiting">Waiting for the first reading.</p>`);
    }
    if (active === 'history') this.#view('history', this.#node('view-history'), s.snapshot);
    this.#syncMotion(s);
  }
  #chatSetupHint(s: ScopeInput) {
    const status = this.#p.companion();
    if (s.measurementScope === 'engine' || s.snapshot?.chat || s.paused || s.frame || !s.fresh) return '';
    if (status?.state === 'ready') return s.chatIsLocal === false ? html`<p class="coverage-note">Chat speed is ready. Your next streamed reply will show its estimated delivery speed.</p>` : '';
    if (status?.state === 'pending') return html`<div class="setup-hint"><p>${status.message}</p>${actionButton('chat-setup', 'View setup')}</div>`;
    if (s.chatIsLocal !== false && s.snapshot?.runtime.request?.decodeTps != null) return '';
    // A cloud chat has no engine reading to fall back on: without the helper, say why there is no estimate.
    return html`<div class="setup-hint" data-arrive><div><h3>${s.chatIsLocal === false ? 'See this chat’s delivery speed' : 'Track speed for this chat'}</h3><p>${status?.state === 'incompatible' ? status.message : 'Optional chat tracking adds labeled delivery estimates for local and cloud models.'}</p></div>${actionButton('chat-setup', status?.canEnable ? 'Set up chat speed' : 'Chat speed setup')}</div>`;
  }
  #syncMotion(s: ScopeInput): void {
    this.#motion.sync(this.#p.visible() && !s.paused && !this.#connections.isOpen, s.fresh && !s.paused ? beatKey(this.#shell, s.snapshot, true) : null);
  }
  visibilityChanged(): void { this.render(); }
  /**
   * History is ui-history's view, given this frame's one Ledger and the poll's selection (INTERFACES §4.4). Mounted once
   * into a stable host that moves between layouts.
   */
  #view(tab: 'history', container: HTMLElement | null, snapshot: SnapshotV2 | null): void {
    let entry = this.#views.get(tab);
    if (!entry) {
      const host = document.createElement('div'), { pipeline, connections, prefs } = this.#p;
      host.className = 'view-host';
      const context = { host: this.#p.host, surface: this.#state.surface === 'page' ? 'page' as const : 'panel' as const, now: () => this.#p.client.now(),
        visible: () => this.#p.visible() && !this.#node('panels').hidden && this.#state.tab === tab, leader: () => this.#state.snapshot?.lease.leader ?? false };
      const copy = (text: string) => this.#p.host.writeClipboard(text);
      entry = { host, handle: mountSafely(tab, host, context, historyView({ ledger: pipeline.ledger, client: new HistoryClient(this.#p.host),
        retentionDays: () => prefs.value.retentionDays ?? 30, paused: () => prefs.value.history === false, copy,
        current: () => this.input(), inspectInitially: this.#inspecting,
        inspectionChanged: open => { this.#node('history-title').textContent = open ? 'Run details' : 'History'; },
        version: this.#p.version, selection: () => connections.query() ?? {}, replies: rows => pipeline.storedReplies(rows), cleared: () => pipeline.historyCleared(),
        autoLabel: () => prefs.value.autoLabel ?? true, setAutoLabel: value => prefs.set({ autoLabel: value }) })) };
      this.#views.set(tab, entry);
    }
    if (container && entry.host.parentElement !== container) container.append(entry.host);
    try { entry.handle.update(snapshot); } catch { /* another track's view never stops this one */ }
  }
  #select(tab: Tab, focus: boolean): void {
    const { state } = this.#p, previous = state.tab;
    if (previous === tab) return;
    state.tab = tab;
    this.render();
    if (tab === 'history') this.#views.get(tab)?.handle.activate?.();
    // Return to the visible action that left Live, including the persistent navigation and detail actions.
    if (focus) {
      const target = tab === 'live' ? this.#liveAction(previous === 'history' ? this.#historyReturn : `open-${previous}`)
        : this.#shell.querySelector<HTMLElement>(`#${tab}-title`);
      target?.focus({ preventScroll: true });
      if (tab !== 'live') target?.parentElement?.scrollIntoView({ block: 'start' });
    }
  }
  #liveAction(action: string): HTMLElement | null {
    return Array.from(this.#shell.querySelectorAll<HTMLElement>(`[data-action="${action}"]`)).find(node => node.checkVisibility())
      ?? this.#shell.querySelector<HTMLElement>('.next-nav [data-action="show-live"]');
  }
  onRefreshNeeded: () => Promise<void> = async () => {};
  onMeasurementScope: (scope: 'auto' | 'engine') => void = () => {};
  readonly #onChange = (event: Event): void => {
    const target = event.target as HTMLSelectElement;
    if (target.dataset.action === 'measurement-scope' && (target.value === 'auto' || target.value === 'engine')) {
      this.onMeasurementScope(target.value);
      this.render();
    }
  };

  #disclose(button: HTMLElement): void {
    const id = button.getAttribute('aria-controls')!, open = this.#state.open, next = !open.has(id);
    if (button.dataset.disclose === 'info') for (const other of Array.from(open)) if (other.startsWith('pop-')) open.delete(other);
    if (next) open.add(id); else open.delete(id);
    this.render();
  }
  readonly #onClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement;
    const disclose = target.closest<HTMLElement>('[data-disclose]');
    if (disclose) { this.#disclose(disclose); return; }
    // History has its own delegated controls and shares only the frame-owned controller.
    if (target.closest('.view-host')) return;
    const media = target.closest<HTMLElement>('[data-media-action]');
    if (media) {
      const key = media.dataset.job!, action = media.dataset.mediaAction;
      if (action === 'cancel') { this.#mediaJobs.requestCancel(key); this.#shell.querySelector<HTMLElement>('[data-media-action="dismiss"]')?.focus(); }
      else if (action === 'confirm') void this.#mediaJobs.cancel(key);
      else if (action === 'dismiss') this.#mediaJobs.dismissCancel();
      return;
    }
    const trigger = target.closest<HTMLElement>('[data-action]'), action = trigger?.dataset.action;
    if (action) this.#act(action, trigger ?? undefined);
  };
  #act(action: string, trigger?: HTMLElement): void {
    const { pipeline, state, connections } = this.#p;
    if ((action === 'show-live' || action === 'open-history') && connections.isOpen) this.#node('connection-close').click();
    if (action === 'show-live') { this.#select('live', false); this.render(); return; }
    if (action === 'open-media') {
      this.#select('live', false);
      const block = this.#node('view-media');
      if (!block.hidden) { block.scrollIntoView({ block: 'nearest' }); block.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true }); }
      return;
    }
    if (action === 'open-run') {
      // A reused History view must enter inspection before activation can start its reads.
      this.#views.get('history')?.handle.inspect?.();
      this.#historyReturn = 'open-run'; this.#inspecting = true; this.#select('history', false); this.#inspecting = false;
      // Focus after the destination is visible, including the first lazy mount.
      this.#views.get('history')?.handle.inspect?.(); return;
    }
    if (action === 'open-history') { this.#historyReturn = 'open-history'; this.#views.get('history')?.handle.inspect?.(false); this.#select('history', true); return; }
    if (action === 'chat-setup') { connections.openSetup(trigger); this.#node('companion-title').focus({ preventScroll: true }); this.#node('companion-title').scrollIntoView({ block: 'nearest' }); return; }
    if (action === 'back-live') { this.#select('live', true); return; }
    if (action === 'connection') connections.openSetup(trigger);
    else if (action === 'switch') { const detected = state.snapshot?.status.params.detected; if (typeof detected === 'string') connections.switchRuntime(detected as never); }
    else if (action === 'expand') { state.compact = false; this.onCompact(false); }
    this.render();
  }
  onCompact: (value: boolean) => void = () => {};
  readonly #onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      const open = Array.from(this.#state.open).find(id => id.startsWith('pop-'));
      if (!open) return;
      this.#state.open.delete(open);
      this.render();
      this.#shell.querySelector<HTMLElement>(`[aria-controls="${open}"]`)?.focus({ preventScroll: true });
    }
  };
  /** <details> the reader opens or closes (Mac details, the approval list) keep that state across polls. */
  readonly #onToggle = (event: Event): void => {
    const details = event.target as HTMLDetailsElement;
    if (!(details instanceof HTMLDetailsElement) || !details.id || details.id === 'monitor-menu' || details.id === 'connection-help') return;
    if (details.open) this.#state.open.add(details.id); else this.#state.open.delete(details.id);
  };
  /** Views other tracks mounted are told the frame is going away. */
  dispose(): void {
    this.#motion.dispose();
    this.#shell.removeEventListener('click', this.#onClick); this.#shell.removeEventListener('keydown', this.#onKey); this.#shell.removeEventListener('toggle', this.#onToggle, true);
    this.#shell.removeEventListener('change', this.#onChange);
    this.#media?.removeEventListener('change', this.#onLayout);
    for (const { handle } of this.#views.values()) try { handle.dispose(); } catch { /* see view() */ }
    this.#views.clear();
  }
}

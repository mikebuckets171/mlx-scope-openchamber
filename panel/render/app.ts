import type { CompanionSetupStatus } from '../../service/companion-setup.ts';
import type { MediaController } from '../media/controller.ts';
import { mediaMarkup, mediaGlanceMarkup } from '../media/view.ts';
import { orderedMediaJobs } from '../media/present.ts';
import { mediaTerminal } from '../../src/contract/media.ts';
import { DigitRoll } from './digit-roll.ts';
import { beatKey, Motion } from './motion.ts';
import type { HostClient, SessionSnapshot } from '@openchamber/sdk';
import type { SnapshotV2 } from '../../src/contract/snapshot.ts';
import type { ConnectionsView } from '../connections-view.ts';
import { CaptureStore } from '../captures/store.ts';
import type { SnapshotClient } from '../data/client.ts';
import { HistoryClient } from '../data/history.ts';
import { KEYS } from '../history/ledger-schema.ts';
import type { PrefsV2 } from '../preferences.ts';
import { FRAME_TITLE, NO_FRESH, NO_FRESH_DETAIL } from '../present/copy.ts';
import { frameCard, presentHeader } from '../present/header.ts';
import { presentLive, presentMac } from '../present/live.ts';
import { nextReplyCapture } from '../present/captures-tab.ts';
import type { Callout } from '../present/parts.ts';
import type { ScopeInput } from '../present/scope.ts';
import { presentServer } from '../present/server.ts';
import { presentSessionSection } from '../present/session.ts';
import type { Pipeline } from '../state/pipeline.ts';
import type { ScopeState } from '../state/scope-state.ts';
import { html, morph } from './html.ts';
import { frameCardMarkup, renderHeader } from './shell.ts';
import { liveMarkup, macCard, nextRow } from './views/live.ts';
import { capturesView, readLegacyCaptures } from './views/captures.ts';
import { historyView } from './views/history.ts';
import { mountSafely } from './views/registry.ts';
import { serverMarkup } from './views/server.ts';
import { sessionMarkup, scopeMenuMarkup } from './views/session.ts';
import type { Tab, ViewHandle } from './views/types.ts';

// One column of truth at every width: This chat and its engine, then Media while it has jobs. History, Captures and
// Server & Mac details are secondary views with Back; the active view still controls extra server reads and view
// visibility. Polls patch views in place.

/** Media joins the column only in its own states: running jobs, a notice, or a job that finished in the last 15 min. */
const RECENT_MEDIA_MS = 15 * 60_000;

export interface AppParts {
  shell: HTMLElement; host: HostClient; state: ScopeState; client: SnapshotClient; pipeline: Pipeline; version: string;
  session: () => SessionSnapshot | null; mediaJobs: MediaController; companion: () => CompanionSetupStatus | null; connections: ConnectionsView; prefs: PrefsV2; visible: () => boolean; status: (message: string) => void;
}
export class ScopeApp {
  private wide = false;
  private readonly digits: DigitRoll;
  private readonly motion: Motion;
  private readonly views = new Map<'history' | 'captures', { host: HTMLElement; handle: ViewHandle }>();
  private readonly media = typeof matchMedia === 'function' ? matchMedia('(min-width: 900px)') : null;
  private readonly node = (id: string): HTMLElement => this.p.shell.querySelector<HTMLElement>(`#${id}`)!;
  constructor(private readonly p: AppParts) {
    const shell = p.shell;
    this.digits = new DigitRoll(shell);
    this.motion = new Motion(shell);
    shell.addEventListener('click', this.onClick);
    shell.addEventListener('change', this.onChange);
    shell.addEventListener('keydown', this.onKey);
    shell.addEventListener('toggle', this.onToggle, true);
    this.media?.addEventListener('change', this.onLayout);
    this.onLayout();
  }
  private readonly onLayout = (): void => {
    this.wide = this.p.state.surface === 'page' && (this.media?.matches ?? false);
    this.p.shell.dataset.layout = this.wide ? 'wide' : 'column';
    this.render();
  };

  /** Everything the presenters read, from the state and the pipeline. */
  input(): ScopeInput {
    const { state, pipeline, client, version } = this.p, snapshot = state.snapshot, last = state.lastRequest, chat = pipeline.frame().chat, window = pipeline.window();
    return {
      now: client.now(), version, snapshot, fresh: snapshot !== null && !state.stale && !state.frame && !state.awaitingFresh, frame: state.frame, stale: state.stale,
      paused: state.userPaused, efficient: state.efficient, attribution: pipeline.liveLabel(snapshot), chatRuntime: pipeline.chatRuntime(),
      last: last ? { completion: last, label: pipeline.label(last), ...pipeline.usualFor(last, snapshot?.connection.runtime ?? null) } : null,
      next: pipeline.nextState, samples: state.signal.points, window, turnStartAt: window?.startedAt ?? null,
      measurementScope: this.p.prefs.value.measurementScope ?? 'chat', sessionModel: chat?.model ?? null,
      chatActivity: chat ? window?.endedAt === null || chat.busy ? 'busy' : 'idle' : null, chatIsLocal: pipeline.chatIsLocal(),
      lastChat: state.lastChat,
    };
  }
  /** Frame-side callouts: a poll without a body, or no fresh reading before the deadline. */
  private extra(s: ScopeInput): Callout[] {
    if (s.frame) return [{ key: 'frame', severity: 'warning', title: FRAME_TITLE[s.frame.reason] ?? 'Scope can’t read its service right now', detail: s.frame.message ?? '', since: '', action: null }];
    // Only a missed deadline says so; a frame that was just shown again is merely refreshing.
    return this.p.state.stale && !s.paused ? [{ key: 'stale', severity: 'warning', title: NO_FRESH, detail: NO_FRESH_DETAIL, since: '', action: null }] : [];
  }

  render(): void {
    const { state } = this.p;
    if (state.disposed || !state.mounted) return;
    this.p.shell.dataset.mediaMotion = String(this.p.visible() && !state.userPaused && !this.p.connections.isOpen);
    const s = this.input(), card = frameCard(s), open = state.open, compact = state.compact && !this.wide && !card;
    this.p.mediaJobs.sync(this.p.visible() && !state.userPaused && !card && !this.p.connections.isOpen && (state.tab === 'live' || compact));
    // The column carries its own Media block; the glance summarizes media only where the column is not shown.
    const mediaGlance = this.node('media-glance'), column = !compact && !card && state.tab === 'live';
    mediaGlance.hidden = !!card || column;
    morph(mediaGlance, card || column ? '' : mediaGlanceMarkup(this.p.mediaJobs, this.p.session()?.id ?? null, s.now, false));
    const chatOnly = s.measurementScope !== 'engine' && s.chatIsLocal === false;
    state.serverDetailsVisible = state.tab === 'server' && !compact && !card && !chatOnly;
    renderHeader(this.p.shell, presentHeader(s));
    const scopeControl = this.p.shell.querySelector<HTMLElement>('#measurement-choice');
    if (scopeControl) morph(scopeControl, scopeMenuMarkup(this.p.prefs.value.measurementScope ?? 'chat'));
    this.p.shell.dataset.compact = String(compact);
    const cardHost = this.node('frame-card');
    morph(cardHost, card ? frameCardMarkup(card) : '');
    cardHost.hidden = this.p.connections.isOpen;
    this.node('freshness').parentElement!.hidden = this.p.connections.isOpen;
    this.node('panels').hidden = !!card || compact || this.p.connections.isOpen;
    this.node('next-activity').hidden = true;
    // A timed window belongs to this frame, even when Compact or another workspace is visible.
    this.view('captures', this.node('captures-content'), s.snapshot);
    const timed = this.views.get('captures')?.handle.captureActivity?.(), timedHost = this.node('capture-activity');
    const showTimed = !!timed && !card && (state.tab !== 'captures' || compact);
    timedHost.hidden = !showTimed;
    morph(timedHost, showTimed ? html`<div class="next-row"><span class="pulse" aria-hidden="true"></span><span>${timed}</span><button class="btn quiet" type="button" data-action="window-cancel">Cancel</button></div>` : '');
    const glance = this.node('compact-glance');
    glance.hidden = !compact;
    if (this.p.connections.isOpen) { glance.hidden = true; timedHost.hidden = true; mediaGlance.hidden = true; this.digits.reset(); this.motion.reset(); return; }
    if (compact) {
      morph(glance, sessionMarkup(presentSessionSection({ now: s.now, reading: state.latest, snapshot: s.snapshot, attribution: s.attribution,
        chatIsLocal: s.chatIsLocal ?? null, fresh: s.fresh, paused: s.paused, next: s.next, window: s.window,
        efficient: state.efficient, measurementScope: s.measurementScope, sessionModel: s.sessionModel, chatActivity: s.chatActivity, lastChat: s.lastChat,
        last: s.last && { completion: s.last.completion, label: s.last.label } }), null, true));
      this.syncMotion(); return;
    }
    if (card) { this.syncMotion(); return; }
    const active = state.tab, live = presentLive(s, this.extra(s));
    this.node('panel-live').hidden = active !== 'live';
    this.node('panel-history').hidden = active !== 'history';
    this.node('panel-server').hidden = active !== 'server';
    this.node('panel-captures').hidden = active !== 'captures';
    // A cloud chat has no local server to detail.
    this.node('open-server').hidden = chatOnly;
    // These stateless views are rebuilt from the snapshot; remove hidden copies of their shared disclosure ids.
    if (active !== 'live') morph(this.node('view-live'), '');
    if (active !== 'server') morph(this.node('panel-server'), '');
    // Active measurement stays cancellable on the secondary Server view and on History.
    const next = live.hero?.reply?.next, activity = this.node('next-activity');
    const showActivity = (active === 'history' || active === 'server') && (next?.kind === 'armed' || next?.kind === 'measuring');
    activity.hidden = !showActivity;
    morph(activity, showActivity ? nextRow(next, open) : '');
    const mediaBlock = this.node('view-media'), media = this.p.mediaJobs, sessionId = this.p.session()?.id ?? null;
    const mediaPresent = active === 'live' && (!!media.error || !!media.actionError || orderedMediaJobs(media.snapshot, sessionId)
      .some(job => !mediaTerminal(job.state) || job.finishedAtMs !== undefined && s.now - job.finishedAtMs < RECENT_MEDIA_MS));
    mediaBlock.hidden = !mediaPresent;
    if (mediaPresent) mediaBlock.dataset.arrive = ''; else delete mediaBlock.dataset.arrive;
    morph(mediaBlock, mediaPresent ? mediaMarkup(media, sessionId, s.now) : '');
    if (active === 'live') {
      morph(this.node('view-live'), s.snapshot || s.frame ? html`${liveMarkup(live, open)}${this.chatSetupHint()}` : html`<p class="empty" id="waiting">Waiting for the first reading.</p>`);
    }
    if (active === 'server') morph(this.node('panel-server'), html`<div class="secondary-heading"><button class="btn quiet" type="button" data-action="back-live">Back</button><h2 id="server-title" tabindex="-1">Server &amp; Mac details</h2></div>${serverMarkup(presentServer(s.snapshot, s.now, this.extra(s), s.fresh && !s.paused), open)}${macCard(presentMac(s), open)}`);
    if (active === 'history') this.view('history', this.node('view-history'), s.snapshot);
    this.syncMotion();
  }
  private chatSetupHint() {
    const s = this.input(), status = this.p.companion();
    if (s.measurementScope === 'engine' || s.snapshot?.chat || s.paused || s.frame || !s.fresh) return '';
    if (status?.state === 'ready') return s.chatIsLocal === false ? html`<p class="coverage-note">Chat speed is ready. Your next streamed reply will show its estimated delivery speed.</p>` : '';
    if (status?.state === 'pending') return html`<div class="setup-hint"><p>${status.message}</p><button class="btn quiet" type="button" data-action="chat-setup">View setup</button></div>`;
    if (s.chatIsLocal !== false && s.snapshot?.runtime.request?.decodeTps != null) return '';
    // A cloud chat has no engine reading to fall back on: without the helper, say why there is no estimate.
    return html`<div class="setup-hint" data-arrive><div><h3>${s.chatIsLocal === false ? 'See this chat’s delivery speed' : 'Track speed for this chat'}</h3><p>${status?.state === 'incompatible' ? status.message : 'Optional chat tracking adds labeled delivery estimates for local and cloud models.'}</p></div><button class="btn quiet" type="button" data-action="chat-setup">${status?.canEnable ? 'Set up chat speed' : 'Chat speed setup'}</button></div>`;
  }
  private syncMotion(): void {
    const s = this.input(), chat = this.p.session(), snapshot = s.snapshot;
    this.digits.sync(`${this.p.state.generation}/${chat?.id ?? ''}/${chat?.model ?? ''}/${snapshot?.connection.id ?? ''}/${snapshot?.connection.generation ?? ''}/${snapshot?.runtime.phase ?? ''}/${s.window?.startedAt ?? ''}/${snapshot?.chat?.phase ?? ''}`, this.p.visible() && s.fresh && !s.paused && this.p.state.tab === 'live');
    this.motion.sync(this.p.visible() && !s.paused && !this.p.connections.isOpen, s.fresh && !s.paused ? beatKey(this.p.shell, snapshot) : null);
  }
  visibilityChanged(): void { this.render(); }
  /**
   * History and Captures are ui-history's views, given this frame's one Ledger, its Next reply control and the poll's
   * selection (INTERFACES §4.4). Mounted once into a stable host that moves between layouts; Captures is mounted from
   * the first render and updated on every poll, hidden or not, because its 30/60 s window is fed by polls.
   */
  private view(tab: 'history' | 'captures', container: HTMLElement | null, snapshot: SnapshotV2 | null): void {
    let entry = this.views.get(tab);
    if (!entry) {
      const host = document.createElement('div'), { pipeline, connections, prefs } = this.p, storage = this.p.host.storage;
      host.className = 'view-host';
      const context = { host: this.p.host, surface: this.p.state.surface === 'page' ? 'page' as const : 'panel' as const, now: () => this.p.client.now(),
        visible: () => this.p.visible() && !this.node('panels').hidden && this.p.state.tab === tab, leader: () => this.p.state.snapshot?.lease.leader ?? false };
      const copy = (text: string) => this.p.host.writeClipboard(text);
      entry = { host, handle: mountSafely(tab, host, context, tab === 'history'
        ? historyView({ ledger: pipeline.ledger, client: new HistoryClient(this.p.host), retentionDays: () => prefs.value.retentionDays ?? 30,
          paused: () => prefs.value.history === false, copy,
          version: this.p.version, selection: () => connections.query() ?? {}, flags: flags => { pipeline.flags = flags; },
          legacyCaptures: async () => (await storage.keys()).filter(key => key.startsWith(KEYS.legacyObservationPrefix)).length })
        : capturesView({ store: new CaptureStore(storage), legacy: () => readLegacyCaptures(storage), copy, version: this.p.version,
          compose: text => this.p.host.compose({ text, mode: 'append' }), forbidden: () => pipeline.ledgerModels,
          next: { state: () => pipeline.nextState, arm: () => pipeline.arm(), cancel: () => pipeline.cancel(), watch: () => this.watch() } })) };
      this.views.set(tab, entry);
    }
    if (container && entry.host.parentElement !== container) container.append(entry.host);
    try { entry.handle.update(snapshot); } catch { /* another track's view never stops this one */ }
  }
  /** "Watch …": monitor the open chat's connection; without one Scope knows, open the chooser. */
  private watch(): void {
    const provider = this.p.pipeline.watchable();
    if (provider) this.p.connections.watch(provider); else this.p.connections.openSetup();
  }

  private select(tab: Tab, focus: boolean): void {
    const { state } = this.p, previous = state.tab;
    if (previous === tab) return;
    state.tab = tab;
    this.render();
    if (tab === 'history' || tab === 'captures') this.views.get(tab)?.handle.activate?.();
    // Back to the column returns focus to the foot action that left it.
    if (focus) (tab === 'live' ? this.p.shell.querySelector<HTMLElement>(`#column-foot [data-action="open-${previous === 'captures' ? 'history' : previous}"]`)
      : this.p.shell.querySelector<HTMLElement>(`#${tab}-title`))?.focus({ preventScroll: true });
    // The Server tab asks the service for its extra reads (detail=server); poll now rather than at the next tick.
    if (tab === 'server') void this.onRefreshNeeded();
  }
  onRefreshNeeded: () => Promise<void> = async () => {};
  onMeasurementScope: (scope: 'chat' | 'engine') => void = () => {};
  private readonly onChange = (event: Event): void => {
    const target = event.target as HTMLSelectElement;
    if (target.dataset.action === 'measurement-scope' && (target.value === 'chat' || target.value === 'engine')) {
      this.onMeasurementScope(target.value);
      this.render();
    }
  };

  private disclose(button: HTMLElement): void {
    const id = button.getAttribute('aria-controls')!, open = this.p.state.open, next = !open.has(id);
    if (button.dataset.disclose === 'info') for (const other of Array.from(open)) if (other.startsWith('pop-')) open.delete(other);
    if (next) open.add(id); else open.delete(id);
    this.render();
  }
  private readonly onClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement;
    const disclose = target.closest<HTMLElement>('[data-disclose]');
    if (disclose) { this.disclose(disclose); return; }
    // History and Captures have their own delegated controls and share only the frame-owned controller.
    if (target.closest('.view-host')) return;
    const media = target.closest<HTMLElement>('[data-media-action]');
    if (media) {
      const key = media.dataset.job!, action = media.dataset.mediaAction;
      if (action === 'cancel') { this.p.mediaJobs.requestCancel(key); this.p.shell.querySelector<HTMLElement>('[data-media-action="dismiss"]')?.focus(); }
      else if (action === 'confirm') void this.p.mediaJobs.cancel(key);
      else if (action === 'dismiss') this.p.mediaJobs.dismissCancel();
      return;
    }
    const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action) this.act(action);
  };
  private act(action: string): void {
    const { pipeline, state, connections } = this.p;
    if (action === 'open-media') {
      this.select('live', false);
      const block = this.node('view-media');
      if (!block.hidden) { block.scrollIntoView({ block: 'nearest' }); block.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true }); }
      return;
    }
    if (action === 'open-history') { this.select('history', true); return; }
    if (action === 'chat-setup') { connections.openSetup(); this.node('companion-title').focus({ preventScroll: true }); this.node('companion-title').scrollIntoView({ block: 'nearest' }); return; }
    if (action === 'open-server') { this.select('server', true); return; }
    if (action === 'open-captures') { this.select('captures', true); return; }
    if (action === 'back-live') { this.select('live', true); return; }
    if (action === 'back-history') { this.select('history', true); return; }
    if (action === 'connection') connections.openSetup();
    else if (action === 'switch') { const detected = state.snapshot?.status.params.detected; if (typeof detected === 'string') connections.switchRuntime(detected as never); }
    else if (action === 'next-arm') pipeline.arm(state.snapshot);
    else if (action === 'watch') this.watch();
    else if (action === 'next-cancel') pipeline.cancel();
    else if (action === 'window-cancel') {
      this.views.get('captures')?.handle.cancelCapture?.();
      this.p.status('Timed recording stopped. The partial recording is available in Captures.');
      const focus = state.compact && !this.wide ? this.p.shell.querySelector<HTMLElement>('#monitor-menu > summary')
        : state.tab === 'live' ? this.p.shell.querySelector<HTMLElement>('#column-foot button') : this.p.shell.querySelector<HTMLElement>(`#${state.tab}-title`);
      focus?.focus({ preventScroll: true });
    }
    else if (action === 'next-save') void this.saveNext();
    else if (action === 'expand') { state.compact = false; this.onCompact(false); }
    this.render();
  }
  onCompact: (value: boolean) => void = () => {};
  private async saveNext(): Promise<void> {
    const next = this.p.pipeline.nextState;
    if (next.kind !== 'result') return;
    try {
      await new CaptureStore(this.p.host.storage).save(nextReplyCapture(next, this.p.state.snapshot?.connection.runtime ?? null, this.p.client.now()));
      this.p.status('Saved to Captures. Model names are never stored with a capture.');
    } catch { this.p.status('Could not save this reply to Captures. It is still shown here.'); }
  }
  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      const open = Array.from(this.p.state.open).find(id => id.startsWith('pop-'));
      if (!open) return;
      this.p.state.open.delete(open);
      this.render();
      this.p.shell.querySelector<HTMLElement>(`[aria-controls="${open}"]`)?.focus({ preventScroll: true });
    }
  };
  /** <details> the reader opens or closes (Mac details, the approval list) keep that state across polls. */
  private readonly onToggle = (event: Event): void => {
    const details = event.target as HTMLDetailsElement;
    if (!(details instanceof HTMLDetailsElement) || !details.id || details.id === 'monitor-menu' || details.id === 'connection-help') return;
    if (details.open) this.p.state.open.add(details.id); else this.p.state.open.delete(details.id);
  };
  /** Views other tracks mounted are told the frame is going away. */
  dispose(): void {
    this.digits.dispose(); this.motion.dispose();
    this.p.shell.removeEventListener('click', this.onClick); this.p.shell.removeEventListener('keydown', this.onKey); this.p.shell.removeEventListener('toggle', this.onToggle, true);
    this.p.shell.removeEventListener('change', this.onChange);
    this.media?.removeEventListener('change', this.onLayout);
    for (const { handle } of this.views.values()) try { handle.dispose(); } catch { /* see view() */ }
    this.views.clear();
  }
}

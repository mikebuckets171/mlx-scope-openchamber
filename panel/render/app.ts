import type { HostClient } from '@openchamber/sdk';
import type { SnapshotV2 } from '../../src/contract/snapshot.ts';
import type { ConnectionsView } from '../connections-view.ts';
import { CaptureStore } from '../captures/store.ts';
import type { SnapshotClient } from '../data/client.ts';
import { FRAME_TITLE, NO_FRESH, NO_FRESH_DETAIL } from '../present/copy.ts';
import { frameCard, presentHeader } from '../present/header.ts';
import { presentLive, weightedTps } from '../present/live.ts';
import type { Callout } from '../present/parts.ts';
import type { ScopeInput } from '../present/scope.ts';
import { presentServer } from '../present/server.ts';
import { presentStatusSection } from '../present/status.ts';
import type { Pipeline } from '../state/pipeline.ts';
import type { ScopeState } from '../state/scope-state.ts';
import { html, morph } from './html.ts';
import { frameCardMarkup, PAGE_TABS, renderHeader, TABS, tabsMarkup } from './shell.ts';
import { liveMarkup } from './views/live.ts';
import { mountSafely } from './views/registry.ts';
import { serverMarkup } from './views/server.ts';
import { statusMarkup } from './views/status.ts';
import type { Tab, ViewHandle } from './views/types.ts';

// The rail panel and the full page (plan §5.9, G2): four tabs Live · Server · History · Captures, the page's two columns
// Live | History at ≥ 900 px, and Compact = the glance. Polls re-render the active view by patching it in place.

export interface AppParts {
  shell: HTMLElement; host: HostClient; state: ScopeState; client: SnapshotClient; pipeline: Pipeline; version: string;
  connections: ConnectionsView; visible: () => boolean; status: (message: string) => void;
}
export class ScopeApp {
  private columns = false;
  private readonly views = new Map<'history' | 'captures', { host: HTMLElement; handle: ViewHandle }>();
  private readonly media = typeof matchMedia === 'function' ? matchMedia('(min-width: 900px)') : null;
  private readonly node = (id: string): HTMLElement => this.p.shell.querySelector<HTMLElement>(`#${id}`)!;
  constructor(private readonly p: AppParts) {
    const shell = p.shell;
    shell.addEventListener('click', this.onClick);
    shell.addEventListener('keydown', this.onKey);
    shell.addEventListener('toggle', this.onToggle, true);
    this.media?.addEventListener('change', this.onLayout);
    this.onLayout();
  }
  private readonly onLayout = (): void => {
    this.columns = this.p.state.surface === 'page' && (this.media?.matches ?? false);
    this.p.shell.dataset.layout = this.columns ? 'columns' : 'tabs';
    if (this.columns && this.p.state.tab === 'history') this.p.state.tab = 'live';
    this.render();
  };

  /** Everything the presenters read, from the state and the pipeline. */
  input(): ScopeInput {
    const { state, pipeline, client, version } = this.p, snapshot = state.snapshot, last = state.lastRequest;
    return {
      now: client.now(), version, snapshot, fresh: snapshot !== null && !state.stale && !state.frame && !state.awaitingFresh, frame: state.frame, stale: state.stale,
      paused: state.userPaused, attribution: pipeline.liveLabel(snapshot), chatRuntime: pipeline.chatRuntime(),
      last: last ? { completion: last, label: pipeline.label(last), vsUsual: null, flag: null } : null,
      next: pipeline.nextState, samples: state.signal.points, turnStartAt: pipeline.window()?.startedAt ?? null,
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
    const s = this.input(), card = frameCard(s), open = state.open, compact = state.compact && !this.columns && !card;
    renderHeader(this.p.shell, presentHeader(s));
    this.p.shell.dataset.compact = String(compact);
    const cardHost = this.node('frame-card');
    morph(cardHost, card ? frameCardMarkup(card) : '');
    this.node('workspace-nav').hidden = !!card || compact;
    this.node('panels').hidden = !!card || compact;
    const glance = this.node('compact-glance');
    glance.hidden = !compact;
    if (compact) {
      morph(glance, statusMarkup(presentStatusSection({ now: s.now, reading: state.latest, snapshot: s.snapshot, attribution: s.attribution, turn: null,
        vsUsual: null, sparkline: null, chatIsLocal: null, expanded: false, tipDismissed: true, fresh: s.fresh, paused: s.paused, next: s.next,
        last: s.last && { completion: s.last.completion, label: s.last.label } }), true));
      return;
    }
    if (card) return;
    const tabs = this.columns ? PAGE_TABS : TABS, active = state.tab;
    morph(this.node('tablist'), tabsMarkup(tabs, active));
    for (const [tab] of TABS) this.node(`panel-${tab}`).hidden = tab !== active;
    const livePanel = this.node('panel-live');
    livePanel.classList.toggle('page-cols', this.columns);
    livePanel.classList.toggle('view', !this.columns);
    if (active === 'live') {
      const extra = this.extra(s), body = liveMarkup(presentLive(s, extra), open);
      morph(livePanel, this.columns
        ? html`<div class="view page-live" id="col-live"><div class="col-title"><h2>Live</h2><span>90 s · this chat when inferred</span></div>${body}</div><div class="view" id="col-history" data-mount></div>`
        : s.snapshot || s.frame ? body : html`<p class="empty" id="waiting">Waiting for the first reading.</p>`);
    }
    if (active === 'server') morph(this.node('panel-server'), serverMarkup(presentServer(s.snapshot, s.now, this.extra(s)), open));
    if (active === 'history' || this.columns && active === 'live') this.view('history', this.columns ? this.node('col-history') : this.node('panel-history'), s.snapshot);
    if (active === 'captures') this.view('captures', this.node('panel-captures'), s.snapshot);
  }
  /** History and Captures are other tracks' views: mounted once into a stable host that moves between layouts. */
  private view(tab: 'history' | 'captures', container: HTMLElement, snapshot: SnapshotV2 | null): void {
    let entry = this.views.get(tab);
    if (!entry) {
      const host = document.createElement('div');
      host.className = 'view-host';
      entry = { host, handle: mountSafely(tab, host, { host: this.p.host, surface: this.p.state.surface === 'page' ? 'page' : 'panel', now: () => this.p.client.now(),
        visible: () => this.p.visible() && (this.p.state.tab === tab || tab === 'history' && this.columns), leader: () => this.p.state.snapshot?.lease.leader ?? false }) };
      this.views.set(tab, entry);
    }
    if (entry.host.parentElement !== container) container.append(entry.host);
    try { entry.handle.update(snapshot); } catch { /* another track's view never stops this one */ }
  }

  private select(tab: Tab, focus: boolean): void {
    const { state } = this.p;
    if (state.tab === tab) return;
    state.tab = tab;
    this.render();
    if (focus) this.node(`tab-${tab}`).focus({ preventScroll: true });
    // The Server tab asks the service for its extra reads (detail=server); poll now rather than at the next tick.
    if (tab === 'server') void this.onRefreshNeeded();
  }
  onRefreshNeeded: () => Promise<void> = async () => {};

  private disclose(button: HTMLElement): void {
    const id = button.getAttribute('aria-controls')!, open = this.p.state.open, next = !open.has(id);
    if (button.dataset.disclose === 'info') for (const other of Array.from(open)) if (other.startsWith('pop-')) open.delete(other);
    if (next) open.add(id); else open.delete(id);
    this.render();
  }
  private readonly onClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement, tab = target.closest<HTMLElement>('[role="tab"]');
    if (tab?.dataset.tab) { this.select(tab.dataset.tab as Tab, false); return; }
    const disclose = target.closest<HTMLElement>('[data-disclose]');
    if (disclose) { this.disclose(disclose); return; }
    const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action) this.act(action);
  };
  private act(action: string): void {
    const { pipeline, state, connections } = this.p;
    if (action === 'connection') connections.openSetup();
    else if (action === 'switch') { const detected = state.snapshot?.status.params.detected; if (typeof detected === 'string') connections.switchRuntime(detected as never); }
    else if (action === 'next-arm') pipeline.arm(state.snapshot);
    else if (action === 'next-cancel') pipeline.cancel();
    else if (action === 'next-save') void this.saveNext();
    else if (action === 'expand') { state.compact = false; this.onCompact(false); }
    this.render();
  }
  onCompact: (value: boolean) => void = () => {};
  private async saveNext(): Promise<void> {
    const next = this.p.pipeline.nextState;
    if (next.kind !== 'result') return;
    const rate = weightedTps(next.steps), output = next.steps.reduce((sum, step) => sum + (step.outputTokens ?? 0), 0);
    try {
      await new CaptureStore(this.p.host.storage).save({ v: 2, savedAt: this.p.client.now(), kind: 'next-reply', runtime: this.p.state.snapshot?.connection.runtime ?? null,
        label: 'armed', measurements: { ...rate !== null ? { decodeTps: rate } : {}, outputTokens: output, wallMs: next.endedAt - next.startedAt }, state: 'finished' });
      this.p.status('Saved to Captures. Model names are never stored with a capture.');
    } catch { this.p.status('Could not save this reply to Captures. It is still shown here.'); }
  }
  private readonly onKey = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement;
    if (event.key === 'Escape') {
      const open = Array.from(this.p.state.open).find(id => id.startsWith('pop-'));
      if (!open) return;
      this.p.state.open.delete(open);
      this.render();
      this.p.shell.querySelector<HTMLElement>(`[aria-controls="${open}"]`)?.focus({ preventScroll: true });
      return;
    }
    if (target.getAttribute('role') !== 'tab' || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = (this.columns ? PAGE_TABS : TABS).map(([id]) => id), index = tabs.indexOf(this.p.state.tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length;
    this.select(tabs[next]!, true);
  };
  /** <details> the reader opens or closes (Mac details, the approval list) keep that state across polls. */
  private readonly onToggle = (event: Event): void => {
    const details = event.target as HTMLDetailsElement;
    if (!(details instanceof HTMLDetailsElement) || !details.id || details.id === 'monitor-menu' || details.id === 'connection-help') return;
    if (details.open) this.p.state.open.add(details.id); else this.p.state.open.delete(details.id);
  };
  /** Views other tracks mounted are told the frame is going away. */
  dispose(): void {
    this.media?.removeEventListener('change', this.onLayout);
    for (const { handle } of this.views.values()) try { handle.dispose(); } catch { /* see view() */ }
    this.views.clear();
  }
}

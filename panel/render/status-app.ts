import type { HostClient, SessionSnapshot } from '@openchamber/sdk';
import type { TrendV2 } from '../../src/contract/trend.ts';
import type { SnapshotClient } from '../data/client.ts';
import { HistoryClient } from '../data/history.ts';
import type { PrefsV2 } from '../preferences.ts';
import { presentStatusSection } from '../present/status.ts';
import type { Pipeline } from '../state/pipeline.ts';
import type { ScopeState } from '../state/scope-state.ts';
import { morph } from './html.ts';
import { statusMarkup } from './views/status.ts';

// The Work Status section (surface 'status', same bundle; plan §5.8, owner decision 13): the glance at 56/80/24 px or
// the Turn stats replacement at ≤ 200 px, sized with setHeight. Glance tier; it can lead, so it may record and toast.

/** The 15 min sparkline comes from the service trend, refreshed at most this often while the section is visible. */
export const SPARKLINE_EVERY_MS = 30_000;
export interface StatusParts { root: HTMLElement; host: HostClient; state: ScopeState; client: SnapshotClient; pipeline: Pipeline; prefs: PrefsV2; visible: () => boolean }

/** A chat is local when its provider is the monitored connection or another local connection the service lists. */
export const chatIsLocal = (session: SessionSnapshot | null, connection: { id: string; choices: ReadonlyArray<{ id: string }> } | null): boolean | null => {
  const provider = session?.model?.split('/')[0];
  if (!provider || !connection) return null;
  return provider === connection.id || connection.choices.some(choice => choice.id === provider);
};

export class StatusApp {
  private height = 0;
  private trend: TrendV2 | null = null;
  private trendAt = -Infinity;
  private session: SessionSnapshot | null = null;
  private readonly history: HistoryClient;
  private readonly unsubscribe: () => void;
  constructor(private readonly p: StatusParts, session: SessionSnapshot | null) {
    this.session = session;
    this.history = new HistoryClient(p.host);
    this.unsubscribe = p.host.onSession(next => { this.session = next; this.render(); });
    p.root.addEventListener('click', this.onClick);
  }
  render(): void {
    const { state, pipeline, prefs, client } = this.p, snapshot = state.snapshot, pref = prefs.value, last = state.lastRequest;
    if (state.disposed || !state.mounted) return;
    this.refreshTrend();
    const view = presentStatusSection({
      now: client.now(), reading: state.latest, snapshot, attribution: pipeline.liveLabel(snapshot), turn: pipeline.turn(), vsUsual: null,
      sparkline: this.trend, chatIsLocal: chatIsLocal(this.session, snapshot?.connection ?? null), expanded: pref.statusExpanded === true,
      tipDismissed: pref.tipDismissed === true, fresh: snapshot !== null && !state.stale && !state.frame && !state.awaitingFresh, paused: state.userPaused,
      last: last ? { completion: last, label: pipeline.label(last) } : null, next: pipeline.nextState, window: pipeline.window(),
      firstRun: pipeline.firstRun, firstRunDismissed: pref.firstRunDismissed === true,
    });
    morph(this.p.root, statusMarkup(view));
    if (view.height !== this.height) { this.height = view.height; void this.p.host.setHeight(view.height).catch(() => {}); }
  }
  /** Only while visible, and never faster than every 30 s; a failed or unserved read leaves "Chart starts after 2 readings". */
  private refreshTrend(): void {
    const now = Date.now(), snapshot = this.p.state.snapshot;
    if (!this.p.visible() || !snapshot || now - this.trendAt < SPARKLINE_EVERY_MS) return;
    this.trendAt = now;
    const connection = snapshot.connection;
    void this.history.trend({ ...connection.id !== 'auto' ? { provider: connection.id } : {}, windowMs: 900_000, series: ['decodeTps'] })
      .then(result => { if (result.ok) { this.trend = result.body; this.render(); } }).catch(() => {});
  }
  private readonly onClick = (event: MouseEvent): void => {
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action, prefs = this.p.prefs;
    if (!action) return;
    if (action === 'status-toggle') void prefs.set({ statusExpanded: prefs.value.statusExpanded !== true }).catch(() => {});
    else if (action === 'dismiss-tip') void prefs.set({ tipDismissed: true }).catch(() => {});
    else if (action === 'dismiss-first-run') void prefs.set({ firstRunDismissed: true }).catch(() => {});
    else if (action === 'next-cancel') this.p.pipeline.cancel();
    this.render();
    this.p.root.querySelector<HTMLElement>(`[data-action="${action}"]`)?.focus({ preventScroll: true });
  };
  dispose(): void { this.unsubscribe(); this.p.root.removeEventListener('click', this.onClick); }
}

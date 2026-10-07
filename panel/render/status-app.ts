import type { HostClient, SessionSnapshot } from '@openchamber/sdk';
import type { SnapshotClient } from '../data/client.ts';
import type { PrefsV2 } from '../preferences.ts';
import { presentSessionSection } from '../present/session.ts';
import type { Pipeline } from '../state/pipeline.ts';
import type { ScopeState } from '../state/scope-state.ts';
import { morph } from './html.ts';
import { sessionMarkup } from './views/session.ts';

// The Session summary (surface 'status') stays compact; its text action opens the full Scope panel.
// Glance tier; it can lead, so it may record and toast.

export interface StatusParts { root: HTMLElement; host: HostClient; state: ScopeState; client: SnapshotClient; pipeline: Pipeline; prefs: PrefsV2; visible: () => boolean }

/** A chat is local when its provider is the monitored connection or another local connection the service lists. */
export const chatIsLocal = (session: SessionSnapshot | null, connection: { id: string; choices: ReadonlyArray<{ id: string }> } | null): boolean | null => {
  const provider = session?.model?.split('/')[0];
  if (!provider || !connection) return null;
  return provider === connection.id || connection.choices.some(choice => choice.id === provider);
};

export class StatusApp {
  private height = 0;
  private session: SessionSnapshot | null = null;
  private actionError: string | null = null;
  private readonly unsubscribe: () => void;
  constructor(private readonly p: StatusParts, session: SessionSnapshot | null) {
    this.session = session;
    this.unsubscribe = p.host.onSession(next => { this.session = next; this.render(); });
    p.root.addEventListener('click', this.onClick);
  }
  render(): void {
    const { state, pipeline, prefs, client } = this.p, snapshot = state.snapshot, pref = prefs.value, last = state.lastRequest;
    if (state.disposed || !state.mounted) return;
    const view = presentSessionSection({
      now: client.now(), reading: state.latest, snapshot, attribution: pipeline.liveLabel(snapshot), turn: pipeline.turn(),
      vsUsual: last ? pipeline.usualFor(last, snapshot?.connection.runtime ?? null).vsUsual : null,
      sparkline: null, chatIsLocal: chatIsLocal(this.session, snapshot?.connection ?? null), expanded: pref.statusExpanded === true,
      tipDismissed: pref.tipDismissed === true, fresh: snapshot !== null && !state.stale && !state.frame && !state.awaitingFresh, paused: state.userPaused, efficient: state.efficient,
      last: last ? { completion: last, label: pipeline.label(last) } : null, next: pipeline.nextState, window: pipeline.window(),
      firstRun: pipeline.firstRun, firstRunDismissed: pref.firstRunDismissed === true,
    });
    const actionError = view.mode === 'summary' ? this.actionError : null;
    const height = view.height + (actionError ? 30 - (view.note ? 30 : 0) : 0);
    morph(this.p.root, sessionMarkup({ ...view, height, note: actionError ? null : view.note }, actionError));
    if (height !== this.height) { this.height = height; void this.p.host.setHeight(height).catch(() => {}); }
  }
  private readonly onClick = (event: MouseEvent): void => {
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action, prefs = this.p.prefs;
    if (!action) return;
    if (action === 'open-scope') {
      this.actionError = null;
      void this.p.host.openSurface('plugin:mlx-scope').catch(() => {
        this.actionError = 'Could not open Scope. Use its icon in the side panel.';
        this.render();
      });
    }
    else if (action === 'dismiss-tip') void prefs.set({ tipDismissed: true }).catch(() => {});
    else if (action === 'dismiss-first-run') void prefs.set({ firstRunDismissed: true }).catch(() => {});
    else if (action === 'next-cancel') this.p.pipeline.cancel();
    this.render();
    this.p.root.querySelector<HTMLElement>(`[data-action="${action}"]`)?.focus({ preventScroll: true });
  };
  dispose(): void { this.unsubscribe(); this.p.root.removeEventListener('click', this.onClick); }
}

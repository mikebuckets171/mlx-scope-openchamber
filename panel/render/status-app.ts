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

/** Only the configured local choices prove locality; an error response may echo an unknown provider id. */
export const chatIsLocal = (session: SessionSnapshot | null, connection: { id: string; choices: ReadonlyArray<{ id: string }> } | null): boolean | null => {
  const provider = session?.model?.split('/')[0];
  if (!provider || !connection) return null;
  return connection.choices.some(choice => choice.id === provider);
};

export class StatusApp {
  private height = 0;
  private session: SessionSnapshot | null = null;
  private actionError: string | null = null;
  private readonly resize: ResizeObserver | null;
  private readonly unsubscribe: () => void;
  constructor(private readonly p: StatusParts, session: SessionSnapshot | null) {
    this.session = session;
    this.unsubscribe = p.host.onSession(next => {
      if (!this.sameSession(next)) this.actionError = null;
      this.session = next; this.render();
    });
    p.root.addEventListener('click', this.onClick);
    p.root.addEventListener('change', this.onChange);
    this.resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.fitHeight());
    this.resize?.observe(p.root);
  }
  render(): void {
    const { state, pipeline, prefs, client } = this.p, snapshot = state.snapshot, pref = prefs.value, last = state.lastRequest, window = pipeline.window();
    if (state.disposed || !state.mounted) return;
    const view = presentSessionSection({
      now: client.now(), reading: state.latest, snapshot, attribution: pipeline.liveLabel(snapshot),
      chatIsLocal: chatIsLocal(this.session, snapshot?.connection ?? null),
      fresh: snapshot !== null && !state.stale && !state.frame && !state.awaitingFresh, paused: state.userPaused, efficient: state.efficient,
      last: last ? { completion: last, label: pipeline.label(last) } : null, next: pipeline.nextState, window,
      measurementScope: pref.measurementScope ?? 'chat', sessionModel: this.session?.model ?? null, chatActivity: this.session ? window?.endedAt === null || this.session.busy ? 'busy' : 'idle' : null,
      lastChat: state.lastChat,
    });
    const actionError = this.actionError;
    morph(this.p.root, sessionMarkup(view, actionError));
    const select = this.p.root.querySelector<HTMLSelectElement>('[data-action="measurement-scope"]');
    if (select && select.value !== view.measurementScope) select.value = view.measurementScope;
    this.fitHeight();
  }
  /** Measure content so increased text size never clips the host's fixed-height iframe. */
  private fitHeight(): void {
    const height = Math.ceil(this.p.root.getBoundingClientRect().height);
    if (height > 0 && height !== this.height) { this.height = height; void this.p.host.setHeight(height).catch(() => {}); }
  }
  onMeasurementScope: (scope: 'chat' | 'engine') => void = () => {};
  private sameSession(session: SessionSnapshot | null): boolean {
    return session?.id === this.session?.id && session?.model === this.session?.model;
  }
  reportPreferenceFailure(): void {
    this.actionError = 'Changed here; could not save.';
    this.render();
  }
  private readonly onChange = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement) || target.dataset.action !== 'measurement-scope') return;
    const scope = target.value === 'engine' ? 'engine' : 'chat';
    this.actionError = null;
    this.onMeasurementScope(scope);
    this.render();
  };
  private readonly onClick = (event: MouseEvent): void => {
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'open-scope') {
      this.actionError = null;
      const session = this.session;
      void this.p.host.openSurface('plugin:mlx-scope').catch(() => {
        if (!this.sameSession(session)) return;
        this.actionError = 'Could not open Scope. Use the side icon.';
        this.render();
      });
    }
    else if (action === 'next-cancel') this.p.pipeline.cancel();
    this.render();
    this.p.root.querySelector<HTMLElement>(`[data-action="${action}"]`)?.focus({ preventScroll: true });
  };
  dispose(): void { this.unsubscribe(); this.resize?.disconnect(); this.p.root.removeEventListener('click', this.onClick); this.p.root.removeEventListener('change', this.onChange); }
}

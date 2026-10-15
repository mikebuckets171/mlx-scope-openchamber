import type { MediaController } from '../media/controller.ts';
import { mediaGlanceMarkup } from '../media/view.ts';
import { DigitRoll } from './digit-roll.ts';
import { beatKey, Motion } from './motion.ts';
import { html } from './html.ts';
import { liveChart } from './chart.ts';
import type { HostClient, SessionSnapshot } from '../host/types.ts';
import type { SnapshotClient } from '../data/client.ts';
import type { PrefsV2 } from '../preferences.ts';
import { presentSessionSection } from '../present/session.ts';
import type { Pipeline } from '../state/pipeline.ts';
import type { ScopeState } from '../state/scope-state.ts';
import { morph } from './html.ts';
import { measurementLabel, sessionMarkup } from './views/session.ts';
import { openReadingCard, readingCard, type ReadingCard } from '../next/popover.ts';
import type { HostFeatures } from '../host/types.ts';

// The Session summary (surface 'status') stays compact; its text action opens the full Scope panel.
// Glance tier; it can lead, so it may record and toast.

export interface StatusParts { root: HTMLElement; host: HostClient; state: ScopeState; client: SnapshotClient; pipeline: Pipeline; prefs: PrefsV2; mediaJobs: MediaController; visible: () => boolean }

/** Only the configured local choices prove locality; an error response may echo an unknown provider id. */
export const chatIsLocal = (session: SessionSnapshot | null, connection: { id: string; choices: ReadonlyArray<{ id: string }> } | null): boolean | null => {
  const provider = session?.model?.split('/')[0];
  if (!provider || !connection) return null;
  return connection.choices.some(choice => choice.id === provider);
};

export class StatusApp {
  #height = 0;
  #digits: DigitRoll;
  #motion: Motion;
  #session: SessionSnapshot | null = null;
  #actionError: string | null = null;
  #resize: ResizeObserver | null;
  #unsubscribe: () => void;
  #stopReady: () => void;
  #features: HostFeatures = {};
  #directory: string | null | undefined;
  #headerKey = '';
  #card: ReadingCard | null = null;
  #p: StatusParts;
  constructor(p: StatusParts, session: SessionSnapshot | null) {
    this.#p = p;
    this.#session = session;
    this.#digits = new DigitRoll(p.root);
    this.#motion = new Motion(p.root);
    this.#stopReady = p.host.onReady(ready => {
      if (this.#directory !== ready.directory) { this.#directory = ready.directory; this.#headerKey = ''; }
      this.#features = ready.features ?? {};
      this.render();
    });
    this.#unsubscribe = p.host.onSession(next => {
      if (!this.#sameSession(next)) this.#actionError = null;
      this.#session = next; this.render();
    });
    p.root.addEventListener('click', this.#onClick);
    p.root.addEventListener('change', this.#onChange);
    p.root.addEventListener('keydown', this.#onKey);
    this.#resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.#fitHeight());
    this.#resize?.observe(p.root);
  }
  render(): void {
    const { state, pipeline, prefs, client } = this.#p, snapshot = state.snapshot, pref = prefs.value, last = state.lastRequest, window = pipeline.window();
    if (state.disposed || !state.mounted) return;
    this.#p.root.dataset.mediaMotion = String(this.#p.visible() && !state.userPaused);
    const view = presentSessionSection({
      now: client.now(), reading: state.latest, snapshot, attribution: pipeline.liveLabel(snapshot),
      chatIsLocal: chatIsLocal(this.#session, snapshot?.connection ?? null),
      fresh: snapshot !== null && !state.stale && !state.frame && !state.awaitingFresh, paused: state.userPaused, efficient: state.efficient,
      last: last ? { completion: last, label: pipeline.label(last) } : null, next: pipeline.nextState, window,
      measurementScope: pref.measurementScope ?? 'chat', sessionModel: this.#session?.model ?? null,
      chatActivity: this.#session ? window?.endedAt === null || this.#session.busy === true ? 'busy' : this.#session.busy === false ? 'idle' : null : null,
      lastChat: state.lastChat, restingFacts: true,
    });
    const actionError = this.#actionError, next = document.documentElement.dataset.designMode === 'next';
    this.#p.mediaJobs.sync(this.#p.visible() && !state.userPaused && state.frame?.reason !== 'needs_approval');
    const chart = next && view.measurement?.live && view.measurement.kind === 'speed' && view.measurement.label.startsWith('Engine')
      ? liveChart(state.signal.points, client.now(), null, snapshot?.connection.runtime === 'splash' ? 'server' : 'request') : null;
    const readingWasFocused = this.#p.root.querySelector('.ws-measurement') === document.activeElement;
    const media = mediaGlanceMarkup(this.#p.mediaJobs, this.#session?.id ?? null, client.now(), true);
    morph(this.#p.root, next
      ? sessionMarkup(view, actionError, false, true, { chart, media, paused: state.userPaused })
      : html`${sessionMarkup(view, actionError)}${media}`);
    this.#card = next ? readingCard(view, snapshot?.runtime.sampledAt ?? client.now()) : null;
    this.#headers();
    const reading = this.#p.root.querySelector<HTMLElement>('.ws-measurement');
    if (reading && !reading.hidden && next && this.#features.popovers) {
      reading.tabIndex = 0; reading.setAttribute('role', 'button'); reading.dataset.action = 'reading-details';
      reading.setAttribute('aria-label', view.measurement ? `Measurement details: ${view.measurement.text}${view.measurement.unit ? ` ${view.measurement.unit}` : ''} · ${measurementLabel(view.measurement, true)}` : 'Measurement details');
    }
    if (readingWasFocused && reading?.hidden) this.#p.root.querySelector<HTMLElement>('[data-action="open-scope"]')?.focus({ preventScroll: true });
    this.#digits.sync(`${state.generation}/${this.#session?.id ?? ''}/${this.#session?.model ?? ''}/${snapshot?.connection.id ?? ''}/${snapshot?.connection.generation ?? ''}/${snapshot?.runtime.phase ?? ''}/${window?.startedAt ?? ''}/${snapshot?.chat?.phase ?? ''}`, this.#p.visible() && !state.stale && !state.frame && !state.awaitingFresh && !state.userPaused && !next);
    const fresh = snapshot !== null && !state.stale && !state.frame && !state.awaitingFresh && !state.userPaused;
    this.#motion.sync(this.#p.visible() && !state.userPaused, fresh ? beatKey(this.#p.root, snapshot, next) : null);
    const select = this.#p.root.querySelector<HTMLSelectElement>('[data-action="measurement-scope"]');
    if (select && select.value !== view.measurementScope) select.value = view.measurementScope;
    this.#fitHeight();
  }
  /** Measure content so increased text size never clips the host's fixed-height iframe. */
  #fitHeight(): void {
    const root = this.#p.root, chart = root.querySelector<HTMLElement>('.ws-signal'), content = root.querySelector<HTMLElement>('.ws-scroll');
    // The reading, warning and media take priority. The full-view action sits outside the scrollable content.
    if (chart?.querySelector('svg') && content) { chart.hidden = false; if (content.scrollHeight > content.clientHeight + 1) chart.hidden = true; }
    const height = Math.min(320, Math.ceil(root.getBoundingClientRect().height));
    if (height > 0 && height !== this.#height) { this.#height = height; void this.#p.host.setHeight(height).catch(() => {}); }
  }
  onMeasurementScope: (scope: 'chat' | 'engine') => void = () => {};
  onPauseChanged: () => void = () => {};
  #headers(): void {
    const { host } = this.#p;
    if (!host.setStatusControls || !this.#features.statusControls || this.#headerKey) return;
    // 2.3.3 puts three host controls in a two-column grid and truncates selects at 5rem.
    // Keep this small control group together inside the guest; clear any earlier host binding.
    this.#headerKey = 'cleared';
    void host.setStatusControls([]).catch(() => {});
  }
  #details(): void {
    const anchor = this.#p.root.querySelector<HTMLElement>('.ws-measurement:not([hidden])') ?? this.#p.root.querySelector<HTMLElement>('#ws');
    if (anchor && this.#features.popovers && this.#card) {
      anchor.focus();
      void openReadingCard(this.#p.host, anchor, this.#card).catch(() => this.#openScope());
    } else this.#openScope();
  }
  #openScope(): void {
    void this.#p.host.openSurface('plugin:mlx-scope').catch(() => { this.#actionError = 'Could not open Scope. Use the side icon.'; this.render(); });
  }
  #onKey = (event: KeyboardEvent): void => {
    if ((event.key === 'Enter' || event.key === ' ') && (event.target as HTMLElement)?.dataset.action === 'reading-details') {
      event.preventDefault(); this.#details();
    }
  };
  #sameSession(session: SessionSnapshot | null): boolean {
    return session?.id === this.#session?.id && session?.model === this.#session?.model;
  }
  reportPreferenceFailure(): void {
    this.#actionError = 'Changed here; could not save.';
    this.render();
  }
  #onChange = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement) || target.dataset.action !== 'measurement-scope') return;
    const scope = target.value === 'engine' ? 'engine' : 'chat';
    this.#actionError = null;
    this.onMeasurementScope(scope);
    this.render();
  };
  #onClick = (event: MouseEvent): void => {
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'reading-details') { this.#details(); return; }
    if (action === 'pause') { this.#p.state.userPaused = !this.#p.state.userPaused; this.onPauseChanged(); }
    if (action === 'open-scope') {
      this.#actionError = null;
      const session = this.#session;
      void this.#p.host.openSurface('plugin:mlx-scope').catch(() => {
        if (!this.#sameSession(session)) return;
        this.#actionError = 'Could not open Scope. Use the side icon.';
        this.render();
      });
    }
    else if (action === 'next-cancel') this.#p.pipeline.cancel();
    this.render();
    this.#p.root.querySelector<HTMLElement>(`[data-action="${action}"]`)?.focus({ preventScroll: true });
  };
  dispose(): void { this.#stopReady(); this.#headerKey = ''; void this.#p.host.setStatusControls?.([]).catch(() => {}); this.#digits.dispose(); this.#motion.dispose(); this.#unsubscribe(); this.#resize?.disconnect(); this.#p.root.removeEventListener('click', this.#onClick); this.#p.root.removeEventListener('change', this.#onChange); this.#p.root.removeEventListener('keydown', this.#onKey); }
}

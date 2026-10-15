import { connectHost, HostRequestError, isHostRequestErrorCode, type HostClient as SDKHost } from '@openchamber/sdk';
import type { HostClient, HostReadyContext, SessionLifecycleEvent, SessionSnapshot } from './types.ts';

export { HostRequestError, isJsonValue } from '@openchamber/sdk';
export const hostErrorCode = (error: unknown): string | null => error instanceof HostRequestError && isHostRequestErrorCode(error.code) ? error.code : null;

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const emit = <T>(listeners: Set<(value: T) => void>, value: T): void => {
  // Preserve SDK isolation: a failed view listener cannot starve monitoring or the remaining views.
  for (const listener of [...listeners]) { try { listener(value); } catch (error) { console.error(error); } }
};
/** Keep an unidentified chat distinct from no chat. Neither its title nor other host fields enter Scope. */
export const sessionOf = (value: unknown): SessionSnapshot | null => {
  if (value === null) return null;
  const raw = record(value);
  return { id: text(raw.id, 256) ? raw.id : '', busy: typeof raw.busy === 'boolean' ? raw.busy : null,
    ...text(raw.model, 1_024) ? { model: raw.model } : {} };
};
const lifecycleOf = (value: unknown): SessionLifecycleEvent | null => {
  const raw = record(value);
  return text(raw.sessionId, 256) && ['started', 'completed', 'failure'].includes(raw.phase as string)
    ? { sessionId: raw.sessionId, phase: raw.phase as SessionLifecycleEvent['phase'] } : null;
};

/** One SDK subscription per event kind. Hidden views retain context, never session callbacks or rendering work. */
export class HostEvents {
  #visible = false;
  #disposed = false;
  #ready: HostReadyContext | null = null;
  #painted = '';
  #session: SessionSnapshot | null | undefined;
  #lifecycle: SessionLifecycleEvent | null = null;
  #readyListeners = new Set<(ready: HostReadyContext) => void>();
  #sessionListeners = new Set<(session: SessionSnapshot | null) => void>();
  #lifecycleListeners = new Set<(event: SessionLifecycleEvent) => void>();
  #stops: Array<() => void> = [];
  #stopReady: () => void;
  #host: Pick<SDKHost, 'onReady' | 'onSession' | 'onSessionLifecycle'>;
  constructor(host: Pick<SDKHost, 'onReady' | 'onSession' | 'onSessionLifecycle'>) {
    this.#host = host;
    this.#stopReady = host.onReady(ready => {
      if (this.#disposed) return;
      const first = this.#ready === null;
      this.#ready = { surface: ready.surface, theme: ready.theme, session: sessionOf(ready.session),
        directory: ready.directory, features: ready.features, popover: ready.popover };
      // Initial hidden frames still mount, but subsequent ready/session replays do no hidden view work.
      if (first || this.#visible) this.#readyChanged();
    });
  }
  #readyChanged(): void {
    const ready = this.#ready;
    if (!ready) return;
    const key = JSON.stringify([ready.surface, ready.theme, ready.directory, ready.features, ready.popover]);
    if (key === this.#painted) return;
    this.#painted = key;
    emit(this.#readyListeners, ready);
  }
  #listen<T>(listeners: Set<(value: T) => void>, value: T | undefined, listener: (value: T) => void): () => void {
    listeners.add(listener);
    if (value !== undefined) listener(value);
    return () => { listeners.delete(listener); };
  }
  onReady = (listener: (ready: HostReadyContext) => void): (() => void) => this.#listen(this.#readyListeners, this.#ready ?? undefined, listener);
  onSession = (listener: (session: SessionSnapshot | null) => void): (() => void) =>
    this.#listen(this.#sessionListeners, this.#visible ? this.#session : undefined, listener);
  onSessionLifecycle = (listener: (event: SessionLifecycleEvent) => void): (() => void) =>
    this.#listen(this.#lifecycleListeners, this.#visible ? this.#lifecycle ?? undefined : undefined, listener);
  #retain(stop: () => void): boolean {
    // A replay can synchronously hide or dispose its consumer before registration returns.
    if (!this.#visible) { stop(); return false; }
    this.#stops.push(stop); return true;
  }
  setVisible(visible: boolean): void {
    if (this.#disposed || visible === this.#visible) return;
    this.#visible = visible;
    if (!visible) {
      for (const stop of this.#stops.splice(0)) stop();
      this.#session = undefined; this.#lifecycle = null;
      return;
    }
    if (!this.#retain(this.#host.onSession(raw => {
      if (!this.#visible) return;
      const session = sessionOf(raw), previous = this.#session;
      if (previous !== undefined && session?.id === previous?.id && session?.busy === previous?.busy && session?.model === previous?.model) return;
      this.#session = session;
      if (this.#ready) this.#ready = { ...this.#ready, session };
      // A lifecycle replay from the preceding chat cannot seed a new subscriber.
      this.#lifecycle = null;
      emit(this.#sessionListeners, session);
    }))) return;
    if (!this.#retain(this.#host.onSessionLifecycle(raw => {
      if (!this.#visible) return;
      const event = lifecycleOf(raw);
      if (!event || event.sessionId === this.#lifecycle?.sessionId && event.phase === this.#lifecycle.phase) return;
      // The SDK derives a ready replay's phase from busy; missing activity must not become a synthetic completion.
      if (event.sessionId === this.#session?.id && this.#session.busy === null) return;
      this.#lifecycle = event;
      emit(this.#lifecycleListeners, event);
    }))) return;
    this.#readyChanged();
  }
  dispose(): void {
    if (this.#disposed) return;
    this.setVisible(false); this.#disposed = true; this.#stopReady();
    this.#readyListeners.clear(); this.#sessionListeners.clear(); this.#lifecycleListeners.clear(); this.#ready = null;
  }
}

export const connectScopeHost = (): HostClient & { setVisible(visible: boolean): void } => {
  const sdk = connectHost(), events = new HostEvents(sdk);
  return { ...sdk, onReady: events.onReady, onSession: events.onSession, onSessionLifecycle: events.onSessionLifecycle,
    onProjects: listener => sdk.onProjects(value => listener({ state: value.state,
      projects: value.projects.slice(0, 32).map(({ id, name, directory }) => ({ id, name: name.slice(0, 120), directory })) })),
    listWorktrees: async id => ({ worktrees: (await sdk.listWorktrees(id)).worktrees.slice(0, 200).map(({ directory }) => ({ directory })) }),
    onSessions: (id, listener) => sdk.onSessions(id, value => listener({ state: value.state,
      sessions: value.sessions.filter(row => row.archivedAt === null).slice(0, 200).map(({ id, title, parentId, activity, outcome, archivedAt }) =>
        ({ id, title: title.slice(0, 120), parentId, activity, outcome, archivedAt })) })),
    onRunningShells: (scope, listener) => sdk.onRunningShells(scope, value => listener({
      shells: value.shells.slice(0, 200).map(({ id, command, startedAt, background }) => ({ id, command: command.slice(0, 240), startedAt, background })),
      ended: value.ended.slice(-200).map(({ id, command, startedAt, background, status, exit }) => ({ id, command: command.slice(0, 240), startedAt, background, status, exit })) })),
    setVisible: visible => events.setVisible(visible), dispose: () => { events.dispose(); sdk.dispose(); } };
};

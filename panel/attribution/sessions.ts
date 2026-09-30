import type { HostClient, SessionLifecycleEvent, SessionSnapshot } from '@openchamber/sdk';
import { tag8 } from '../../src/contract/hash.ts';
import type { SnapshotQuery } from '../../src/contract/query.ts';
import type { MarkPhase } from '../../src/contract/trend.ts';

// Owner: attribution. The open chat as the frame sees it, from onSession + onSessionLifecycle only (S2: no `sessions`
// capability). Replays (×3 on mount and on switch) are ignored; repeats are deduped on (session, phase) changes; events
// are stamped on receipt in service time. Session ids and titles never leave this module: the tag is tag8(id, instance).

export const LIFECYCLE_HOLD_MS = 1_000;      // S2: started leads runtime busy by 0.14–0.20 s; completed within 0.5 s
export const WINDOW_LIMIT = 16;
const MARK_LIMIT = 16;
const TAG_CACHE = 64;

/** A live-observed turn window. `startedAt: null` = joined mid-turn (the first event after mount or switch). */
export interface TurnWindow {
  tag: string; startedAt: number | null; endedAt: number | null;
  /** `null` with an `endedAt`: observation stopped (switch, hide, dispose), not the turn. */
  outcome: 'completed' | 'failure' | null;
  /** The chat's provider and model while the window was open; `model: null` when it changed inside the window. */
  provider?: string | null; model?: string | null;
  joinedAt?: number;                         // a joined window's replay receipt: spans that ended earlier are not in it
}
export interface FrameSessionState {
  connected: boolean;                        // subscribed, and the open chat's phase is known
  /** Service time since which this frame has continuously known the open chat's phase; null while it does not. */
  observedFrom: number | null;
  /** The open chat; `model` is the SDK string, `provider` its provider id. No id, title or folder. */
  chat: { tag: string; provider: string | null; model: string | null; busy: boolean } | null;
  windows: readonly TurnWindow[];            // newest last, ≤ 16
}
export interface SessionFeedOptions { active?: boolean }

/** `providerID/modelID` (SDK); a local provider's modelID may itself contain `/` (SPIKES S2). */
export const splitModel = (value: string | undefined): { provider: string | null; model: string | null } => {
  const slash = value?.indexOf('/') ?? -1;
  if (!value?.trim()) return { provider: null, model: null };
  return slash > 0 && slash < value.length - 1 ? { provider: value.slice(0, slash), model: value.slice(slash + 1) } : { provider: null, model: value };
};

type Window = { id: string; startedAt: number | null; endedAt: number | null; outcome: TurnWindow['outcome'];
  provider: string | null; model: string | null; mixed: boolean; joinedAt: number | null };
type Mark = { phase: MarkPhase; at: number; id: string };
type Chat = { id: string; provider: string | null; model: string | null; busy: boolean };

export class SessionFeed {
  private readonly listeners = new Set<() => void>();
  // Tags for windows before the first snapshot names the service instance; never sent (drainMarks waits for it).
  private readonly salt = `frame\u0000${Math.random().toString(36).slice(2)}`;
  private readonly tags = new Map<string, string>();
  private unsubscribe: Array<() => void> = [];
  private subscribed = false;
  private chat: Chat | null = null;
  private running: boolean | null = null;    // null: no event about this chat since mount, switch or hide
  private observedFrom: number | null = null;
  private windows: Window[] = [];
  private marks: Mark[] = [];
  private lastSession: string | null = null;
  private lastEnd: { window: Window; mark: Mark } | null = null;

  constructor(private readonly host: Pick<HostClient, 'onSession' | 'onSessionLifecycle'>, private readonly now: () => number,
    private readonly instance: () => string | null, options: SessionFeedOptions = {}) {
    if (options.active !== false) this.setActive(true);
  }

  get active(): boolean { return this.subscribed; }

  /**
   * Subscriptions follow the visibility gate (plan §4.4). Subscribing replays the host's last session and phase, which
   * become the baseline; unsubscribing ends observation, so the next turn seen after a resubscribe starts unknown.
   */
  setActive(active: boolean): void {
    if (active === this.subscribed) return;
    this.subscribed = active;
    if (active) {
      this.unsubscribe = [this.host.onSession(session => this.session(session)), this.host.onSessionLifecycle(event => this.lifecycle(event))];
      return;
    }
    for (const stop of this.unsubscribe.splice(0)) stop();
    this.cut(); this.lastSession = null;
    this.emit();
  }

  state(): FrameSessionState {
    const salt = this.instance() ?? this.salt, chat = this.chat;
    return {
      connected: this.subscribed && this.running !== null, observedFrom: this.observedFrom,
      chat: chat && { tag: this.tag(chat.id, salt), provider: chat.provider, model: chat.model, busy: chat.busy },
      windows: this.windows.map(({ id, startedAt, endedAt, outcome, provider, model, mixed, joinedAt }) =>
        ({ tag: this.tag(id, salt), startedAt, endedAt, outcome, provider, model: mixed ? null : model, ...joinedAt === null ? {} : { joinedAt } })),
    };
  }

  /** Marks observed live since the last drain, for `mark=` (never replays). Held until the service instance is known. */
  drainMarks(): SnapshotQuery['marks'] {
    const instance = this.instance();
    if (!instance) return [];
    return this.marks.splice(0).map(({ phase, at, id }) => ({ phase, at: Math.round(at), tag: this.tag(id, instance) }));
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  dispose(): void {
    this.setActive(false);
    this.listeners.clear(); this.windows = []; this.marks = []; this.chat = null; this.tags.clear();
  }

  private tag(id: string, salt: string): string {
    const key = `${salt}\u0000${id}`;
    let tag = this.tags.get(key);
    if (tag === undefined) {
      if (this.tags.size >= TAG_CACHE) this.tags.clear();
      this.tags.set(key, tag = tag8(id, salt));
    }
    return tag;
  }

  private emit(): void { for (const listener of this.listeners) listener(); }

  private session(session: SessionSnapshot | null): void {
    // The host re-sends identical payloads many times (S2); the title is never read.
    const key = session ? JSON.stringify([session.id, session.busy, session.model ?? null]) : '';
    if (key === this.lastSession) return;
    this.lastSession = key;
    if (!session) { this.switchTo(null); this.emit(); return; }
    if (this.chat?.id !== session.id) this.switchTo(session.id);
    const chat = this.chat!, { provider, model } = splitModel(session.model), open = this.open();
    chat.provider = provider; chat.model = model; chat.busy = session.busy;
    if (open && open.provider === null && open.model === null) { open.provider = provider; open.model = model; }
    else if (open && (open.provider !== provider || open.model !== model)) open.mixed = true;
    this.phase(session.id, session.busy, null);
    this.emit();
  }

  private lifecycle(event: SessionLifecycleEvent): void {
    // Lifecycle covers the open chat only; a new id before its onSession is a switch whose model is not known yet.
    if (this.chat?.id !== event.sessionId) this.switchTo(event.sessionId);
    this.phase(event.sessionId, event.phase === 'started', event.phase === 'started' ? null : event.phase);
    this.emit();
  }

  private switchTo(id: string | null): void {
    this.cut();
    this.chat = id === null ? null : { id, provider: null, model: null, busy: false };
  }

  /** Observation stops: an open window ends here with no outcome, and the next event is a baseline again. */
  private cut(): void {
    const open = this.open();
    if (open) open.endedAt = this.now();
    this.running = null; this.observedFrom = null; this.lastEnd = null;
  }

  private open(): Window | null {
    const last = this.windows.at(-1);
    return last && last.endedAt === null ? last : null;
  }

  private phase(id: string, running: boolean, outcome: 'completed' | 'failure' | null): void {
    const at = this.now();
    if (this.running === null) {
      // The first event after mount, switch or hide is a replay: the phase is known, the start is not (joined mid-turn).
      this.running = running; this.observedFrom = at;
      if (running) this.push(id, null, at);
      return;
    }
    if (running === this.running) {
      // A repeat. Only the outcome of an end seen moments ago can still sharpen (idle from onSession, then `failure`).
      const end = this.lastEnd;
      if (!running && outcome && end && end.window.outcome !== outcome && at - end.window.endedAt! <= LIFECYCLE_HOLD_MS) {
        end.window.outcome = outcome;
        if (this.marks.includes(end.mark)) end.mark.phase = outcome;
        else this.lastEnd = { window: end.window, mark: this.mark(outcome, end.window.endedAt!, id) };
      }
      return;
    }
    this.running = running;
    if (running) { this.push(id, at, null); this.lastEnd = null; this.mark('started', at, id); return; }
    const window = this.open(), mark = this.mark(outcome ?? 'completed', at, id);
    if (window) { window.endedAt = at; window.outcome = outcome ?? 'completed'; }
    this.lastEnd = window ? { window, mark } : null;
  }

  private push(id: string, startedAt: number | null, joinedAt: number | null): void {
    const chat = this.chat;
    this.windows.push({ id, startedAt, endedAt: null, outcome: null, provider: chat?.provider ?? null, model: chat?.model ?? null, mixed: false, joinedAt });
    if (this.windows.length > WINDOW_LIMIT) this.windows.shift();
  }

  private mark(phase: MarkPhase, at: number, id: string): Mark {
    const mark = { phase, at, id };
    this.marks.push(mark);
    if (this.marks.length > MARK_LIMIT) this.marks.shift();
    return mark;
  }
}

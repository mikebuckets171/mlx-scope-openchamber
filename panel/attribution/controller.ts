import type { HostClient } from '../host/types.ts';
import type { CompletionV2 } from '../../src/contract/completion.ts';
import type { WithholdReason } from '../../src/contract/reasons.ts';
import type { SnapshotV2 } from '../../src/contract/snapshot.ts';
import type { SnapshotClient, SnapshotQuery } from '../data/client.ts';
import type { Reading } from '../present/reading.ts';
import { ActivityTrack } from './coverage.ts';
import { CLOCK_TOLERANCE_MS, inside, join, joinLive, labelOf, type AttributionLabel, type JoinContext, type JoinVerdict } from './join.ts';
import { LIFECYCLE_HOLD_MS, SessionFeed, type FrameSessionState, type TurnWindow } from './sessions.ts';
import { summarizeTurn, type TurnSummary } from './turn.ts';
import { WireQueue } from './wire.ts';

// Owner: attribution. One frame's attribution: the session feed, the frame's own readings, the auto rule and the wire
// queue, all driven by the frame's polls (no timers, no storage). ui-core wires it (INTERFACES §4.2).

const AVAILABLE = new Set(['ready', 'degraded']);
const RUNNING = new Set(['queued', 'prefill', 'decode', 'processing']);
/**
 * Verdicts about this frame's view rather than the request. The service keeps the first verdict per seq, so a frame
 * that joined late must not pre-empt one that saw the whole turn; a row nobody labels reads "not observed" anyway.
 */
const LOCAL_ONLY = new Set<WithholdReason>(['not-observed', 'joined-mid-turn']);
const KEEP = 256;

export interface AttributionOptions {
  host: Pick<HostClient, 'onSession' | 'onSessionLifecycle'>;
  now: () => number;                         // the service clock (SnapshotClient.now), so stamps and `*At` agree
  auto?: () => boolean;                      // pref attribution.auto; on by default
}
/** A turn of the open chat, for Turn stats and the reply strip. */
export interface TurnView {
  window: TurnWindow;
  label: AttributionLabel;                   // inferred when every step is (armed: stored by Scope 5.0); else the first withheld step's reason
  summary: TurnSummary | null;               // only when every step is attributed
  steps: readonly CompletionV2[];            // with their verdicts
  live: boolean;
}

const verdictOf = (verdict: JoinVerdict, at: number): NonNullable<CompletionV2['verdict']> =>
  verdict.attr === 'inferred' ? { attr: 'inferred', at } : { attr: 'withheld', reason: verdict.reason, at };
const trim = <T>(map: Map<number, T>): void => { for (const key of map.keys()) { if (map.size <= KEEP) break; map.delete(key); } };
/** Every model the runtime names right now. */
export const runtimeModels = (body: SnapshotV2): string[] => [...new Set([body.runtime.request?.model, ...body.runtime.residency.map(item => item.model),
  ...body.runtime.catalog.filter(item => item.loaded).map(item => item.name)].filter((model): model is string => !!model))];

export class Attribution {
  readonly feed: SessionFeed;
  readonly activity = new ActivityTrack();
  #queue = new WireQueue();
  #stopFeed: () => void;
  #instance: string | null = null;
  #body: SnapshotV2 | null = null;
  #visible = true;
  #seen = new Map<number, CompletionV2>();
  #verdicts = new Map<number, JoinVerdict>();
  #pending: CompletionV2[] = [];
  #settled: { key: string; view: TurnView | null } | null = null;

  #options: AttributionOptions;
  constructor(options: AttributionOptions) {
    this.#options = options;
    // Subscribed once a snapshot has synced the service clock, so every lifecycle stamp is in service time.
    this.feed = new SessionFeed(options.host, options.now, () => this.#instance, { active: false });
    this.#stopFeed = () => {};
  }

  frame(): FrameSessionState { return this.feed.state(); }

  /** `mark` / `attr` for the next `/v2/snapshot` (merge into panel/data/client.ts SnapshotQuery). */
  query(): { mark?: string; attr?: string } {
    this.#queue.mark(this.feed.drainMarks());
    return this.#queue.query();
  }

  /** After a 200: what `query()` sent is recorded. On failure nothing is dropped and the next poll resends. */
  acknowledge(): void { this.#queue.acknowledge(); }

  /**
   * One poll through the frame's client with this frame's marks and verdicts added: acknowledged on a parsed body,
   * observed either way. A host error is observed as a failed poll and rethrown for the caller's own handling.
   */
  async read(client: Pick<SnapshotClient, 'read'>, query: SnapshotQuery, cadenceMs = 0): Promise<Reading> {
    const extra = this.query();
    let reading: Reading;
    try { reading = await client.read({ ...query, ...extra }); } catch (error) { this.observe(null); throw error; }
    if (reading.body) this.acknowledge();
    this.observe(reading.body, cadenceMs);
    return reading;
  }

  /** Every poll, with its body (`null` when it failed). `cadenceMs`: the frame's own delay when it exceeds `nextPollMs`. */
  observe(body: SnapshotV2 | null, cadenceMs = 0): void {
    const now = this.#options.now();
    // A failed poll: no reading to label, and the readings so far no longer run up to now.
    if (!body) { this.#body = null; this.activity.observe(null, now); return; }
    if (body.service.instance !== this.#instance) this.#restart(body.service.instance);
    this.#body = body;
    this.activity.observe(body, now, cadenceMs);
    this.feed.setActive(this.#visible);
    const fresh = body.completions.items.filter(item => !this.#seen.has(item.seq));
    for (const item of fresh) this.#seen.set(item.seq, item);
    trim(this.#seen);
    this.#pending.push(...fresh);
    const frame = this.feed.state(), context = this.context(body), sampledAt = body.runtime.sampledAt ?? body.serverNow;
    this.#judge(frame, context, now);
    this.#settle(frame, now, sampledAt);
  }

  /** Visibility gate: a hidden frame breaks its readings and stops listening to the chat. */
  setVisible(visible: boolean): void {
    if (visible === this.#visible) return;
    this.#visible = visible;
    if (!visible) this.activity.break(this.#options.now());
    if (this.#body) this.feed.setActive(visible);
  }

  /** A completion's label: the service's verdict, else this frame's own. */
  label(completion: Pick<CompletionV2, 'seq' | 'verdict'>): AttributionLabel {
    const own = this.#verdicts.get(completion.seq);
    return completion.verdict || !own ? labelOf(completion) : labelOf({ verdict: verdictOf(own, 0) });
  }

  /** Still inside the 1 s hold: `label` reads "not observed" until then, so a presenter may keep the previous one. */
  isPending(seq: number): boolean { return this.#pending.some(item => item.seq === seq); }

  /** The reading in flight, or null when nothing is running. */
  live(): AttributionLabel | null {
    const body = this.#body, active = body?.runtime.server.active;
    if (!body || !AVAILABLE.has(body.status.state) || !(active === null || active === undefined ? RUNNING.has(body.runtime.phase) : active > 0)) return null;
    const verdict = joinLive(this.feed.state(), this.context(body), this.activity.latest() ?? body.serverNow, body.runtime.request?.model ?? null);
    return verdict.attr === 'inferred' ? { kind: 'inferred' } : { kind: 'server-wide', reason: verdict.reason };
  }

  /** The open chat's running turn, else its last settled one; null without a step to show. */
  turn(): TurnView | null {
    const frame = this.feed.state(), chat = frame.chat, open = frame.windows.at(-1);
    if (!chat) return null;
    if (open && open.endedAt === null && open.tag === chat.tag) return this.#view(open, true, this.#options.now());
    const view = this.#settled?.view ?? null;
    return view && view.window.tag === chat.tag ? view : null;
  }

  /** Whether the open chat runs on a configured local connection; null when unknown (Work Status 24 px line). */
  chatIsLocal(): boolean | null {
    const provider = this.feed.state().chat?.provider, connection = this.#body?.connection;
    if (!provider || !connection || connection.id === 'auto') return null;
    // An unavailable selection can echo the requested provider ID. Only discovered choices prove local origin.
    return connection.choices.some(choice => choice.id === provider);
  }

  dispose(): void {
    this.#stopFeed(); this.feed.dispose();
  }

  context(body: SnapshotV2): JoinContext {
    const models = runtimeModels(body), activity = this.activity;
    return {
      connection: { id: body.connection.id, runtime: body.connection.runtime, model: models.length === 1 ? models[0]! : null, models,
        choices: body.connection.choices.map(choice => choice.id) },
      canCount: !!body.capabilities['server.requests'], auto: this.#options.auto?.() ?? true,
      covered: (from, to) => activity.covered(from, to), activeMax: (from, to) => activity.activeMax(from, to),
      idleBefore: at => activity.idleBefore(at),
    };
  }

  #restart(instance: string): void {
    // A new service instance restarts completion seqs and tags: nothing kept names anything it knows.
    this.#instance = instance;
    this.#queue.clear(); this.#seen.clear(); this.#verdicts.clear();
    this.#pending = []; this.#settled = null; this.activity.reset();
  }

  /** The 1 s hold: a `completed` that came just before a request started has arrived before its verdict is drawn. */
  #judge(frame: FrameSessionState, context: JoinContext, now: number): void {
    const due = this.#pending.filter(item => now >= item.finishedAt + LIFECYCLE_HOLD_MS);
    if (!due.length) return;
    this.#pending = this.#pending.filter(item => !due.includes(item));
    for (const item of due) {
      const verdict = join(item, frame, context);
      this.#verdicts.set(item.seq, verdict);
      if (item.verdict || verdict.attr === 'withheld' && LOCAL_ONLY.has(verdict.reason)) continue;
      this.#queue.attr([{ seq: item.seq, attr: verdict.attr, reason: verdict.attr === 'withheld' ? verdict.reason : null }]);
    }
    trim(this.#verdicts);
  }

  /** A turn is settled once a reading after its end is in and every step that could be in it has a verdict. */
  #settle(frame: FrameSessionState, now: number, sampledAt: number): void {
    const chat = frame.chat;
    const ended = [...frame.windows].reverse().find(window => window.tag === chat?.tag && window.endedAt !== null && window.outcome !== null);
    if (!ended) return;
    const end = ended.endedAt!, key = `${ended.tag}\u0000${ended.startedAt}\u0000${end}`;
    if (this.#settled?.key === key || now < end + LIFECYCLE_HOLD_MS || sampledAt < end + CLOCK_TOLERANCE_MS) return;
    if (this.#pending.some(item => item.finishedAt <= end + CLOCK_TOLERANCE_MS)) return;
    this.#settled = { key, view: this.#view(ended, false, now) };
  }

  #view(window: TurnWindow, live: boolean, now: number): TurnView | null {
    const steps: CompletionV2[] = [];
    for (const item of this.#seen.values()) {
      const start = item.startedAt ?? item.finishedAt;
      if (!inside(window, start, item.finishedAt) || window.joinedAt !== undefined && item.finishedAt < window.joinedAt) continue;
      const verdict = item.verdict ?? (this.#verdicts.has(item.seq) ? verdictOf(this.#verdicts.get(item.seq)!, now) : undefined);
      // A running turn shows only steps already judged; a settled one has no unjudged step left.
      if (verdict) steps.push({ ...item, verdict });
    }
    if (!steps.length) return null;
    steps.sort((a, b) => a.finishedAt - b.finishedAt || a.seq - b.seq);
    const withheld = steps.find(step => step.verdict!.attr === 'withheld');
    const label: AttributionLabel = withheld ? labelOf(withheld) : steps.some(step => step.verdict!.attr === 'armed') ? { kind: 'armed' } : { kind: 'inferred' };
    return { window, label, steps, live, summary: withheld ? null : summarizeTurn(window, steps, live ? now : undefined) };
  }
}

import type { CompletionV2 } from '../../src/contract/completion.ts';
import type { ChatMeasurement } from '../../src/contract/chat.ts';
import type { SnapshotV2 } from '../../src/contract/snapshot.ts';
import { frameReading, linkIdentity, type HostReading, type Reading } from '../present/reading.ts';
import type { FrameIssue } from '../present/scope.ts';
import type { Tab } from '../render/views/types.ts';
import { SignalHistory } from '../signal.ts';

type Completions = { instance: string; cursor: number; items: CompletionV2[] };
/** Completions kept in the frame for Last reply, turn steps and Next reply: the service ring's size per response. */
export const KEPT_COMPLETIONS = 64;

/** The panel's one mutable state. Presenters only read it; the monitor and the shell's handlers change it. */
export class ScopeState {
  latest: Reading;                           // the newest reading applied, available or not
  lastHost: HostReading | null = null;       // the newest host reading, kept while readings stop
  snapshot: SnapshotV2 | null = null;        // the newest v2 body, retained through a missed poll
  lastChat: ChatMeasurement | null = null;   // one completed result in frame memory; never a live observation
  frame: FrameIssue | null = null;           // why the newest poll had no body
  stale = false;                             // the no-fresh-reading deadline passed since the last body
  signal = new SignalHistory();
  failures = 0;
  surface = 'panel';
  userPaused = false; efficient = false; compact = false; tab: Tab = 'live';
  serverDetailsVisible = false;             // presentation gate: Compact and blocking cards hide the secondary view
  mounted = false; startupFailed = false; disposed = false;
  generation = 0;                            // bumped to discard a request already in flight
  manualRefresh = false; interrupted = false; awaitingFresh = false;
  freshnessTimer: ReturnType<typeof setTimeout> | null = null;
  statusTimer: ReturnType<typeof setTimeout> | null = null;
  readonly open = new Set<string>();         // disclosures the reader opened, by element id
  private monitored: string | null = null;
  private chatBoundaryAt = 0;
  private completions: Completions | null = null;
  constructor(now: number) { this.latest = frameReading('runtime_unreachable', null, now); }

  /** True when the reading is from another connection than the observations so far, which must be cleared first. */
  isNewConnection(reading: Reading): boolean {
    return reading.link !== null && this.monitored !== null && linkIdentity(reading.link) !== this.monitored;
  }
  /** Applies one poll; returns the completions it brought that the frame had not seen. */
  accept(reading: Reading): CompletionV2[] {
    if (reading.link) this.monitored = linkIdentity(reading.link);
    this.latest = reading;
    if (reading.host) this.lastHost = reading.host;
    if (reading.body) {
      let body = reading.body;
      const chat = body.chat && body.chat.observation.endedAtMs > this.chatBoundaryAt ? body.chat : null;
      if (body.chat && !chat) body = { ...body, chat: undefined };
      if (body.service.instance !== this.snapshot?.service.instance) this.lastChat = null;
      if (chat) this.lastChat = chat.freshness === 'last' && chat.tokensPerSecond! > 0
        && chat.observedAtMs <= body.serverNow && chat.expiresAtMs > body.serverNow ? chat : null;
      this.snapshot = body; this.frame = null; this.stale = false;
    }
    else this.frame = { reason: reading.reason ?? 'host_unavailable', message: reading.message };
    const completions = reading.body?.completions;
    if (!completions) return [];
    // With `since`, a poll carries only newer completions; keep them until the ring restarts or rolls back.
    const kept = this.completions, same = kept?.instance === completions.instance && !completions.reset && completions.cursor >= kept.cursor;
    const fresh = completions.items.filter(item => !same || item.seq > kept!.cursor);
    // A full page can stop short of the ring's cursor (a frame back from hidden): the next poll pages on from its last item.
    this.completions = { instance: completions.instance, cursor: completions.items.length < KEPT_COMPLETIONS ? completions.cursor : fresh.at(-1)?.seq ?? kept!.cursor,
      items: [...same ? kept!.items : [], ...fresh].slice(-KEPT_COMPLETIONS) };
    return fresh;
  }
  /** The newest finished request the service reported, shown only beside an available reading. */
  get lastRequest(): CompletionV2 | null { return this.latest.available || this.snapshot ? this.completions?.items.at(-1) ?? null : null; }
  /** Every completion the frame keeps, oldest first. */
  get recent(): readonly CompletionV2[] { return this.completions?.items ?? []; }
  /** The completion cursor for the next poll's `since`. */
  get since(): number | undefined { return this.completions?.cursor; }
  /** A reply-start hint must not let an already in-flight completion restore the previous result. */
  beginChat(at: number): boolean {
    if (at <= this.chatBoundaryAt) return false;
    this.chatBoundaryAt = at;
    if (this.lastChat && this.lastChat.observation.endedAtMs <= at) this.lastChat = null;
    if (this.snapshot?.chat && this.snapshot.chat.observation.endedAtMs <= at) this.snapshot = { ...this.snapshot, chat: undefined };
    return true;
  }
  clearObservations(): void {
    this.lastHost = null; this.monitored = null; this.completions = null; this.snapshot = null; this.lastChat = null;
    this.signal = new SignalHistory();
    this.chatBoundaryAt = 0;
  }
}

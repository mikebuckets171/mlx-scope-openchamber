import type { CompletionV2 } from '../../src/contract/completion.ts';
import type { SnapshotV2 } from '../../src/contract/snapshot.ts';
import { frameReading, linkIdentity, type HostReading, type Reading } from '../present/reading.ts';
import type { FrameIssue } from '../present/scope.ts';
import type { Tab } from '../render/views/types.ts';
import { SignalHistory } from '../signal.ts';

type Completions = { instance: string; cursor: number; items: CompletionV2[] };
/** Completions kept in the frame for Last reply, turn steps and Next reply: the service ring's size per response. */
export const KEPT_COMPLETIONS = 64;
/** Poll times kept for coverage: a reading span is covered when no gap in it exceeds the allowed one. */
const KEPT_POLLS = 1_200;

/** The panel's one mutable state. Presenters only read it; the monitor and the shell's handlers change it. */
export class ScopeState {
  latest: Reading;                           // the newest reading applied, available or not
  last: Reading | null = null;               // the newest available reading
  lastHost: HostReading | null = null;       // the newest host reading, kept while readings stop
  snapshot: SnapshotV2 | null = null;        // the newest v2 body, retained through a missed poll
  frame: FrameIssue | null = null;           // why the newest poll had no body
  stale = false;                             // the no-fresh-reading deadline passed since the last body
  signal = new SignalHistory();
  failures = 0;
  surface = 'panel';
  userPaused = false; efficient = false; compact = false; tab: Tab = 'live';
  mounted = false; startupFailed = false; disposed = false;
  generation = 0;                            // bumped to discard a request already in flight
  manualRefresh = false; interrupted = false; awaitingFresh = false;
  freshnessTimer: ReturnType<typeof setTimeout> | null = null;
  statusTimer: ReturnType<typeof setTimeout> | null = null;
  readonly open = new Set<string>();         // disclosures the reader opened, by element id
  private monitored: string | null = null;
  private completions: Completions | null = null;
  private polls: number[] = [];
  constructor(now: number) { this.latest = frameReading('runtime_unreachable', null, now); }

  /** True when the reading is from another connection than the observations so far, which must be cleared first. */
  isNewConnection(reading: Reading): boolean {
    return reading.link !== null && this.monitored !== null && linkIdentity(reading.link) !== this.monitored;
  }
  /** Applies one poll; returns the completions it brought that the frame had not seen. */
  accept(reading: Reading): CompletionV2[] {
    if (reading.link) this.monitored = linkIdentity(reading.link);
    this.latest = reading;
    if (reading.available) this.last = reading;
    if (reading.host) this.lastHost = reading.host;
    if (reading.body) { this.snapshot = reading.body; this.frame = null; this.stale = false; this.polls = [...this.polls, reading.body.serverNow].slice(-KEPT_POLLS); }
    else this.frame = { reason: reading.reason ?? 'host_unavailable', message: reading.message };
    const completions = reading.body?.completions;
    if (!completions) return [];
    // With `since`, a poll carries only newer completions; keep them until the ring restarts or rolls back.
    const kept = this.completions, same = kept?.instance === completions.instance && !completions.reset && completions.cursor >= kept.cursor;
    const fresh = completions.items.filter(item => !same || item.seq > kept!.cursor);
    this.completions = { instance: completions.instance, cursor: completions.cursor, items: [...same ? kept!.items : [], ...fresh].slice(-KEPT_COMPLETIONS) };
    return fresh;
  }
  /** The newest finished request the service reported, shown only beside an available reading. */
  get lastRequest(): CompletionV2 | null { return this.latest.available || this.snapshot ? this.completions?.items.at(-1) ?? null : null; }
  /** Every completion the frame keeps, oldest first. */
  get recent(): readonly CompletionV2[] { return this.completions?.items ?? []; }
  /** The completion cursor for the next poll's `since`. */
  get since(): number | undefined { return this.completions?.cursor; }
  /** Whether this frame's polls covered [from, to] without a gap longer than `gapMs` (attribution condition 7). */
  covered(from: number, to: number, gapMs: number): boolean {
    const inside = this.polls.filter(at => at >= from - gapMs && at <= to + gapMs);
    if (!inside.length || inside[0]! > from || inside.at(-1)! < to) return false;
    return inside.every((at, index) => index === 0 || at - inside[index - 1]! <= gapMs);
  }
  clearObservations(): void {
    this.last = null; this.lastHost = null; this.monitored = null; this.completions = null; this.snapshot = null; this.polls = [];
    this.signal = new SignalHistory();
  }
}

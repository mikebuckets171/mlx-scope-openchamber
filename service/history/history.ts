import type { AlertLogEntryV2, AlertV2 } from '../../src/contract/alerts.ts';
import type { Capabilities } from '../../src/contract/capabilities.ts';
import type { CompletionsV2 } from '../../src/contract/completion.ts';
import type { HostV2 } from '../../src/contract/host.ts';
import type { Selection, TrendQuery, UsageQuery } from '../../src/contract/query.ts';
import type { RuntimeKind } from '../../src/contract/runtime.ts';
import type { RuntimeV2, StatusV2 } from '../../src/contract/snapshot.ts';
import { TREND_SERIES, type TrendV2 } from '../../src/contract/trend.ts';
import type { UsageV2 } from '../../src/contract/usage.ts';
import type { CompletionDraft } from '../core/adapter-v2.ts';
import type { TurnMark } from '../core/marks.ts';
import { SLOT_CAPACITY } from '../core/scheduler.ts';
import type { VerdictV2 } from '../core/verdicts.ts';
import { AlertBook } from './alerts.ts';
import { acceptDraft, COMPLETION_SIGNALS, CompletionRing, CompletionSequence, HostCofactors, RequestWatch, WATCH_GAP_MS, type EnergyRead } from './completions.ts';
import { HOST_SERIES_BASIS, TREND_BUCKET_MS, TrendRing, trendBases, trendSample } from './ring.ts';
import { UsageCache } from './usage-cache.ts';

// Owner: svc-history. One place the snapshot branch feeds and reads: per-slot trend and completion rings, the
// last-observed detector, host co-factors and the alert book. Everything lives in service memory; nothing is written.

/** One history per scheduler slot. */
export const HISTORY_SLOTS = SLOT_CAPACITY;
/** The cadence of a slot is the slowest read interval handed out this recently: a slower viewer still reads it. */
export const CADENCE_MEMORY_MS = 30_000;
const CADENCE_POLLS = 64;

/** What one collection of a slot saw: the adapter reading (plus its runtime kind), as the snapshot branch has it. */
export interface HistoryReading {
  at: number;                                // when the runtime was read; a cached reading keeps its time
  kind: RuntimeKind | null;
  status: StatusV2;
  capabilities: Capabilities;
  runtime: RuntimeV2;
  completions?: readonly CompletionDraft[];  // adapter drafts finished since its previous read, oldest first
  guardLevel?: number | null;                // oMLX memory guard (compat.guardLevel until a v2 field carries it)
}
export interface RecordContext {
  now: number;                               // the service clock for this request
  /** When this slot is read next: max(the nextPollMs handed to the frame, the adapter's cadence). */
  pollMs?: number;
  /** The frame's provider/runtime as sent, so `/v2/trend` with the same selection finds this slot. */
  selection?: Selection;
}
export interface SnapshotHistory { completions: CompletionsV2; alerts: AlertV2[]; alertLog: AlertLogEntryV2[] }

interface SlotHistory { trend: TrendRing; completions: CompletionRing; watch: RequestWatch; lastAt: number; polls: Array<[at: number, ms: number]> }
const selectionKey = (selection: Selection): string => `${selection.provider ?? ''}\0${selection.runtime ?? ''}`;

export class ServiceHistory {
  private readonly slots = new Map<string, SlotHistory>();
  private readonly selections = new Map<string, string>();
  private readonly sequence = new CompletionSequence();
  private readonly cofactors: HostCofactors;
  private readonly empty: SlotHistory;
  readonly alerts = new AlertBook();

  constructor(readonly instance: string, options: { energy?: EnergyRead } = {}) {
    this.cofactors = new HostCofactors(options.energy);
    this.empty = this.create();
  }

  /** The newest completion seq assigned in any slot: `Sources.completionHead`, the bound for `attr=` verdicts. */
  get head(): number { return this.sequence.head; }

  /** Once per `/v2/snapshot` request, after the collection: new readings fill the rings; every request evaluates alerts. */
  record(key: string, reading: HistoryReading, host: HostV2 | null, context: RecordContext): void {
    const slot = this.slot(key), { now } = context;
    if (context.selection) {
      this.selections.delete(selectionKey(context.selection));
      this.selections.set(selectionKey(context.selection), key);
      for (const stale of this.selections.keys()) { if (this.selections.size <= HISTORY_SLOTS * 4) break; this.selections.delete(stale); }
    }
    if (context.pollMs !== undefined && Number.isFinite(context.pollMs)) slot.polls.push([now, context.pollMs]);
    while (slot.polls.length && (slot.polls[0]![0] < now - CADENCE_MEMORY_MS || slot.polls.length > CADENCE_POLLS)) slot.polls.shift();
    this.cofactors.observe(host, now);
    let covered = true;
    if (reading.at > slot.lastAt) {
      slot.lastAt = reading.at;
      const bases = { ...HOST_SERIES_BASIS, ...trendBases(reading.capabilities) }, sample = trendSample(reading.runtime, host, reading.at);
      for (const series of TREND_SERIES) if (!bases[series]) delete sample[series];
      covered = slot.trend.append(reading.at, sample, bases);
      const signal = reading.kind ? COMPLETION_SIGNALS[reading.kind] : null;
      const drafts = signal?.source === 'watch' ? slot.watch.observe(reading.runtime, reading.at) : signal ? reading.completions ?? [] : [];
      for (const raw of drafts) {
        const draft = acceptDraft(reading.kind, raw);
        if (draft) slot.completions.append(draft, this.cofactors.over(draft.startedAt, draft.finishedAt));
      }
    }
    const { runtime } = reading, loaded = runtime.residency.filter(item => item.phase !== 'not-loaded');
    this.alerts.evaluate({
      at: now, status: reading.status, phase: runtime.phase, host, covered, key, runtime: reading.kind, request: runtime.request,
      // Only a residency report can say "none loaded"; a capped catalog could miss a loaded model.
      loadedModels: runtime.residencyCount ?? (reading.capabilities['server.residency'] ? loaded.length : null),
      model: runtime.request?.model ?? loaded[0]?.model ?? null, guardLevel: reading.guardLevel,
    });
  }

  /** The history parts of a `/v2/snapshot` body for this slot and frame. */
  snapshot(key: string, options: { since?: number; leader: boolean; now: number; verdict: (seq: number) => VerdictV2 | undefined }): SnapshotHistory {
    const slot = this.slots.get(key) ?? this.empty;
    return { completions: slot.completions.since(options.since, options.verdict), ...this.alerts.view(options.leader, options.now, key) };
  }

  /** `/v2/trend` for the slot the same selection last polled; an unknown selection is one gap over the whole window. */
  trend(query: TrendQuery, now: number, marks: readonly TurnMark[]): TrendV2 {
    const key = this.selections.get(selectionKey(query)), slot = key === undefined ? undefined : this.slots.get(key);
    return (slot ?? this.empty).trend.query(query, now, marks);
  }

  private slot(key: string): SlotHistory {
    let slot = this.slots.get(key);
    if (slot) this.slots.delete(key); else slot = this.create();
    this.slots.set(key, slot);
    for (const stale of this.slots.keys()) { if (this.slots.size <= HISTORY_SLOTS) break; this.slots.delete(stale); }
    return slot;
  }
  private create(): SlotHistory {
    const polls: Array<[number, number]> = [];
    const trend = new TrendRing(() => polls.reduce((slowest, [, ms]) => Math.max(slowest, ms), TREND_BUCKET_MS));
    return { trend, completions: new CompletionRing(this.instance, this.sequence), watch: new RequestWatch(() => Math.max(WATCH_GAP_MS, trend.breakMs())),
      lastAt: -Infinity, polls };
  }
}

export interface TrendContext { marks: readonly TurnMark[]; now: number }
/**
 * The `Sources` entries svc-history serves: `/v2/trend` from the rings, `/v2/usage` through the 5 min cache around the
 * adapter's read (absent until one is given, so the route stays 501), and the completion head for verdicts.
 */
export const historySources = (history: ServiceHistory, options: { now: () => number; readUsage?: (query: UsageQuery) => Promise<UsageV2>; usageCacheMs?: number }) => {
  const cache = new UsageCache(options.now, options.usageCacheMs), read = options.readUsage;
  return {
    trend: async (query: TrendQuery, context?: TrendContext): Promise<TrendV2> => history.trend(query, context?.now ?? options.now(), context?.marks ?? []),
    ...read ? { usage: (query: UsageQuery): Promise<UsageV2> => cache.get(query, () => read(query)) } : {},
    completionHead: (): number => history.head,
  };
};

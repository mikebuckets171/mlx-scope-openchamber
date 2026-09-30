import type { Basis } from '../../src/contract/capabilities.ts';
import { MAX_COMPLETIONS, parseCompletionV2, type CompletionsV2, type CompletionV2 } from '../../src/contract/completion.ts';
import { defined } from '../../src/contract/guards.ts';
import type { HostV2, PressureLevel, ThermalLevel } from '../../src/contract/host.ts';
import type { RuntimeKind } from '../../src/contract/runtime.ts';
import type { Phase, RequestV2, RuntimeV2 } from '../../src/contract/snapshot.ts';
import type { CompletionDraft } from '../core/adapter-v2.ts';
import type { VerdictV2 } from '../core/verdicts.ts';
import { HOST_FRESH_MS, TREND_SPAN_MS } from './ring.ts';

// Owner: svc-history. The per-slot completion ring (128, monotonic seq) behind `completions` in /v2/snapshot, the
// "request disappears" detector for oMLX and vllm-mlx (absorbs panel/insights.ts SessionInsights), and host co-factors.

export const COMPLETION_RING = 128;

/**
 * How each runtime's completions arise (contract §4): drafts from its adapter (LM Studio's `Done ·` line, Splash's
 * counter step, llama-server's busy → idle slot), RequestWatch's last-observed request, or nothing (inventory only).
 */
export const COMPLETION_SIGNALS: Readonly<Record<RuntimeKind, { basis: Basis; source: 'adapter' | 'watch' } | null>> = {
  omlx: { basis: 'last-observed', source: 'watch' }, 'vllm-mlx': { basis: 'last-observed', source: 'watch' },
  lmstudio: { basis: 'reported', source: 'adapter' }, splash: { basis: 'derived', source: 'adapter' },
  'llama-server': { basis: 'observed', source: 'adapter' }, ollama: null, 'mlx-lm': null,
};
/** The draft as the wire carries it, or null when it breaks the contract or claims a basis its runtime cannot have (P3). */
export const acceptDraft = (kind: RuntimeKind | null, draft: CompletionDraft): CompletionDraft | null => {
  const signal = kind ? COMPLETION_SIGNALS[kind] : null;
  const parsed = signal && draft.basis === signal.basis ? parseCompletionV2({ ...draft, seq: 1, host: {} }) : null;
  if (!parsed) return null;
  const { seq: _seq, host: _host, verdict: _verdict, ...wire } = parsed;
  return wire;
};

const round = (value: number, places: number): number => { const scale = 10 ** places; return Math.round(value * scale) / scale; };

/** One seq space per service instance, shared by every slot's ring, so the seq in `attr=` names one completion. */
export class CompletionSequence {
  private last = 0;
  get head(): number { return this.last; }
  next(): number { return ++this.last; }
}

export class CompletionRing {
  private readonly items: CompletionV2[] = [];
  private dropped = 0;                       // the newest seq that fell off this ring
  constructor(readonly instance: string, private readonly sequence = new CompletionSequence()) {}
  /** The newest seq in this ring; 0 while it is empty. */
  get head(): number { return this.items.at(-1)?.seq ?? 0; }
  append(draft: CompletionDraft, host: CompletionV2['host']): CompletionV2 {
    const item: CompletionV2 = defined({ seq: this.sequence.next(), ...draft, host });
    this.items.push(item);
    if (this.items.length > COMPLETION_RING) this.dropped = this.items.shift()!.seq;
    return item;
  }
  /**
   * Items with seq > since, oldest first, ≤ 64, each with its verdict, so a frame that fell behind pages forward. A
   * cursor this ring never issued (an earlier service start, another connection) or one whose successors fell off is a
   * `reset`: the frame gets the newest 64 and its ledger records a gap. Without a cursor it gets the newest 64.
   */
  since(since: number | undefined, verdict: (seq: number) => VerdictV2 | undefined): CompletionsV2 {
    const cursor = this.head, reset = since !== undefined && (since > cursor || since < this.dropped);
    const items = since === undefined || reset ? this.items.slice(-MAX_COMPLETIONS)
      : this.items.filter(item => item.seq > since).slice(0, MAX_COMPLETIONS);
    return { instance: this.instance, cursor, reset, items: items.map(item => {
      const label = verdict(item.seq);
      return label ? { ...item, verdict: label } : { ...item };
    }) };
  }
}

/** Readings further apart than this did not watch a request throughout (1.6 SessionInsights used 12 s). */
export const WATCH_GAP_MS = 12_500;
/** A request first seen in prefill before this fraction was watched from its start, when the runtime reports no elapsed. */
export const PREFILL_START_FRACTION = 0.1;
const WATCHED = new Set<Phase>(['prefill', 'decode', 'processing']);
interface Watched {
  model: string; lastAt: number; startedAt: number; startKnown: boolean;
  phase: Phase; request: RequestV2; decodeAt: number | null; prefillSeen: boolean; overlapped: boolean;
  decodeTps?: number; prefillTps?: number;
}
const grew = (before: number | undefined, after: number | undefined): boolean => before === undefined || after === undefined || after >= before;
/** Same model, counters never going back, never back into prefill after decoding, and the same prompt while prefilling. */
const continues = (watched: Watched, next: RequestV2, phase: Phase): boolean => {
  const previous = watched.request;
  return next.model === watched.model && !(phase === 'prefill' && watched.decodeAt !== null)
    && grew(previous.outputTokens, next.outputTokens) && grew(previous.elapsedMs, next.elapsedMs)
    && (phase !== 'prefill' || watched.phase !== 'prefill' || grew(previous.prefillProcessedTokens, next.prefillProcessedTokens)
      && (previous.prefillTotalTokens === undefined || next.prefillTotalTokens === undefined || previous.prefillTotalTokens === next.prefillTotalTokens));
};
/** A request never seen producing output may have been cancelled; only a decoding one becomes a completion. */
const finish = (watched: Watched): CompletionDraft | null => {
  if (watched.decodeAt === null) return null;
  const { request } = watched;
  // The switch to decode fell between two reads of this request, so its time is known to one read interval.
  const prefillMs = watched.prefillSeen && watched.startKnown ? watched.decodeAt - watched.startedAt : undefined;
  return defined({
    finishedAt: watched.lastAt, startedAt: watched.startedAt, model: watched.model, basis: 'last-observed' as const,
    promptTokens: request.promptTokens, cachedTokens: request.cachedTokens, outputTokens: request.outputTokens, ttftMs: request.ttftMs,
    prefillMs, decodeTps: watched.decodeTps, prefillTps: watched.prefillTps, overlapped: watched.overlapped,
  });
};

/**
 * Basis `last-observed`: the single active request's last reading before it left the active list (oMLX, vllm-mlx).
 * Ported from panel/insights.ts SessionInsights: a request whose end fell into a gap is dropped, not guessed.
 */
export class RequestWatch {
  private current: Watched | null = null;
  private lastAt = -Infinity;
  constructor(private readonly gapMs: () => number = () => WATCH_GAP_MS) {}

  observe(runtime: RuntimeV2, at: number): CompletionDraft[] {
    if (!(at > this.lastAt)) return [];      // a cached or out-of-order reading
    if (at - this.lastAt > this.gapMs()) this.current = null;
    this.lastAt = at;
    const { phase } = runtime, active = runtime.server.active;
    // An unreadable runtime says nothing about how the request ended.
    if (phase === 'unknown') { this.current = null; return []; }
    // Several requests: none has its own reading until one runs alone again, and the one watched shared the server.
    if (active !== null && active > 1) { if (this.current) this.current.overlapped = true; return []; }
    const next = runtime.request?.model && WATCHED.has(phase) ? runtime.request : null;
    // Work in progress without a per-request reading is no sign that the watched request left.
    if (!next && active !== 0 && (WATCHED.has(phase) || phase === 'queued')) return [];
    const done: CompletionDraft[] = [];
    if (this.current && !(next && continues(this.current, next, phase))) {
      const draft = finish(this.current);
      if (draft) done.push(draft);
      this.current = null;
    }
    if (next) this.track(next, phase, at, active === null);
    return done;
  }

  private track(request: RequestV2, phase: Phase, at: number, uncounted: boolean): void {
    if (!this.current) {
      const elapsed = request.elapsedMs, fromStart = phase === 'prefill' && (request.prefillFraction ?? 1) <= PREFILL_START_FRACTION;
      this.current = { model: request.model!, lastAt: at, startedAt: elapsed !== undefined && elapsed <= at ? at - elapsed : at,
        startKnown: elapsed !== undefined || fromStart, phase, request, decodeAt: null, prefillSeen: false, overlapped: false };
    }
    const watched = this.current;
    Object.assign(watched, { lastAt: at, phase, request });
    // Without a count, another request cannot be ruled out.
    if (uncounted) watched.overlapped = true;
    if (phase === 'prefill') {
      watched.prefillSeen = true;
      if (request.prefillTps !== undefined && request.prefillStale !== true) watched.prefillTps = request.prefillTps;
    }
    if (phase === 'decode' || (request.outputTokens ?? 0) > 0) watched.decodeAt ??= at;
    if (phase === 'decode' && request.decodeTps !== undefined) watched.decodeTps = request.decodeTps;
  }

  reset(): void { this.current = null; this.lastAt = -Infinity; }
}

/** One read of a runtime's cumulative counters (the Splash adapter maps its `/status` body). Absent = not reported. */
export interface CounterRead {
  at: number;
  completed: number;                         // finished requests; a drop is an engine restart
  abandoned?: number;                        // failed + cancelled: their work shares the deltas
  active: number | null;                     // in flight at this read; null = cannot count
  queued: number | null;
  model: string | null;
  ttftCount?: number; ttftSumMs?: number;    // the first-token histogram's count and sum
  promptTokens?: number; cachedTokens?: number; outputTokens?: number;
  prefillMs?: number; decodeMs?: number;     // cumulative wall time per stage
}
const delta = (before: number | undefined, after: number | undefined): number | null =>
  before !== undefined && after !== undefined && Number.isFinite(before) && Number.isFinite(after) && after >= before ? after - before : null;
const positive = (value: number | null): number | undefined => value !== null && value > 0 ? value : undefined;

/**
 * Basis `derived`: requests that finished between two counter reads (plan §5.2, SPIKES S7). Per-request TTFT only when
 * one request finished, one first token was recorded, at most that request was in flight before, nothing was in flight
 * or queued after, and nothing failed or was cancelled; several finished requests are one row with `aggregateOf` and a
 * mean TTFT under the same conditions. Token and time deltas belong to the finished requests only when both reads were
 * idle. A negative step is a restart, never a completion.
 */
export const counterCompletion = (before: CounterRead, after: CounterRead): CompletionDraft | null => {
  const finished = after.completed - before.completed;
  if (!Number.isSafeInteger(finished) || finished < 1 || !(after.at > before.at)) return null;
  const idle = (read: CounterRead): boolean => read.active === 0 && read.queued === 0;
  const clean = (delta(before.abandoned, after.abandoned) ?? 0) === 0;
  const alone = clean && before.active !== null && before.active <= 1 && before.queued === 0 && idle(after);
  const whole = clean && idle(before) && idle(after);
  const firstTokens = delta(before.ttftCount, after.ttftCount), ttftSum = delta(before.ttftSumMs, after.ttftSumMs);
  const ttftMs = firstTokens === finished && ttftSum !== null && (finished === 1 ? alone : clean && idle(after)) ? round(ttftSum / finished, 1) : undefined;
  const prompt = whole ? delta(before.promptTokens, after.promptTokens) : null, cached = whole ? delta(before.cachedTokens, after.cachedTokens) : null;
  const output = whole ? delta(before.outputTokens, after.outputTokens) : null;
  const prefillMs = whole ? delta(before.prefillMs, after.prefillMs) : null, decodeMs = whole ? delta(before.decodeMs, after.decodeMs) : null;
  const prefilled = prompt !== null && cached !== null && cached <= prompt ? prompt - cached : null;
  return defined({
    finishedAt: after.at, startedAt: null, model: after.model, basis: 'derived' as const,
    promptTokens: prompt ?? undefined, cachedTokens: cached !== null && prompt !== null && cached <= prompt ? cached : undefined,
    outputTokens: output ?? undefined, ttftMs, prefillMs: prefillMs === null ? undefined : round(prefillMs, 1),
    decodeTps: positive(output) && positive(decodeMs) ? round(output! / (decodeMs! / 1_000), 2) : undefined,
    prefillTps: positive(prefilled) && positive(prefillMs) ? round(prefilled! / (prefillMs! / 1_000), 2) : undefined,
    overlapped: finished > 1 || !alone, aggregateOf: finished > 1 ? finished : undefined,
  });
};

type Point = [at: number, value: number];
/** macmon writes a sample a second; a longer step between two is time without a power reading. */
export const POWER_STEP_MS = 2_500;
export const ENERGY_COVERAGE = 0.8;
const POINTS = 4_000;
export type EnergyRead = (from: number, to: number) => { energyJ: number; coverage: number } | null;
const push = (points: Point[], at: number | undefined, value: number | undefined): void => {
  if (at === undefined || value === undefined || !Number.isFinite(value)) return;
  const last = points.at(-1);
  if (last && at <= last[0]) return;        // the same probe reading again
  points.push([at, value]);
  if (points.length > POINTS) points.shift();
};
/** The readings in [from, to], led by the one in effect at `from` when it is fresh. */
const within = (points: readonly Point[], from: number, to: number): Point[] => {
  const inside = points.filter(([at]) => at >= from && at <= to), before = points.filter(([at]) => at < from).at(-1);
  return before && from - before[0] <= HOST_FRESH_MS ? [before, ...inside] : inside;
};
const peak = (points: readonly Point[]): number | undefined => points.length ? Math.max(...points.map(([, value]) => value)) : undefined;

/** Host readings over a completion's span: pressure max, swap delta, GPU alloc max, thermal max, energy. */
export class HostCofactors {
  private readonly pressure: Point[] = [];
  private readonly swap: Point[] = [];
  private readonly gpu: Point[] = [];
  private readonly thermal: Point[] = [];
  private readonly power: Point[] = [];
  /** `energy` is the power stream's own integral (svc-host); without it the observed samples are integrated. */
  constructor(private readonly energy?: EnergyRead) {}

  observe(host: HostV2 | null, at: number): void {
    if (host) {
      push(this.pressure, host.mac?.sampledAt, host.mac?.pressureLevel);
      push(this.swap, host.mac?.sampledAt, host.mac?.swapUsedBytes);
      push(this.gpu, host.gpu?.sampledAt, host.gpu?.allocBytes);
      push(this.thermal, host.thermal?.sampledAt, host.thermal?.level);
      push(this.power, host.power?.sampledAt, host.power?.chipW);
    }
    for (const points of [this.pressure, this.swap, this.gpu, this.thermal, this.power]) {
      while (points.length && points[0]![0] < at - TREND_SPAN_MS) points.shift();
    }
  }

  /** A null start has no span: the readings in effect when it finished, and no swap delta or energy. */
  over(startedAt: number | null, finishedAt: number): CompletionV2['host'] {
    const from = startedAt !== null && startedAt <= finishedAt ? startedAt : finishedAt, swap = within(this.swap, from, finishedAt);
    const energy = startedAt !== null && finishedAt > from ? this.energy ? this.energy(from, finishedAt) : this.integrate(from, finishedAt) : null;
    const coverage = energy ? Math.min(1, Math.max(0, energy.coverage)) : null;
    return defined({
      pressureMax: peak(within(this.pressure, from, finishedAt)) as PressureLevel | undefined,
      swapDeltaBytes: startedAt !== null && swap.length >= 2 ? swap.at(-1)![1] - swap[0]![1] : undefined,
      gpuAllocMaxBytes: peak(within(this.gpu, from, finishedAt)),
      thermalMaxLevel: peak(within(this.thermal, from, finishedAt)) as ThermalLevel | undefined,
      energyJ: energy && coverage! >= ENERGY_COVERAGE ? round(energy.energyJ, 1) : undefined,
      powerCoverage: coverage === null ? undefined : round(coverage, 2),
    });
  }

  /** Each macmon sample is the mean power over the step that ends at it; steps over 2.5 s are uncovered. */
  private integrate(from: number, to: number): { energyJ: number; coverage: number } | null {
    let joules = 0, covered = 0;
    for (let index = 1; index < this.power.length; index += 1) {
      const [start] = this.power[index - 1]!, [end, watts] = this.power[index]!;
      if (end - start > POWER_STEP_MS) continue;
      const span = Math.min(end, to) - Math.max(start, from);
      if (span > 0) { joules += watts * span / 1_000; covered += span; }
    }
    return covered > 0 ? { energyJ: joules, coverage: covered / (to - from) } : null;
  }
}

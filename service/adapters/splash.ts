import { capabilitiesOf, type CapabilityDescriptor } from '../../src/contract/capabilities.ts';
import { count, defined, nonneg, obj, opt, type Json } from '../../src/contract/guards.ts';
import { hash32 } from '../../src/contract/hash.ts';
import type { ReasonParams } from '../../src/contract/reasons.ts';
import { requiredCapabilities, type CatalogV2, type Phase, type Quantiles, type RuntimeV2, type StatusV2 } from '../../src/contract/snapshot.ts';
import type { AdapterContextV2, AdapterReadingV2, AdapterV2, CompletionDraft, DescriptorV2 } from '../core/adapter-v2.ts';
import { HttpFailure } from '../http.ts';
import { modelLabel, positive } from '../lib/parse.ts';

// Owner: ad-splash. Splash 1.0.2–1.2 through GET /status only (G1: no /metrics, no /v1/models). Precedence recovering >
// status_stale > not admitting > ready; native ttft_ms/itl_ms p50/p95 with n. last_crash_trace, transport.error and
// metal.failure_reason cross only as presence booleans; instance.* and identity.* never leave this file (the model
// name is class B and the instance id only feeds the opaque generation key).

/** While transport.recovering, runtime reads are cached this long so Scope never joins the restart retries. */
export const SPLASH_RECOVERING_CACHE_MS = 30_000;
/** Reads further apart than this bracket a stretch nobody watched: counters that moved across it make no completion. */
export const SPLASH_GAP_MS = 60_000;
export const SPLASH_CADENCE_MS = { active: 1_000, idle: 2_000 } as const;
/** The maximum observation window and continuity gap for recent native prefill and decoding. */
export const SPLASH_RATE_GAP_MS = 5_000;
export const SPLASH_RATE_MIN_WINDOW_MS = 2_000;
export const SPLASH_RATE_MIN_SAMPLES = 3;

const CAPABILITIES: readonly CapabilityDescriptor[] = [
  { key: 'server.requests', basis: 'derived' }, { key: 'server.averages', basis: 'reported' }, { key: 'server.rates', basis: 'derived' },
  { key: 'server.latency', basis: 'reported' }, { key: 'server.memory.metal', basis: 'reported' },
  { key: 'server.catalog', basis: 'reported' }, { key: 'server.completions', basis: 'derived' },
];
const MODALITIES = ['text', 'image', 'audio', 'pdf'] as const;
type Modality = typeof MODALITIES[number];

/** A Splash /status body: an object with a boolean `ready` (1.6's probe rule). */
const splashBody = (body: unknown): Json | null => { const item = obj(body); return item && typeof item.ready === 'boolean' ? item : null; };
const field = (root: unknown, path: string): unknown => path.split('.').reduce<unknown>((value, key) => obj(value)?.[key], root);
const text = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';
/** Stale and recovering bodies are a cached copy of the last native snapshot with `ready` forced false. */
const fresh = (item: Json): boolean => field(item, 'transport.recovering') !== true && field(item, 'transport.status_stale') !== true;
/** The HTTP time-to-first-token histogram: `latency.http_ttft` since Splash 1.2 (status schema 6), `latency.ttft` before. */
const ttftLatency = (item: Json, key: 'count' | 'sum'): unknown =>
  field(item, `latency.http_ttft.${key}`) ?? field(item, `latency.ttft.${key}`);

/** Splash reports no version (schema_version is 5 in 1.0 and 1.1, 6 in 1.2): 1.1 and later are recognised by their feature fields. */
export const isSplash11 = (body: unknown): boolean => {
  const item = obj(body);
  return !!item && (typeof item.vision === 'boolean' || Array.isArray(item.input_modalities) || obj(item.chat_template) !== null);
};

/** The state and reason a /status body means (params hold booleans and times only, never Splash's free text). */
export const splashStatus = (body: unknown, at?: number): StatusV2 => {
  const item = splashBody(body);
  if (!item) return { state: 'degraded', reason: 'unsupported_contract', params: {} };
  const transport = obj(item.transport) ?? {}, metal = obj(item.metal), transportError = text(transport.error);
  // status_age_ms is how old the cached native snapshot is, so it dates the fault; 0 means no snapshot was ever cached.
  const age = nonneg(transport.status_age_ms), since = at !== undefined && age ? Math.max(0, Math.round(at - age)) : undefined;
  if (transport.recovering === true) return defined({ state: 'recovering' as const, reason: 'recovering' as const,
    params: { retryInMs: SPLASH_RECOVERING_CACHE_MS, crashTrace: text(transport.last_crash_trace), transportError }, sinceAt: since });
  if (transport.status_stale === true) {
    const params: ReasonParams = since === undefined ? { transportError } : { staleSinceAt: since, transportError };
    return { state: 'degraded', reason: 'status_stale', params };
  }
  const metalUnhealthy = metal?.healthy !== true, memoryCritical = item.memory_pressure === 'critical';
  // backend.py also forces ready false while the transport closes; 1.1 refuses connections while loading, so a
  // not-ready body is never "Loading".
  if (metalUnhealthy || memoryCritical || item.ready !== true)
    return { state: 'degraded', reason: 'not_admitting', params: { metalUnhealthy, memoryCritical, metalFailure: text(metal?.failure_reason) } };
  return { state: 'ready', reason: null, params: {} };
};

/** Engine requests in flight: submitted − completed − failed − cancelled (1.6's derivation; `cancelled` came later). */
const inFlight = (item: Json): number | null => {
  const requests = obj(item.requests), submitted = count(requests?.submitted), completed = count(requests?.completed), failed = count(requests?.failed);
  return submitted === null || completed === null || failed === null ? null
    : Math.max(0, submitted - completed - failed - (count(requests?.cancelled) ?? 0));
};
/** Requests Splash is handling: the engine's in-flight count or, when larger, HTTP admission (preparation, streaming). */
const busy = (item: Json): number | null => {
  const flight = inFlight(item), http = count(field(item, 'http.requests.active'));
  return flight === null ? null : Math.max(flight, http ?? 0);
};
/** Not yet running: the Queued, WaitingResources and WaitingPrefix scheduler phases (Scheduler.cpp snapshot()). */
const waiting = (item: Json): number | null => {
  const scheduler = obj(item.scheduler), parts = [scheduler?.queued, scheduler?.waiting_resources, scheduler?.waiting_prefix].map(count);
  return parts.every(part => part !== null) ? parts.reduce<number>((sum, part) => sum + part!, 0) : null;
};

const activity = (item: Json): { active: number | null; queued: number | null; phase: Phase } => {
  const total = busy(item);
  if (!fresh(item) || total === null) return { active: null, queued: null, phase: 'unknown' };
  const wait = waiting(item), queued = wait === null ? null : Math.min(total, wait), active = total - (queued ?? 0);
  const scheduler = obj(item.scheduler), prefill = count(scheduler?.prefilling) ?? 0;
  const decode = (count(scheduler?.decoding) ?? 0) + (count(scheduler?.waiting_mask) ?? 0);
  const phase: Phase = total === 0 ? 'idle' : active === 0 && queued ? 'queued'
    : prefill && !decode ? 'prefill' : decode && !prefill ? 'decode' : 'processing';
  return { active, queued, phase };
};

const averages = (item: Json): RuntimeV2['server']['averages'] => {
  const metrics = obj(item.metrics), requests = obj(item.requests);
  // Splash prints 0 tok/s before its first token: no tokens is no rate, not a slow one.
  const rate = (tokens: unknown, value: unknown) => (count(tokens) ?? 0) > 0 ? opt(nonneg(value)) : undefined;
  const result = defined({ decodeTps: rate(metrics?.decode_output_tokens, metrics?.decode_tokens_per_second),
    prefillTps: rate(metrics?.prefill_input_tokens, metrics?.prefill_tokens_per_second),
    requestsTotal: opt(count(requests?.completed)), failedTotal: opt(count(requests?.failed)) });
  return Object.keys(result).length ? result : undefined;
};
/** Native nearest-rank percentiles over the last ≤ 4,096 samples; an empty window reports 0/0 and is left out. */
const quantiles = (value: unknown): Quantiles | undefined => {
  const item = obj(value), p50 = nonneg(item?.p50), p95 = nonneg(item?.p95), n = count(item?.samples);
  return p50 !== null && p95 !== null && p50 <= p95 && n ? { p50, p95, n, window: 'native-last-4096' } : undefined;
};
const histograms = (item: Json): RuntimeV2['server']['histograms'] => {
  const metrics = obj(item.metrics), ttftMs = quantiles(metrics?.ttft_ms), itlMs = quantiles(metrics?.itl_ms);
  return ttftMs || itlMs ? defined({ ttftMs, itlMs }) : undefined;
};
/** Splash's own Metal allocation. Never process memory: the engine is a child process (SPIKES S9). */
const memory = (item: Json): RuntimeV2['memory'] => {
  const actual = obj(item.memory_actual), current = count(actual?.current_bytes), peak = count(actual?.peak_bytes);
  return defined({ metalBytes: opt(current), metalPeakBytes: peak !== null && (current === null || peak >= current) ? peak : undefined });
};
const catalog = (item: Json): CatalogV2[] => {
  const name = modelLabel(field(item, 'instance.model'));
  if (!name) return [];
  const v11 = isSplash11(item), modalities = Array.isArray(item.input_modalities)
    ? [...new Set(item.input_modalities.filter((value): value is Modality => MODALITIES.includes(value)))] : [];
  return [defined({ name, format: 'splash' as const, loaded: fresh(item) ? true : null, contextWindowTokens: positive(item.maximum_context_tokens),
    vision: v11 && typeof item.vision === 'boolean' ? item.vision : undefined, inputModalities: v11 && modalities.length ? modalities : undefined })];
};
/** Opaque, in-service only: a new Splash process, an engine restart or another model changes it. */
const generationKey = (item: Json): string =>
  hash32(JSON.stringify(['instance.id', 'instance.started_at', 'instance.model', 'transport.restarts'].map(path => field(item, path) ?? null)))
    .toString(16).padStart(8, '0');

/** One native stage's independent counter window. Activity in the other stage cannot establish continuity. */
class SplashCounterRate {
  private samples: Array<{ key: string; tokens: number; ms: number; at: number }> = [];

  observe(item: Json | null, active: number, tokens: number | null, ms: number | null, monotonicAt: number): { tps: number; windowMs: number } | undefined {
    if (!item || splashStatus(item).state !== 'ready' || field(item, 'transport.ready') === false || field(item, 'transport.stopped') === true || !active
      || tokens === null || ms === null || nonneg(monotonicAt) === null) { this.reset(); return undefined; }
    const current = { key: generationKey(item), tokens, ms, at: monotonicAt }, previous = this.samples.at(-1);
    if (previous && monotonicAt <= previous.at) { this.reset(); return undefined; }
    if (!previous || previous.key !== current.key || monotonicAt - previous.at > SPLASH_RATE_GAP_MS
      || tokens < previous.tokens || ms < previous.ms) { this.samples = [current]; return undefined; }
    // Retain valid observations, including a stalled poll, but never publish retained work when the latest
    // counters did not both advance. The displayed interval is observation time, not the rate denominator.
    this.samples.push(current);
    this.samples = this.samples.filter(sample => monotonicAt - sample.at <= SPLASH_RATE_GAP_MS);
    const first = this.samples[0]!, windowMs = monotonicAt - first.at;
    if (this.samples.length < SPLASH_RATE_MIN_SAMPLES || windowMs < SPLASH_RATE_MIN_WINDOW_MS
      || tokens <= previous.tokens || ms <= previous.ms) return undefined;
    const deltaTokens = tokens - first.tokens, deltaMs = ms - first.ms;
    const tps = Math.round(deltaTokens * 1_000_000 / deltaMs) / 1_000;
    return Number.isFinite(tps) ? { tps, windowMs } : undefined;
  }

  reset(): void { this.samples = []; }
}

/**
 * Native stage counters advance after each batch, before the request ends (Splash Status.hpp). Their delta is
 * recent server-wide command throughput, not a request's streamed delivery rate. Reported lifetime averages
 * and retained current batches are deliberately unused. Prefill and decode retain separate observation windows.
 */
export class SplashRates {
  private readonly decode = new SplashCounterRate();
  private readonly prompt = new SplashCounterRate();

  observe(body: unknown, monotonicAt: number): RuntimeV2['server']['rates'] {
    const item = splashBody(body), scheduler = obj(item?.scheduler), metrics = obj(item?.metrics);
    const decode = this.decode.observe(item, (count(scheduler?.decoding) ?? 0) + (count(scheduler?.waiting_mask) ?? 0),
      count(metrics?.decode_output_tokens), nonneg(metrics?.decode_wall_ms), monotonicAt);
    const prompt = this.prompt.observe(item, count(scheduler?.prefilling) ?? 0,
      count(metrics?.prefill_input_tokens), nonneg(metrics?.prefill_wall_ms), monotonicAt);
    return decode || prompt ? defined({ decodeTps: decode?.tps, promptTps: prompt?.tps,
      promptWindowMs: prompt?.windowMs, windowMs: decode?.windowMs ?? prompt!.windowMs }) : undefined;
  }

  reset(): void { this.decode.reset(); this.prompt.reset(); }
}

const emptyRuntime = (at: number): RuntimeV2 => ({ sampledAt: at, phase: 'unknown', request: null, server: { active: null, queued: null },
  memory: {}, residency: [], slots: [], catalog: [], engines: [] });

/** One /status body as a v2 reading. A stale body keeps its last-reported totals but says nothing about activity. */
export const splashReading = (body: unknown, at: number): Omit<AdapterReadingV2, 'completions'> => {
  const item = splashBody(body), status = splashStatus(body, at);
  if (!item) return { at, status, capabilities: {}, runtime: emptyRuntime(at), identity: {} };
  const live = activity(item);
  const runtime: RuntimeV2 = { sampledAt: at, phase: live.phase, request: null,
    server: defined({ active: live.active, queued: live.queued, averages: averages(item), histograms: histograms(item) }),
    memory: memory(item), residency: [], slots: [], catalog: catalog(item), engines: [] };
  const filled = new Set(requiredCapabilities({ runtime }));
  return { at, status, runtime, identity: {}, generationKey: generationKey(item),
    capabilities: capabilitiesOf(CAPABILITIES.filter(({ key }) => key === 'server.completions' || filled.has(key))) };
};

interface Counters {
  engine: unknown; busy: number; queued: number | null; model: string | null;
  totals: { submitted: number; completed: number; failed: number; cancelled: number; ttftCount: number | null; ttftSum: number | null;
            prefillTokens: number | null; prefillMs: number | null; decodeTokens: number | null; decodeMs: number | null };
}
const counters = (body: unknown): Counters | null => {
  const item = splashBody(body), total = item ? busy(item) : null;
  if (!item || !fresh(item) || total === null) return null;
  const requests = obj(item.requests)!, metrics = obj(item.metrics);
  return { engine: JSON.stringify([field(item, 'instance.id') ?? null, field(item, 'transport.restarts') ?? null]), busy: total,
    queued: waiting(item), model: modelLabel(field(item, 'instance.model')),
    totals: { submitted: count(requests.submitted)!, completed: count(requests.completed)!, failed: count(requests.failed)!,
      cancelled: count(requests.cancelled) ?? 0, ttftCount: count(ttftLatency(item, 'count')), ttftSum: nonneg(ttftLatency(item, 'sum')),
      prefillTokens: count(metrics?.prefill_input_tokens), prefillMs: nonneg(metrics?.prefill_wall_ms),
      decodeTokens: count(metrics?.decode_output_tokens), decodeMs: nonneg(metrics?.decode_wall_ms) } };
};
/** Δ of one counter, or null when either read lacks it. */
type Deltas = { [K in keyof Counters['totals']]: number | null };
const deltas = (before: Counters, after: Counters): Deltas | null => {
  const result = {} as Deltas;
  for (const key of Object.keys(before.totals) as Array<keyof Deltas>) {
    const a = before.totals[key], b = after.totals[key];
    result[key] = a === null || b === null ? null : b - a;
  }
  // Native counters restart with a replacement engine while Python's latency keeps counting: any drop is a reset.
  return before.engine === after.engine && Object.values(result).every(delta => delta === null || delta >= 0) ? result : null;
};
const round3 = (value: number): number => Math.round(value * 1_000) / 1_000;
const rate = (tokens: number | null, ms: number | null): number | undefined => tokens && ms ? round3(tokens * 1_000 / ms) : undefined;

/**
 * The requests that finished between two reads. Per-request values (basis `derived`) only when exactly one request
 * touched the span: TTFT count Δ = 1, completed Δ = 1, nothing else failed or cancelled, at most that request active
 * at `before`, nothing active at `after` and nothing queued at either. Otherwise the step is recorded as-is:
 * `aggregateOf` when it covered several requests, and `overlapped` because they could not be told apart.
 */
export const splashCompletion = (before: unknown, after: unknown, at: number): CompletionDraft | null => {
  const a = counters(before), b = counters(after), delta = a && b ? deltas(a, b) : null;
  if (!a || !b || !delta || !delta.completed) return null;
  const base = { finishedAt: at, startedAt: null, model: b.model, basis: 'derived' as const };
  const single = delta.completed === 1 && delta.failed === 0 && delta.cancelled === 0 && a.busy <= 1 && b.busy === 0 && !a.queued && !b.queued;
  if (!single) return defined({ ...base, overlapped: true, aggregateOf: delta.completed > 1 ? delta.completed : undefined });
  // With nothing running at `before`, every native Δ belongs to this request; otherwise part of it ran before the span.
  const whole = a.busy === 0;
  return defined({ ...base, overlapped: false,
    ttftMs: delta.ttftCount === 1 && delta.ttftSum !== null ? round3(delta.ttftSum * 1_000) : undefined,
    prefillMs: whole && delta.prefillMs ? round3(delta.prefillMs) : undefined,
    prefillTps: whole ? rate(delta.prefillTokens, delta.prefillMs) : undefined,
    decodeTps: whole ? rate(delta.decodeTokens, delta.decodeMs) : undefined });
};

/**
 * Brackets requests between reads with nothing active, so a counter step spans whole requests (SPIKES S7). The
 * bracket restarts after a reset, an unwatched gap or an unknown body; stale and recovering copies move nothing.
 */
export class SplashCompletions {
  private anchor: unknown = null;
  private lastAt: number | null = null;

  observe(body: unknown, at: number, monotonicAt: number): CompletionDraft[] {
    const gap = this.lastAt !== null && monotonicAt - this.lastAt > SPLASH_GAP_MS;
    this.lastAt = monotonicAt;
    const current = counters(body);
    if (!splashBody(body)) this.anchor = null;
    if (!current) return [];
    const anchor = counters(this.anchor);
    if (gap || !anchor || !deltas(anchor, current)) { this.anchor = body; return []; }
    if (current.busy > 0) return [];
    const draft = splashCompletion(this.anchor, body, at);
    this.anchor = body;
    return draft ? [draft] : [];
  }
  reset(): void { this.anchor = null; this.lastAt = null; }
}

class SplashAdapter implements AdapterV2 {
  private held: { reading: AdapterReadingV2; until: number } | null = null;
  private readonly completions = new SplashCompletions();
  private readonly rates = new SplashRates();
  private readSequence = 0;
  constructor(private readonly context: AdapterContextV2) {}

  async read(): Promise<AdapterReadingV2> {
    const held = this.hold();
    if (held) return held;
    const sequence = ++this.readSequence;
    let body: unknown;
    try { body = await this.status(); }
    catch (error) { if (sequence === this.readSequence) this.rates.reset(); throw error; }
    const at = this.context.now(), monotonicAt = this.context.monotonic();
    // RuntimeClient normally coalesces reads. If a read overlaps or the adapter is disposed mid-fetch, its
    // older response must not establish a new baseline or rewind the current completion bracket.
    if (sequence !== this.readSequence) return { ...splashReading(body, at), completions: [] };
    const reading: AdapterReadingV2 = { ...splashReading(body, at), completions: this.completions.observe(body, at, monotonicAt) };
    const rates = this.rates.observe(body, monotonicAt);
    if (rates) {
      reading.runtime.server.rates = rates;
      reading.capabilities['server.rates'] = { scope: 'server', basis: 'derived' };
    }
    this.held = reading.status.state === 'recovering' ? { reading, until: this.context.monotonic() + SPLASH_RECOVERING_CACHE_MS } : null;
    return reading;
  }

  /** Still Splash? Answered from the recovering hold without a GET, so identity checks never add to the restart. */
  async identity(): Promise<boolean> {
    if (this.hold()) return true;
    return splashBody((await this.context.get('/status')).body) !== null;
  }

  dispose(): void { this.readSequence += 1; this.held = null; this.completions.reset(); this.rates.reset(); }

  private hold(): AdapterReadingV2 | null {
    const left = this.held ? this.held.until - this.context.monotonic() : 0;
    if (!this.held || left <= 0) { this.held = null; return null; }
    const { reading } = this.held;
    return { ...reading, status: { ...reading.status, params: { ...reading.status.params, retryInMs: Math.ceil(left) } }, completions: [] };
  }

  /** The body, or a throw when Splash cannot be read at all. A 200 in another shape reads as unsupported_contract. */
  private async status(): Promise<unknown> {
    const reply = await this.context.get('/status');
    if (splashBody(reply.body) || reply.routeMissing || [200, 404, 405].includes(reply.status)) return reply.body;
    if (reply.status === 401 || reply.status === 403) throw new HttpFailure('authentication_failed', 'Splash refused the status read.', reply.status);
    throw new HttpFailure('runtime_unreachable', `Splash returned HTTP ${reply.status}.`, reply.status);
  }
}

const BIONIC = /bionic|lm[\s_-]*studio/i;
/** /status schema versions with a qualified corpus: 5 (Splash 1.0.2 and 1.1) and 6 (1.2). Others still match, at medium. */
const SPLASH_SCHEMAS: readonly unknown[] = [5, 6];
export const splashDescriptor: DescriptorV2 = {
  id: 'splash',
  // splish is the owner's fork (identical server code, SPIKES S7); a Splash engine inside Bionic is LM Studio's.
  hints: (id, name) => !BIONIC.test(`${id} ${name}`) && (/^spl[ai]sh$/i.test(id.trim()) || /spl[ai]sh/i.test(name)),
  detect: [
    { probe: '/status', confidence: 'high', match: ({ body }) => splashBody(body) !== null && obj(body!.transport) !== null
      && SPLASH_SCHEMAS.includes(body!.schema_version as number) },
    { probe: '/status', confidence: 'medium', match: ({ body }) => splashBody(body) !== null },
  ],
  cadence: ({ activity, recovering }) => recovering ? SPLASH_RECOVERING_CACHE_MS : activity ? SPLASH_CADENCE_MS.active : SPLASH_CADENCE_MS.idle,
  capabilities: CAPABILITIES, identityEveryMs: 60_000,
  create: context => new SplashAdapter(context),
};

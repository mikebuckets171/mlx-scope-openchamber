import { capabilitiesOf, type CapabilityDescriptor } from '../../src/contract/capabilities.ts';
import { bool, defined, list, obj, opt } from '../../src/contract/guards.ts';
import { LIMITS, type CatalogV2, type Phase, type RequestV2, type RuntimeV2, type SlotV2, type StatusV2 } from '../../src/contract/snapshot.ts';
import type { AdapterContextV2, AdapterReadingV2, AdapterV2, CompletionDraft, DescriptorV2, ReadContext, RuntimeReply } from '../core/adapter-v2.ts';
import { HttpFailure } from '../http.ts';
import { count, modelLabel, positive } from '../lib/parse.ts';
import { parsePrometheus, PROMETHEUS_MAX_BYTES, sampleValue, type PromParse } from '../lib/prometheus.ts';

// Owner: ad-llama-ollama. S7b rule: /slots only while /metrics shows requests_processing ≥ 1 on sleep-capable builds;
// /slots numeric allowlist only; rates from Δ*_total / Δ*_seconds_total, never the windowed gauges.

/** Builds that change what is safe to read (SPIKES S7b): /slots from b6337, sleep from b7492, a cached /metrics from b10519. */
export const LLAMA_BUILDS = { slots: 6_337, sleep: 7_492, cachedMetrics: 10_519 } as const;
export const LLAMA_PROPS_EVERY_MS = 60_000;
export const LLAMA_METRICS_EVERY_MS = 5_000;
export const LLAMA_SLOTS_EVERY_MS = 1_000;
export const LLAMA_IDLE_EVERY_MS = 2_000;
/** A /slots read further apart than this breaks a request's span: no completion, no rate across the gap. */
export const LLAMA_SLOT_GAP_MS = 5_000;
export const LLAMA_RATE_WINDOW_MS = 60_000;
export const LLAMA_SPECULATIVE_WINDOW_MS = 600_000;
const SLOTS_MAX_BYTES = 2 * 1024 * 1024;
const SLOTS_READ_MAX = 256;
const SCRAPES_MAX = 256;

const M = {
  processing: 'llamacpp:requests_processing', deferred: 'llamacpp:requests_deferred',
  promptTokens: 'llamacpp:prompt_tokens_total', promptSeconds: 'llamacpp:prompt_seconds_total',
  predicted: 'llamacpp:tokens_predicted_total', predictedSeconds: 'llamacpp:tokens_predicted_seconds_total',
  drafted: 'llamacpp:spec_decode_num_draft_tokens_total', accepted: 'llamacpp:spec_decode_num_accepted_tokens_total',
} as const;
/** The only series read. The windowed `*_tokens_seconds` gauges are left out on purpose: every scrape resets them (S7b). */
export const LLAMA_METRICS: ReadonlySet<string> = new Set(Object.values(M));
const COUNTERS = [M.promptTokens, M.promptSeconds, M.predicted, M.predictedSeconds, M.drafted, M.accepted] as const;

/** Float noise off the wire (1.2800000000000011 s of prompt time is 800 tok/s, not 799.9999999999993). */
const round = (value: number, digits = 3): number => Math.round(value * 10 ** digits) / 10 ** digits;

// ---------------------------------------------------------------------------------------------------------- /props
export interface LlamaProps {
  build: number | null; router: boolean;
  sleeping: boolean | null;                  // null: the build has no is_sleeping (cannot sleep)
  metrics: boolean; slots: boolean; totalSlots: number | null; contextWindowTokens: number | null; model: string | null;
  vision: boolean | null; audio: boolean | null;
}
export const llamaBuild = (value: unknown): number | null => {
  const match = typeof value === 'string' ? /^b(\d{1,7})(?:-|$)/.exec(value) : null;
  return match ? Number(match[1]) : null;
};
/**
 * Bare /props through a numeric/boolean allowlist: chat_template, default_generation_settings.params (generation_prompt)
 * and the rest are never read. model_path keeps its last segment only.
 */
export const parseLlamaProps = (body: unknown): LlamaProps | null => {
  const item = obj(body);
  if (!item || typeof item.build_info !== 'string') return null;
  const settings = obj(item.default_generation_settings), modalities = obj(item.modalities), router = item.role === 'router';
  return {
    build: llamaBuild(item.build_info), router, sleeping: bool(item.is_sleeping), metrics: item.endpoint_metrics === true,
    slots: item.endpoint_slots !== false, totalSlots: positive(item.total_slots), contextWindowTokens: positive(settings?.n_ctx),
    // The alias is the id clients (and so the chat's model) use; it defaults to the file name.
    model: router ? null : modelLabel(item.model_alias) ?? modelLabel(item.model_path),
    vision: bool(modalities?.vision), audio: bool(modalities?.audio),
  };
};
/** Plan §5.1: `/props` with `build_info` and `total_slots`. A router has neither slots nor a model: out of scope. */
export const isLlamaProps = (body: unknown): boolean => {
  const props = parseLlamaProps(body);
  return props !== null && props.build !== null && !props.router && props.totalSlots !== null;
};
const isLlamaAuthError = (body: unknown): boolean => {
  const error = obj(obj(body)?.error);
  return error?.code === 401 && error.type === 'authentication_error' && typeof error.message === 'string';
};

export interface LlamaPolicy { sleepCapable: boolean; metrics: boolean; slots: boolean; wakes: boolean }
/**
 * SPIKES S7b from one bare /props. /metrics only with endpoint_metrics and on a build that cannot sleep, or answers it
 * from a cache while asleep (≥ b10519). /slots from b6337; on sleep-capable builds only while /metrics shows work.
 */
export const llamaPolicy = (props: LlamaProps): LlamaPolicy => {
  const { build } = props;
  const sleepCapable = props.sleeping !== null || build !== null && build >= LLAMA_BUILDS.sleep;
  const safe = build !== null && (build >= LLAMA_BUILDS.cachedMetrics || build < LLAMA_BUILDS.sleep) || props.sleeping === null;
  return {
    sleepCapable, metrics: !props.router && props.metrics && safe,
    slots: !props.router && build !== null && build >= LLAMA_BUILDS.slots && props.slots, wakes: props.metrics && !safe,
  };
};

// ---------------------------------------------------------------------------------------------------------- /slots
/** One slot, numeric allowlist only (S7b): params, prompt, generated and generation_prompt are never read. */
export interface LlamaSlot {
  id: number; busy: boolean; contextWindowTokens: number; task: number | null;
  decoded: number | null; remaining: number | null;
  processed: number | null; cached: number | null;
  held: number | null;                       // b10519 n_prompt_tokens: the slot's cache, prompt plus generated so far
}
const readSlot = (value: unknown): LlamaSlot | null => {
  const item = obj(value), id = count(item?.id), busy = bool(item?.is_processing), context = count(item?.n_ctx);
  if (!item || id === null || busy === null || context === null) return null;
  // next_token is an array of one object on b10519 and an object on b6700.
  const next = obj(Array.isArray(item.next_token) ? item.next_token[0] : item.next_token);
  return { id, busy, contextWindowTokens: context, task: count(item.id_task), decoded: count(next?.n_decoded),
    remaining: count(next?.n_remain), processed: count(item.n_prompt_tokens_processed), cached: count(item.n_prompt_tokens_cache),
    held: count(item.n_prompt_tokens) };
};
export const readSlots = (body: unknown): LlamaSlot[] => list(body, SLOTS_READ_MAX, readSlot);
const promptOf = (slot: LlamaSlot): number | null => slot.processed !== null && slot.cached !== null ? slot.processed + slot.cached : null;
/** Idle slots carry no counts: b10519 zeroes them on release and b6700 keeps the previous request's, neither is live. */
const wireSlot = (slot: LlamaSlot): SlotV2 => slot.busy
  ? defined({ id: slot.id, busy: true, contextWindowTokens: slot.contextWindowTokens, decodedTokens: opt(slot.decoded),
    remainingTokens: opt(slot.remaining), promptTokens: opt(promptOf(slot)) })
  : { id: slot.id, busy: false, contextWindowTokens: slot.contextWindowTokens };
/** At most 16 on the wire, busy ones first, in id order. */
const wireSlots = (slots: readonly LlamaSlot[]): SlotV2[] =>
  [...slots.filter(slot => slot.busy), ...slots.filter(slot => !slot.busy)].slice(0, LIMITS.slots).sort((a, b) => a.id - b.id).map(wireSlot);
export const parseSlots = (body: unknown): SlotV2[] => wireSlots(readSlots(body));

/** The only busy slot going busy → idle, with n_decoded from its last busy read (b10519 clears it on release). */
export const slotCompletion = (previous: readonly SlotV2[], next: readonly SlotV2[], at: number): CompletionDraft | null => {
  const busy = previous.filter(slot => slot.busy);
  const after = busy.length === 1 ? next.find(slot => slot.id === busy[0]!.id) : undefined;
  if (!after || after.busy) return null;
  return defined({ finishedAt: at, startedAt: null, model: null, basis: 'observed' as const, outputTokens: busy[0]!.decodedTokens,
    promptTokens: busy[0]!.promptTokens, overlapped: next.some(slot => slot.busy) });
};

interface Span {
  id: number; task: number | null; startedAt: number | null; overlapped: boolean;
  first: { decoded: number; mono: number } | null;   // the first read with a token out
  last: LlamaSlot & { mono: number };
}
/**
 * Follows the single busy slot across /slots reads: its observed decode rate (Δn_decoded/Δt) and, when it goes idle or
 * takes a new task, one `observed` completion. Several busy slots withhold per-request speed and mark overlap.
 */
export class SlotWatch {
  private previous: { mono: number; slots: LlamaSlot[] } | null = null;
  private span: Span | null = null;
  constructor(private readonly gapMs = LLAMA_SLOT_GAP_MS) {}

  /** The last read had a busy slot and is recent: keep reading /slots until its first idle read (S7b rule 3). */
  following(mono: number): boolean {
    return this.previous !== null && mono - this.previous.mono <= this.gapMs && this.previous.slots.some(slot => slot.busy);
  }
  reset(): void { this.previous = null; this.span = null; }

  observe(slots: readonly LlamaSlot[], at: number, mono: number, model: string | null): { completion: CompletionDraft | null; decodeTps: number | null } {
    const previous = this.previous, continuous = previous !== null && mono - previous.mono <= this.gapMs;
    const busy = slots.filter(slot => slot.busy), before = continuous ? previous.slots.filter(slot => slot.busy) : [];
    let span = continuous ? this.span : null, completion: CompletionDraft | null = null, decodeTps: number | null = null;
    const now = span ? slots.find(slot => slot.id === span!.id) : undefined;
    const same = span !== null && now?.busy === true && now.task === span.task && (now.decoded ?? 0) >= (span.last.decoded ?? 0);
    if (span && !same) {
      if (before.length === 1) completion = this.complete(span, now, at, model, busy.some(slot => slot.id !== span!.id));
      span = null;
    }
    if (span && now) {
      if (busy.length > 1) span.overlapped = true;
      const elapsed = mono - span.last.mono;
      // Only an interval with this one slot busy at both ends is a per-request rate.
      if (busy.length === 1 && before.length === 1 && (span.last.decoded ?? 0) > 0 && now.decoded !== null && elapsed >= 200) {
        decodeTps = round((now.decoded - span.last.decoded!) / (elapsed / 1000));
      }
      if (!span.first && (now.decoded ?? 0) > 0) span.first = { decoded: now.decoded!, mono };
      span.last = { ...now, mono };
    } else if (busy.length === 1) {
      const slot = busy[0]!;
      // A start is observed only when the read before (inside the gap) showed that slot idle or on another task.
      const seenIdle = continuous && previous.slots.some(item => item.id === slot.id && (!item.busy || item.task !== slot.task));
      span = { id: slot.id, task: slot.task, startedAt: seenIdle ? at : null, overlapped: before.some(item => item.id !== slot.id),
        first: (slot.decoded ?? 0) > 0 ? { decoded: slot.decoded!, mono } : null, last: { ...slot, mono } };
    }
    this.span = span;
    this.previous = { mono, slots: [...slots] };
    return { completion, decodeTps };
  }

  private complete(span: Span, now: LlamaSlot | undefined, at: number, model: string | null, others: boolean): CompletionDraft {
    const last = span.last;
    // b6700 keeps the final n_decoded on the released slot; b10519 zeroes it, so the last busy read stands.
    const final = now && !now.busy && now.task === span.task && now.decoded !== null && now.decoded >= (last.decoded ?? 0) ? now.decoded : last.decoded;
    const first = span.first, window = first ? last.mono - first.mono : 0;
    const decodeTps = first && window >= 500 && last.decoded !== null && last.decoded > first.decoded ? round((last.decoded - first.decoded) / (window / 1000)) : null;
    return defined({
      // Never seen past its first token: the count is unknown, not 0.
      finishedAt: at, startedAt: span.startedAt, model, basis: 'observed' as const, outputTokens: final ? final : undefined,
      promptTokens: opt(promptOf(last)), cachedTokens: opt(last.cached), decodeTps: opt(decodeTps), overlapped: span.overlapped || others,
    });
  }
}

// ---------------------------------------------------------------------------------------------------------- /metrics
const delta = (previous: PromParse, next: PromParse, name: string): number | null => {
  const a = sampleValue(previous, name), b = sampleValue(next, name);
  if (a === null || b === null || b < a) return null;
  // Counters print at 6 significant digits (≥ 1e6 in exponent form): a step within ~2% of that quantum is noise.
  const quantum = Math.max(a, b) > 0 ? 10 ** (Math.floor(Math.log10(Math.max(a, b))) - 5) : 0;
  return b - a === 0 || b - a >= 50 * quantum ? b - a : null;
};
const rate = (tokens: number | null, seconds: number | null): number | undefined =>
  tokens !== null && seconds !== null && seconds > 0 ? round(tokens / seconds) : undefined;
/** A counter that went backwards: the server restarted and every Δ starts over. */
export const llamaRestarted = (previous: PromParse, next: PromParse): boolean => COUNTERS.some(name => {
  const a = sampleValue(previous, name), b = sampleValue(next, name);
  return a !== null && b !== null && b < a;
});
/**
 * Server rates over `windowMs` from *_total deltas, divided by Δ*_seconds_total, never by wall time. Token counters move
 * only when a request completes, so a Δ of 0 is "no rate yet", not 0 tok/s. `windowMs` is additive to the scaffold
 * signature: the parses carry no time, and a rate without its window is undefined.
 */
export const llamaRates = (previous: PromParse, next: PromParse, windowMs?: number): RuntimeV2['server']['rates'] => {
  if (!windowMs || !(windowMs > 0)) return undefined;
  const promptTps = rate(delta(previous, next, M.promptTokens), delta(previous, next, M.promptSeconds));
  const decodeTps = rate(delta(previous, next, M.predicted), delta(previous, next, M.predictedSeconds));
  return promptTps === undefined && decodeTps === undefined ? undefined : defined({ promptTps, decodeTps, windowMs });
};
/** Speculative-decoding acceptance over `windowMs` (derived); undefined without drafts in the window. */
export const llamaSpeculative = (previous: PromParse, next: PromParse, windowMs?: number): RuntimeV2['server']['speculative'] => {
  const drafted = delta(previous, next, M.drafted), accepted = delta(previous, next, M.accepted);
  if (!windowMs || !(windowMs > 0) || drafted === null || accepted === null || drafted <= 0 || accepted > drafted) return undefined;
  const draftedTokens = Math.round(drafted), acceptedTokens = Math.round(accepted);
  return { draftedTokens, acceptedTokens, acceptanceFraction: round(acceptedTokens / draftedTokens, 6), windowMs };
};

// ---------------------------------------------------------------------------------------------------------- adapter
interface Scrape { mono: number; parse: PromParse; processing: number | null; deferred: number | null }
type Settled<T> = T & { status: number };
/** A GET whose HTTP failure becomes its status; a network failure still throws (the slot's `failing`). */
const settle = async <T extends { status: number }>(request: () => Promise<T>, empty: Omit<T, 'status'>): Promise<Settled<T>> => {
  try { return await request(); } catch (error) {
    if (error instanceof HttpFailure && error.status !== null) return { ...empty, status: error.status } as Settled<T>;
    throw error;
  }
};
const authenticate = (status: number): void => {
  if (status === 401 || status === 403) throw new HttpFailure('authentication_failed', 'llama-server rejected the request key.', status);
};
const LOADING: StatusV2 = { state: 'degraded', reason: 'loading', params: {} };
const emptyRuntime = (phase: Phase): RuntimeV2 =>
  ({ phase, request: null, server: { active: null, queued: null }, memory: {}, residency: [], slots: [], catalog: [], engines: [] });
const catalogOf = (props: LlamaProps, loaded: boolean): CatalogV2[] => props.model ? [defined({
  name: props.model, format: 'gguf' as const, loaded, contextWindowTokens: props.contextWindowTokens, vision: opt(props.vision),
  inputModalities: props.vision === null && props.audio === null ? undefined
    : ['text' as const, ...props.vision ? ['image' as const] : [], ...props.audio ? ['audio' as const] : []],
})] : [];

class LlamaAdapter implements AdapterV2 {
  private props: { mono: number; value: LlamaProps } | null = null;
  private propsTriedAt = -Infinity;
  private reloaded = false;                  // /health answered 503: the model may change, so /props is read again
  private wokeAt = -Infinity;                // /metrics showed work after /props last said asleep
  private metricsOff = false;                // 501/404 on /metrics or /slots: off until the next /props
  private slotsOff = false;
  private scrapes: Scrape[] = [];
  private slotsIdleAt = -Infinity;
  private readonly watch = new SlotWatch();
  constructor(private readonly context: AdapterContextV2) {}

  private reply(path: string): Promise<RuntimeReply> { return settle(() => this.context.get(path), { body: null, routeMissing: false }); }
  private text(path: string, maxBytes: number): Promise<{ status: number; text: string }> {
    return settle(() => this.context.getText(path, maxBytes), { text: '' });
  }
  private reading(at: number, status: StatusV2, runtime: RuntimeV2, capabilities: CapabilityDescriptor[] = [], completions: CompletionDraft[] = []): AdapterReadingV2 {
    const props = this.props?.value;
    return { at, status, capabilities: capabilitiesOf(capabilities), runtime, completions,
      identity: props && props.build !== null ? { version: `b${props.build}` } : {},
      ...props ? { generationKey: [props.build, props.model, props.contextWindowTokens, props.totalSlots].join('|') } : {} };
  }

  /** Bare /props at most every 60 s (S7b rule 1); 'loading' and 'unsupported' are this read's outcome. */
  private async loadProps(mono: number, force: boolean): Promise<'loading' | 'unsupported' | null> {
    if (!force && mono - this.propsTriedAt < LLAMA_PROPS_EVERY_MS) return this.props ? null : 'unsupported';
    const reply = await this.reply('/props');
    authenticate(reply.status);
    if (reply.status === 503) return 'loading';
    this.propsTriedAt = mono;
    const parsed = reply.status === 200 && !reply.routeMissing ? parseLlamaProps(reply.body) : null;
    // Another answer where llama-server's /props was means another runtime: 3× unsupported re-detects. A 5xx keeps the last one.
    if (!parsed && (reply.status === 200 || reply.status === 404 || reply.routeMissing)) this.props = null;
    if (!parsed) return this.props ? null : 'unsupported';
    const before = this.props?.value;
    if (before && (before.build !== parsed.build || before.model !== parsed.model)) { this.scrapes = []; this.watch.reset(); }
    this.props = { mono, value: parsed };
    this.metricsOff = false; this.slotsOff = false;
    return null;
  }

  private async scrape(mono: number): Promise<'loading' | null> {
    const reply = await this.text('/metrics', PROMETHEUS_MAX_BYTES);
    authenticate(reply.status);
    if (reply.status === 503) return 'loading';
    if (reply.status === 501 || reply.status === 404) { this.metricsOff = true; return null; }
    if (reply.status !== 200) return null;
    const parse = parsePrometheus(reply.text, { allow: name => LLAMA_METRICS.has(name) });
    if (parse.truncated) return null;
    const latest = this.scrapes.at(-1);
    if (latest && llamaRestarted(latest.parse, parse)) this.scrapes = [];
    this.scrapes.push({ mono, parse, processing: sampleValue(parse, M.processing), deferred: sampleValue(parse, M.deferred) });
    this.scrapes = this.scrapes.filter(item => mono - item.mono <= LLAMA_SPECULATIVE_WINDOW_MS).slice(-SCRAPES_MAX);
    return null;
  }

  private async readSlots(mono: number): Promise<LlamaSlot[] | null> {
    const reply = await this.text('/slots', SLOTS_MAX_BYTES);
    authenticate(reply.status);
    if (reply.status === 501 || reply.status === 404) { this.slotsOff = true; return null; }
    if (reply.status !== 200) return null;
    let body: unknown;
    try { body = JSON.parse(reply.text); } catch { return null; }
    if (!Array.isArray(body)) return null;
    const slots = readSlots(body);
    if (!slots.some(slot => slot.busy)) this.slotsIdleAt = mono;
    return slots;
  }

  async read(options: ReadContext): Promise<AdapterReadingV2> {
    const at = this.context.now(), mono = this.context.monotonic();
    const health = await this.reply('/health');
    if (health.status === 503) { this.reloaded = true; return this.reading(at, LOADING, emptyRuntime('loading')); }
    if (health.status !== 200) throw new HttpFailure('runtime_unreachable', `llama-server /health answered HTTP ${health.status}.`, health.status);
    const outcome = await this.loadProps(mono, this.reloaded);
    if (outcome === 'loading') return this.reading(at, LOADING, emptyRuntime('loading'));
    this.reloaded = false;
    if (outcome === 'unsupported' || !this.props) {
      return this.reading(at, { state: 'degraded', reason: 'unsupported_contract', params: {} }, emptyRuntime('unknown'));
    }
    const props = this.props.value;
    // Router mode: /metrics, /slots and /props?model= load models. Only /health and bare /props are ever read.
    if (props.router) return this.reading(at, { state: 'unconfigured', reason: 'unsupported_runtime', params: {} }, emptyRuntime('unknown'));
    const policy = llamaPolicy(props), metricsUsable = policy.metrics && !this.metricsOff;
    const room = () => this.context.monotonic() < options.deadline;
    if (metricsUsable && (this.scrapes.length === 0 || mono - this.scrapes.at(-1)!.mono >= LLAMA_METRICS_EVERY_MS) && room()) {
      if (await this.scrape(mono) === 'loading') { this.reloaded = true; return this.reading(at, LOADING, emptyRuntime('loading')); }
    }
    const latest = metricsUsable ? this.scrapes.at(-1) ?? null : null;
    if (props.sleeping && latest && latest.mono > this.props.mono && (latest.processing ?? 0) >= 1) this.wokeAt = latest.mono;
    const asleep = props.sleeping === true && this.wokeAt <= this.props.mono;
    const slotsLive = policy.slots && !this.slotsOff && (!policy.sleepCapable || metricsUsable);
    // Work in a recent scrape taken after the last idle /slots read; an old scrape says nothing about sleep since.
    const working = latest !== null && (latest.processing ?? 0) >= 1 && latest.mono > this.slotsIdleAt && mono - latest.mono <= 2 * LLAMA_METRICS_EVERY_MS;
    const poll = slotsLive && !asleep && (!policy.sleepCapable || latest !== null && (working || this.watch.following(mono))) && room();
    const slots = poll ? await this.readSlots(mono) : null;
    const observed = slots ? this.watch.observe(slots, at, mono, props.model) : { completion: null, decodeTps: null };

    const busy = slots?.filter(slot => slot.busy) ?? [];
    const counted = latest !== null && latest.processing !== null;
    const phase: Phase = asleep ? 'idle'
      : slots ? busy.length > 1 ? 'processing' : busy.length === 1 ? (busy[0]!.decoded ?? 0) > 0 ? 'decode' : 'prefill'
        : (latest?.deferred ?? 0) > 0 ? 'queued' : 'idle'
      : counted ? latest!.processing! >= 1 ? 'processing' : (latest!.deferred ?? 0) > 0 ? 'queued' : 'idle' : 'unknown';
    const single = busy.length === 1 ? busy[0]! : null;
    const request: RequestV2 | null = single ? defined({
      model: props.model, decodeTps: opt(observed.decodeTps), promptTokens: opt(promptOf(single)), cachedTokens: opt(single.cached),
      outputTokens: opt(single.decoded), contextWindowTokens: opt(positive(single.contextWindowTokens)), contextUsedTokens: opt(single.held),
    }) : null;
    const base = (windowMs: number) => latest ? this.scrapes.find(item => item !== latest && latest.mono - item.mono <= windowMs) : undefined;
    const rateBase = base(LLAMA_RATE_WINDOW_MS), specBase = base(LLAMA_SPECULATIVE_WINDOW_MS);
    const server: RuntimeV2['server'] = defined({
      active: asleep ? 0 : slots ? busy.length : counted ? latest!.processing! : null,
      queued: asleep ? 0 : latest?.deferred ?? null,
      rates: rateBase && latest ? llamaRates(rateBase.parse, latest.parse, latest.mono - rateBase.mono) : undefined,
      speculative: specBase && latest ? llamaSpeculative(specBase.parse, latest.parse, latest.mono - specBase.mono) : undefined,
    });
    const status: StatusV2 = asleep ? { state: 'ready', reason: 'sleeping', params: {} }
      // S7b rule 4: a sleep-capable build without a usable /metrics shows no live slots.
      : policy.sleepCapable && !metricsUsable ? { state: 'degraded', reason: 'metrics_required', params: { wakes: policy.wakes } }
      : { state: 'ready', reason: null, params: {} };
    const capabilities: CapabilityDescriptor[] = [
      ...props.model ? [{ key: 'server.catalog', basis: 'reported' } as const] : [],
      ...asleep || slots || counted ? [{ key: 'server.requests', basis: 'reported' } as const] : [],
      ...slotsLive ? [{ key: 'server.slots', basis: 'reported' }, { key: 'server.completions', basis: 'observed' },
        { key: 'request.decodeRate', basis: 'observed' }, { key: 'request.tokens', basis: 'reported' }, { key: 'request.context', basis: 'reported' }] as const : [],
      ...metricsUsable ? [{ key: 'server.rates', basis: 'derived' } as const] : [],
      ...metricsUsable && latest && sampleValue(latest.parse, M.drafted) !== null ? [{ key: 'server.speculative', basis: 'derived' } as const] : [],
    ];
    const runtime: RuntimeV2 = { phase, request, server, memory: {}, residency: [], slots: slots ? wireSlots(slots) : [],
      catalog: catalogOf(props, !asleep), engines: [] };
    return this.reading(at, status, runtime, capabilities, observed.completion ? [observed.completion] : []);
  }

  /** Still llama-server (a router included): the same bare /props read, never more than every 60 s. */
  async identity(): Promise<boolean> {
    try { return await this.loadProps(this.context.monotonic(), false) !== 'unsupported'; } catch (error) {
      if (error instanceof HttpFailure && error.reason === 'authentication_failed') return true;
      throw error;
    }
  }
  dispose(): void { this.scrapes = []; this.watch.reset(); }
}

const hint = (id: string, name: string): boolean => /(?<!o)llama[\s._-]*(?:cpp|server)/i.test(`${id} ${name}`);
export const LLAMA_CAPABILITIES: readonly CapabilityDescriptor[] = [
  { key: 'server.requests', basis: 'reported' }, { key: 'server.slots', basis: 'reported' }, { key: 'server.rates', basis: 'derived' },
  { key: 'server.speculative', basis: 'derived' }, { key: 'server.catalog', basis: 'reported' }, { key: 'server.completions', basis: 'observed' },
  { key: 'request.decodeRate', basis: 'observed' }, { key: 'request.tokens', basis: 'reported' }, { key: 'request.context', basis: 'reported' },
];

export const llamaDescriptor: DescriptorV2 = {
  id: 'llama-server', hints: hint,
  detect: [
    { probe: '/props', confidence: 'high', match: reply => reply.status === 200 && !reply.routeMissing && isLlamaProps(reply.body) },
    // /health is public on llama-server, /props is not: its own 401 body shape marks a keyed server.
    { probe: '/props', confidence: 'low', match: reply => reply.status === 401 && isLlamaAuthError(reply.body) },
  ],
  cadence: ({ activity }) => activity ? LLAMA_SLOTS_EVERY_MS : LLAMA_IDLE_EVERY_MS,
  capabilities: LLAMA_CAPABILITIES, identityEveryMs: 60_000,
  create: context => new LlamaAdapter(context),
};

import { randomBytes } from 'node:crypto';
import type { CompletionsV2, CompletionV2 } from '../src/contract/completion.ts';
import { CONFIG_ISSUES, type ConfigIssue, type ReasonParams, type StatusReason } from '../src/contract/reasons.ts';
import type { RuntimeKind } from '../src/contract/runtime.ts';
import type { CompatV1, ConnectionV2, Phase, RuntimeV2, StatusV2 } from '../src/contract/snapshot.ts';
import { resolveRuntimeConnections, type RuntimeConnections, type RuntimeConnectionConfig } from './config.ts';
import type { AdapterContextV2, AdapterReadingV2, AdapterV2, CompletionDraft, DescriptorV2, RuntimeGet, RuntimeGetText, Tier } from './core/adapter-v2.ts';
import { descriptorOf, descriptorsWith, detect, type Detection } from './core/registry.ts';
import { FLOOR_MS, Scheduler, type Outcome, type Slot } from './core/scheduler.ts';
import { failuresOf, stepSlot } from './core/slot.ts';
import type { VerdictV2 } from './core/verdicts.ts';
import { HttpFailure, type FetchImplementation } from './http.ts';
import type { Exec } from './lib/argv.ts';
import { requestReply, requestText } from './lib/http-text.ts';
import type { LMStudioActivityStream } from './lmstudio-activity.ts';

/** What a frame asked for: an explicit runtime is never switched away from, and an empty provider is Automatic (1.6). */
export interface ReadSelection { provider?: string; runtime?: RuntimeKind | null }
export interface ReadRequest { tier: Tier; detail: boolean }
/** A completion ring for one slot. svc-history's CompletionRing fits; seqs must be unique service-wide (verdicts key on them). */
export interface CompletionSink {
  readonly head: number;
  append(draft: CompletionDraft, host: CompletionV2['host']): CompletionV2;
  since(since: number | undefined, verdict: (seq: number) => VerdictV2 | undefined): CompletionsV2;
}
/** What a v2 body needs beyond the adapter reading. Nothing here is class A; `port` and `slot` never leave the service except as a status param. */
export interface ReadingMeta {
  connection: ConnectionV2;
  port: number | null;
  slot: string | null;                       // opaque slot key for per-slot rings
  failures: number;
  idleMs: number;
  completions: CompletionSink | null;        // the slot's ring; null when no slot serves the selection
  compat: CompatV1;                          // the 2a bridge while the 1.6 panel reads it; its English is always null
}
export type RuntimeReading = AdapterReadingV2 & { meta: ReadingMeta };

type Options = {
  fetchImpl?: FetchImplementation;
  readConfig?: () => Promise<RuntimeConnections>;
  now?: () => number;
  monotonicNow?: () => number;
  requestTimeoutMs?: number;
  collectionDeadlineMs?: number;
  /** Local LM Studio log-stream source for the bridged LM Studio adapter; omitted or `null` keeps it inventory-only. */
  lmstudioActivity?: LMStudioActivityStream | null;
  /** The runtimes this client knows; default: the registry, with the bridge wired to `lmstudioActivity`. */
  descriptors?: readonly DescriptorV2[];
  /** Allowlisted exec for adapters (svc-host's argv.ts); default runs nothing. */
  exec?: Exec;
  instance?: string;
  /** One ring per slot; default keeps the newest 64 with service-wide seqs. */
  completions?: (instance: string, next: () => number) => CompletionSink;
};
type SlotContext = {
  choice: RuntimeConnectionConfig;
  explicit: RuntimeKind | null;              // chosen by the user: re-detection reports a change and never switches
  runtime: RuntimeKind | null;               // what the adapter reads as; null until detection identifies it
  detection: ConnectionV2['detection'];
  adapter: AdapterV2 | null;
  identityAt: number;                        // monotonic time of the adapter's creation or last identity check
  changed: RuntimeKind | null;               // an explicit runtime's port now answers as this one
  generationKey: string | undefined;
  ring: CompletionSink;
  deadline: number;                          // this collection's budget; the adapter outlives one collection
};
type Collected = { reading: AdapterReadingV2; tier: Tier; detail: boolean };

const ACTIVE = new Set<Phase>(['decode', 'prefill', 'processing', 'queued']);
/** Work in progress: the phases polled at the active cadence. */
export const busy = (runtime: RuntimeV2): boolean => ACTIVE.has(runtime.phase);
const urlPort = (url: URL | null): number | null => {
  const port = url?.port ? Number(url.port) : NaN;
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
};
const issueOf = (issue: string): ConfigIssue => CONFIG_ISSUES.includes(issue as ConfigIssue) ? issue as ConfigIssue : 'missing_endpoint';
const EMPTY: RuntimeV2 = { phase: 'unknown', request: null, server: { active: null, queued: null }, memory: {}, residency: [], slots: [], catalog: [], engines: [] };
/** A reading the service makes itself: nothing is known about the runtime, so nothing is claimed (P3). */
const synthetic = (at: number, status: StatusV2): AdapterReadingV2 => ({ at, status, capabilities: {}, runtime: structuredClone(EMPTY), identity: {}, completions: [] });
const failing = (reason: StatusReason, params: ReasonParams = {}): StatusV2 => ({ state: 'failing', reason, params });
const PORT_REASONS = new Set<StatusReason | null>(['runtime_unreachable', 'authentication_failed', 'unsupported_runtime', 'unsupported_contract', 'detecting', 'redetecting', 'runtime_changed']);
const probed = ({ confidence, probe }: Detection): ConnectionV2['detection'] => ({ basis: 'probe', confidence, probe });

/** The newest 64 completions of one slot, numbered from a service-wide counter; `reset` when a cursor is foreign or fell off. */
class RecentCompletions implements CompletionSink {
  private items: CompletionV2[] = [];
  private dropped = 0;
  constructor(private readonly instance: string, private readonly next: () => number) {}
  get head(): number { return this.items.at(-1)?.seq ?? this.dropped; }
  append(draft: CompletionDraft, host: CompletionV2['host']): CompletionV2 {
    const item: CompletionV2 = { ...draft, seq: this.next(), host };
    this.items.push(item);
    if (this.items.length > 64) this.dropped = this.items.shift()!.seq;
    return item;
  }
  since(since: number | undefined, verdict: (seq: number) => VerdictV2 | undefined): CompletionsV2 {
    const reset = since !== undefined && (since > this.head || since < this.dropped);
    const items = this.items.filter(item => since === undefined || reset || item.seq > since)
      .map(item => { const label = verdict(item.seq); return label ? { ...item, verdict: label } : item; });
    return { instance: this.instance, cursor: this.head, reset, items };
  }
}

/** The 1.6 panel's connection health word for a status. */
const diagnosticOf = ({ state, reason, params }: StatusV2): NonNullable<CompatV1['connection']>['diagnostic'] =>
  state === 'ready' || state === 'degraded' && reason !== 'unsupported_contract' ? 'ready'
    : reason === 'configuration_missing' ? ['malformed_config', 'unreadable_config', 'read_failed'].includes(String(params.issue)) ? 'unreadable'
      : params.issue === 'invalid_endpoint' || params.issue === 'unsupported_config' ? 'invalid' : 'missing'
      : reason === 'authentication_failed' ? 'authentication' : reason === 'unsupported_contract' || reason === 'unsupported_runtime' ? 'unsupported' : 'offline';
/** 1.6 coverage tiers, from the v2 reading. */
const coverageOf = (runtime: RuntimeKind, available: boolean, reading: RuntimeV2): NonNullable<CompatV1['connection']>['coverage'] => {
  switch (runtime) {
    case 'omlx': return 'requests';
    case 'lmstudio': return available && reading.phase !== 'unknown' ? 'requests' : 'inventory';
    case 'vllm-mlx': return available && reading.phase === 'unknown' && reading.server.active === null ? 'server' : 'requests';
    case 'llama-server': return reading.server.active !== null ? 'requests' : 'server';
    case 'splash': return 'server';
    default: return 'inventory';
  }
};
/** The headline model for adapters without the bridge: the request's, the resident one, or a single-model catalogue's. */
const modelOf = (runtime: RuntimeV2): { model: string | null; context: number | null } => {
  const single = runtime.catalog.length === 1 ? runtime.catalog[0]! : null;
  const model = runtime.request?.model ?? runtime.residency[0]?.model ?? single?.name ?? null;
  const context = runtime.request?.contextWindowTokens ?? runtime.residency[0]?.contextWindowTokens
    ?? runtime.catalog.find(entry => entry.name === model)?.contextWindowTokens ?? null;
  return { model, context };
};

/** One demand-driven pipeline per selected connection; credentials never enter a reading. */
export class RuntimeClient {
  private readonly fetchImpl: FetchImplementation;
  private readonly readConfig: () => Promise<RuntimeConnections>;
  private readonly now: () => number;
  private readonly monotonic: () => number;
  private readonly timeout: number;
  private readonly budget: number;
  private readonly lmstudioActivity: LMStudioActivityStream | null;
  private readonly descriptors: readonly DescriptorV2[];
  private readonly exec: Exec;
  private readonly instance: string;
  private readonly ring: (instance: string, next: () => number) => CompletionSink;
  private configuration: RuntimeConnections | null = null;
  private configAt = -Infinity;
  private configFlight: Promise<RuntimeConnections> | null = null;
  private readonly scheduler: Scheduler<SlotContext, Collected>;
  private seq = 0;
  private head = 0;

  constructor(options: Options = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.readConfig = options.readConfig ?? resolveRuntimeConnections;
    this.now = options.now ?? Date.now;
    this.monotonic = options.monotonicNow ?? (options.now ? options.now : () => performance.now());
    this.timeout = options.requestTimeoutMs ?? 3000;
    this.budget = options.collectionDeadlineMs ?? 8000;
    this.lmstudioActivity = options.lmstudioActivity?.available ? options.lmstudioActivity : null;
    this.descriptors = options.descriptors ?? descriptorsWith({ activity: port => this.lmstudioActivity?.forPort(port) ?? null });
    this.exec = options.exec ?? (async () => null);
    this.instance = options.instance ?? randomBytes(4).toString('hex');
    this.ring = options.completions ?? ((instance, next) => new RecentCompletions(instance, next));
    this.scheduler = new Scheduler(this.monotonic, undefined, slot => slot.context.adapter?.dispose());
  }

  /** The newest completion seq this client has assigned; attribution verdicts may only name one at or below it. */
  get completionHead(): number { return this.head; }
  dispose(): void {
    for (const slot of this.scheduler.all()) slot.context.adapter?.dispose();
    this.lmstudioActivity?.stop();
  }

  private async config(): Promise<RuntimeConnections> {
    if (this.configuration && this.monotonic() - this.configAt < 5000) return this.configuration;
    if (!this.configFlight) this.configFlight = this.readConfig().then(value => {
      this.configuration = value; this.configAt = this.monotonic(); return value;
    }).finally(() => { this.configFlight = null; });
    return this.configFlight;
  }

  /**
   * Automatic + an explicit runtime keeps its 1.6 meaning: the first connection whose hint names that runtime, else one
   * whose automatic slot detected it, else the first connection (1.6 read that one as the chosen runtime).
   */
  private automatic(connections: RuntimeConnectionConfig[], runtime: RuntimeKind | null): RuntimeConnectionConfig | undefined {
    if (!runtime) return connections[0];
    return connections.find(item => item.runtime === runtime)
      ?? connections.find(item => this.scheduler.peek(`${item.id}\0auto`)?.context.runtime === runtime) ?? connections[0];
  }

  async read(selection?: ReadSelection, request: ReadRequest = { tier: 'full', detail: false }): Promise<RuntimeReading> {
    let configuration: RuntimeConnections, readFailed = false;
    try { configuration = await this.config(); } catch { configuration = { connections: [], issue: 'unreadable_config', error: null }; readFailed = true; }
    const connections = configuration.connections, explicit = selection?.runtime ?? null;
    const choice = selection?.provider ? connections.find(item => item.id === selection.provider) : this.automatic(connections, explicit);
    const choices = connections.slice(0, 8).map(item => ({ id: item.id, label: item.label, runtime: item.runtime }));
    const detection: ConnectionV2['detection'] = explicit ? { basis: 'explicit', confidence: 'high' }
      : choice?.runtime ? { basis: 'hint', confidence: 'medium' } : { basis: 'probe', confidence: 'low' };
    const connection: ConnectionV2 = { id: choice?.id ?? 'auto', label: choice?.label ?? 'Automatic', runtime: explicit ?? choice?.runtime ?? null,
      generation: 0, choices, detection };
    const port = urlPort(choice?.config.baseURL ?? null);
    if (!choice) {
      const issue: ConfigIssue = selection?.provider ? 'removed' : readFailed ? 'read_failed' : issueOf(configuration.issue);
      return this.unslotted(connection, { state: 'unconfigured', reason: 'configuration_missing', params: { issue } }, null, null);
    }
    if (!choice.config.baseURL || !['none', 'missing_credential'].includes(choice.config.issue) || port === null) {
      return this.unslotted(connection, { state: 'unconfigured', reason: 'configuration_missing', params: { issue: issueOf(choice.config.issue) } }, choice.id, port);
    }
    const key = `${choice.id}\0${explicit ?? 'auto'}`;
    const fingerprint = JSON.stringify([choice.config.baseURL.href, choice.config.apiKey, choice.config.preferredModel, choice.runtime, explicit]);
    const slot = this.scheduler.claim(key, fingerprint, () => ({ choice, explicit, runtime: explicit ?? choice.runtime, detection, adapter: null,
      identityAt: this.monotonic(), changed: null, generationKey: undefined, ring: this.ring(this.instance, () => ++this.seq), deadline: 0 }));
    // All eight slots are mid-read: this one waits its turn (1.6 "Earlier connection reads are finishing").
    if (!slot) return this.unslotted(connection, failing('runtime_unreachable', { port, deferred: true }), choice.id, port);
    const context = slot.context, described = context.runtime ? descriptorOf(this.descriptors, context.runtime) : null;
    const recovering = slot.value?.reading.status.state === 'recovering';
    const cadence = described ? described.cadence({ activity: this.lmstudioActivity !== null, tier: request.tier, recovering }) : FLOOR_MS;
    const collected = await this.scheduler.read(slot, cadence, () => this.collect(slot, request), outcome,
      value => (value.tier === 'full' || request.tier === 'glance') && (value.detail || !request.detail));
    return this.assemble(slot, collected.reading, connection, port);
  }

  private unslotted(connection: ConnectionV2, status: StatusV2, selected: string | null, port: number | null): RuntimeReading {
    const reading = synthetic(this.now(), status);
    return { ...reading, meta: { connection, port, slot: null, failures: 0, idleMs: 0, completions: null,
      compat: { message: null, connection: { selected, generation: null, diagnostic: diagnosticOf(status), coverage: null }, modelID: null,
        contextWindow: null, statsState: 'unavailable', guardLevel: null, lastMissReason: null, traceEpoch: null } } };
  }

  /** The runtime's own reading plus what only the service knows: port, key presence, a changed runtime, Bionic and Splash. */
  private assemble(slot: Slot<SlotContext, Collected>, reading: AdapterReadingV2, base: ConnectionV2, port: number): RuntimeReading {
    const context = slot.context, choice = context.choice, runtime = context.runtime ?? context.explicit ?? choice.runtime;
    const raw = context.changed ? { state: 'degraded' as const, reason: 'runtime_changed' as const, params: { detected: context.changed } } : reading.status;
    const params: ReasonParams = { ...raw.params, ...PORT_REASONS.has(raw.reason) ? { port } : {} };
    if (raw.reason === 'runtime_unreachable' && slot.state.kind === 'failing') params.sinceAt = Math.round(this.now() - (this.monotonic() - slot.state.since));
    if (raw.reason === 'authentication_failed') params.keySaved = choice.config.apiKey !== null;
    const status: StatusV2 = { ...raw, params };
    const splashModels = runtime === 'lmstudio' && reading.runtime.catalog.some(model => model.format === 'splash');
    const identity = {
      ...reading.identity.version ? { version: reading.identity.version } : {},
      engine: reading.identity.engine ?? (runtime === 'splash' || splashModels ? 'splash' as const : null),
      host: reading.identity.host ?? (runtime === 'lmstudio' && (splashModels || /bionic/i.test(`${choice.id} ${choice.label}`)) ? 'bionic' as const : null),
    };
    const connection: ConnectionV2 = { ...base, runtime, generation: slot.generation, detection: context.detection, ...identity };
    const available = status.state === 'ready' || status.state === 'degraded', legacy = reading.compat, headline = modelOf(reading.runtime);
    const compat: CompatV1 = {
      message: null, ...legacy?.phase ? { phase: legacy.phase } : {}, ...legacy && 'runtime' in legacy ? { runtime: legacy.runtime } : {},
      connection: { selected: choice.id, generation: slot.marker, diagnostic: diagnosticOf(status), coverage: runtime ? coverageOf(runtime, available, reading.runtime) : null },
      modelID: legacy ? legacy.modelID : available ? headline.model : null, contextWindow: legacy ? legacy.contextWindow : available ? headline.context : null,
      statsState: legacy?.statsState ?? (available && reading.runtime.server.averages ? 'fresh' : 'unavailable'),
      guardLevel: legacy?.guardLevel ?? null, lastMissReason: legacy?.lastMissReason ?? null, traceEpoch: legacy?.traceEpoch ?? null,
    };
    return { ...reading, status, identity, meta: { connection, port, slot: slot.key, failures: failuresOf(slot.state),
      idleMs: Math.max(0, this.monotonic() - slot.activeAt), completions: context.ring, compat } };
  }

  /** GETs on the connection's origin within this collection's deadline; the key goes everywhere but `/health` (1.6). */
  private getters(slot: Slot<SlotContext, Collected>): { get: RuntimeGet; getText: RuntimeGetText } {
    const context = slot.context, base = context.choice.config.baseURL!, key = context.choice.config.apiKey;
    const target = (path: string): { url: URL; timeoutMs: number; init: RequestInit } => {
      const url = new URL(path, base), remaining = context.deadline - this.monotonic();
      // Paths only: an absolute or protocol-relative URL could leave the loopback origin with the key.
      if (!path.startsWith('/') || path.startsWith('//') || url.origin !== base.origin) throw new HttpFailure('runtime_unreachable', 'Only paths on the connection are read.');
      if (remaining <= 0) throw new HttpFailure('runtime_unreachable', 'The snapshot deadline expired.');
      return { url, timeoutMs: Math.min(this.timeout, remaining),
        init: { headers: { Accept: 'application/json', ...url.pathname !== '/health' && key ? { Authorization: `Bearer ${key}` } : {} } } };
    };
    return {
      get: async path => requestReply({ ...target(path), fetchImpl: this.fetchImpl }),
      getText: async (path, maxBytes) => requestText({ ...target(path), fetchImpl: this.fetchImpl, ...maxBytes ? { maxBytes } : {} }),
    };
  }

  private create(slot: Slot<SlotContext, Collected>, runtime: RuntimeKind): AdapterV2 {
    const context = slot.context, described = descriptorOf(this.descriptors, runtime);
    if (!described) throw new UnknownRuntime();
    const adapterContext: AdapterContextV2 = { connection: { id: context.choice.id, port: urlPort(context.choice.config.baseURL)! }, ...this.getters(slot),
      config: context.choice.config, fetchImpl: this.fetchImpl, exec: this.exec, now: this.now, monotonic: this.monotonic,
      timeoutMs: this.timeout, budgetMs: this.budget };
    try { return described.create(adapterContext); } catch { throw new UnknownRuntime(); }
  }

  /**
   * A detection pass on the slot's connection, hinted by what it reads as now. The same runtime clears a reported change;
   * another one replaces the adapter (a new generation), except for an explicit choice, which only reports it. A pass that
   * identifies nothing keeps everything: the runtime may just be restarting.
   */
  private async redetect(slot: Slot<SlotContext, Collected>, get: RuntimeGet): Promise<void> {
    const context = slot.context;
    const found = await detect(this.descriptors, get, context.explicit ?? context.runtime ?? context.choice.runtime);
    slot.state = stepSlot(slot.state, { kind: 'redetect' }, this.monotonic());
    if (!found.runtime) return;
    if (found.runtime === context.runtime) { context.changed = null; return; }
    if (context.explicit) { context.changed = found.runtime; return; }
    context.adapter?.dispose();
    Object.assign(context, { adapter: null, runtime: found.runtime, detection: probed(found), changed: null, generationKey: undefined });
    this.scheduler.bump(slot);
  }

  private async collect(slot: Slot<SlotContext, Collected>, request: ReadRequest): Promise<Collected> {
    const context = slot.context, done = (reading: AdapterReadingV2): Collected => ({ reading, tier: request.tier, detail: request.detail });
    context.deadline = this.monotonic() + this.budget;
    const { get } = this.getters(slot);
    let reading: AdapterReadingV2;
    try {
      // A change already reported is refreshed by the identity interval, not by every unsupported reading.
      if (slot.redetect) { slot.redetect = false; if (!context.changed) await this.redetect(slot, get); }
      if (!context.runtime) {
        const found = await detect(this.descriptors, get, context.choice.runtime);
        if (!found.runtime) return done(synthetic(this.now(), found.locked ? failing('authentication_failed')
          : { state: 'unconfigured', reason: 'unsupported_runtime', params: {} }));
        Object.assign(context, { runtime: found.runtime, detection: probed(found) });
      }
      const described = descriptorOf(this.descriptors, context.runtime!);
      if (!context.adapter) { context.adapter = this.create(slot, context.runtime!); context.identityAt = this.monotonic(); }
      else if (described && (context.changed || this.monotonic() - context.identityAt >= described.identityEveryMs)) {
        // While a change is reported, every collection asks whether the chosen runtime is back; a pass runs on the interval.
        const due = this.monotonic() - context.identityAt >= described.identityEveryMs;
        if (due) context.identityAt = this.monotonic();
        if (await context.adapter.identity().catch(() => false)) context.changed = null;
        else if (due) {
          await this.redetect(slot, get);
          if (!context.adapter) { context.adapter = this.create(slot, context.runtime!); context.identityAt = this.monotonic(); }
        }
      }
      reading = await context.adapter!.read({ deadline: context.deadline, tier: request.tier, detail: request.detail });
    } catch (error) {
      reading = synthetic(this.now(), error instanceof UnknownRuntime ? { state: 'unconfigured', reason: 'unsupported_runtime', params: {} }
        : failing(error instanceof HttpFailure && error.reason === 'authentication_failed' ? 'authentication_failed' : 'runtime_unreachable'));
    }
    // A runtime-reported change (LM Studio loading or unloading a model) is a new generation; the key never leaves.
    if (reading.generationKey !== undefined) {
      if (context.generationKey !== undefined && reading.generationKey !== context.generationKey) this.scheduler.bump(slot);
      context.generationKey = reading.generationKey;
    }
    for (const draft of reading.completions) this.head = Math.max(this.head, context.ring.append(draft, {}).seq);
    return done(reading);
  }
}
class UnknownRuntime extends Error {}

/** The slot machine's view of a reading. An unsupported reading is degraded and counts toward re-detection. */
const outcome = ({ reading }: Collected): Outcome => {
  const { state, reason } = reading.status;
  return {
    event: state === 'failing' ? { kind: 'failed', reason: reason === 'authentication_failed' ? 'authentication_failed' : 'runtime_unreachable' }
      : state === 'unconfigured' ? { kind: 'failed', reason: 'unsupported_runtime' }
        : state === 'ready' ? { kind: 'ready' } : { kind: 'degraded', unsupported: reason === 'unsupported_contract' },
    active: busy(reading.runtime),
  };
};

import { capabilitiesOf, type Basis, type Capabilities, type CapabilityDescriptor, type CapabilityKey } from '../../src/contract/capabilities.ts';
import { count, defined, list, modelLabel, nonneg, obj, opt, type Json } from '../../src/contract/guards.ts';
import type { MemoryGuard, Phase, RequestV2, ResidencyV2, RuntimeV2, StatusV2 } from '../../src/contract/snapshot.ts';
import { HINTS } from '../core/hints.ts';
import type { AdapterContextV2, AdapterReadingV2, AdapterV2, DescriptorV2, ReadContext } from '../core/adapter-v2.ts';
import { FLOOR_MS } from '../core/scheduler.ts';
import { HttpFailure, requestJSON, type JsonResponse } from '../http.ts';
import { normalizeOmlx, normalizeSession, type OmlxNormalized, type OmlxPhase, type OmlxResident, type OmlxSession } from './omlx-normalize.ts';

// oMLX 0.7 on the v2 contract (plan §5.2, SPIKES S6). GET only, except the admin login 1.6 already sent (P1). The admin
// session reads live activity; a refused login (a sub key) falls back to `/api/status` with server coverage. Never
// `/admin/api/stats`: it carries the plaintext main key. Request ids stay in this module's memory.

export const OMLX_PATHS = { health: '/health', status: '/api/status', activity: '/admin/api/activity', login: '/admin/api/login',
  models: '/v1/models/status' } as const;
const HEALTH_EVERY_MS = 60_000;              // the engine-pool ceiling; identity() refreshes it too
const MODELS_EVERY_MS = 60_000;              // context windows (1.6)
const STATUS_EVERY_MS = { full: 10_000, glance: 60_000 } as const;   // session totals; the fallback reads them every time
export const ADMIN_RETRY_MS = 300_000;       // a refused admin login is retried this rarely
const STALL_MS = 15_000;                     // prefill progress unchanged this long is stale (1.6)
const RESTART_SLACK_MS = 5_000;
const SESSION_STALE_MS = 120_000;            // session totals older than this are withheld, not shown as current

type Reply = Pick<JsonResponse, 'status' | 'body'>;

/** `/health` identifies oMLX: `healthy` (200) or `loading` (503), with an engine pool, or 0.7's `engine_pool: null`. */
export const isOmlxHealth = (body: Json | null, status: number): boolean => {
  const state = status === 200 ? 'healthy' : status === 503 ? 'loading' : null;
  if (state === null || body?.status !== state || !Object.hasOwn(body, 'engine_pool')) return false;
  // A pool that is not built yet leaves `engine_pool` and `default_model` null (0.7.0rc1); both keys are still sent.
  if (body.engine_pool === null) return Object.hasOwn(body, 'default_model') && (body.default_model === null || typeof body.default_model === 'string');
  return count(obj(body.engine_pool)?.model_count) !== null;
};

const extractCookie = (value: string | null): string | null => {
  const match = value === null ? null : /(?:^|,\s*)omlx_admin_session=([^;,]+)/i.exec(value);
  return match?.[1] ?? null;
};
const refusal = (error: unknown): boolean => error instanceof HttpFailure && error.reason === 'authentication_failed';
const optional = <T>(work: Promise<T>): Promise<T | null> => work.catch(() => null);
const settle = <T>(work: Promise<T>): Promise<{ value: T } | { error: unknown }> => work.then(value => ({ value }), (error: unknown) => ({ error }));

/** One GET or the login POST against the connection's loopback origin, inside the read's deadline. */
const send = async (context: AdapterContextV2, path: string, deadline: number, init: RequestInit = {}): Promise<JsonResponse> => {
  const base = context.config.baseURL, remaining = deadline - context.monotonic();
  if (!base) throw new HttpFailure('runtime_unreachable', 'No oMLX endpoint is configured.');
  if (remaining <= 0) throw new HttpFailure('runtime_unreachable', 'The oMLX read deadline expired.');
  return requestJSON({ url: new URL(path, base), fetchImpl: context.fetchImpl, timeoutMs: Math.max(1, Math.min(context.timeoutMs, remaining)),
    allowLoadingHealth: path === OMLX_PATHS.health,
    init: { method: 'GET', ...init, headers: { Accept: 'application/json', ...init.headers as Record<string, string> } } });
};
/** Session totals and context windows take the key as a bearer token: sub keys are accepted there (S6). */
const bearer = (context: AdapterContextV2): Record<string, string> =>
  context.config.apiKey === null ? {} : { Authorization: `Bearer ${context.config.apiKey}` };

/**
 * The admin cookie behind activity and usage reads, shared by one slot's adapter and its usage reads. A refused login
 * is not retried for ADMIN_RETRY_MS; a rejected cookie is replaced once per read.
 */
export class AdminSession {
  private cookie: string | null = null;
  private pending: Promise<string | null> | null = null;
  private refusedAt = -Infinity;
  /** The last usage read's reason when it hid the card (route missing, recording off); null once one succeeds. */
  usageHidden: string | null = null;
  constructor(private readonly context: AdapterContextV2) {}

  get refused(): boolean { return this.context.monotonic() - this.refusedAt < ADMIN_RETRY_MS; }

  /** A cookie-bearing GET; 'refused' when the admin API will not take this key (or none). */
  async get(path: string, deadline: number): Promise<JsonResponse | 'refused'> {
    if (this.refused) return 'refused';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const fresh = this.cookie === null;
      const cookie = fresh ? await this.login(deadline) : this.cookie;
      if (this.refused) return 'refused';
      try {
        return await send(this.context, path, deadline, { headers: cookie === null ? {} : { Cookie: `omlx_admin_session=${cookie}` } });
      } catch (error) {
        if (!refusal(error)) throw error;
        this.cookie = null;
        // A fresh cookie (or no key at all) that is still refused means this key cannot read the admin API.
        if (fresh) break;
      }
    }
    this.refusedAt = this.context.monotonic();
    return 'refused';
  }

  /** Respects the server's auth policy: no key means no login, and a rejected key is never retried without auth. */
  private login(deadline: number): Promise<string | null> {
    const key = this.context.config.apiKey;
    if (key === null) return Promise.resolve(null);
    this.pending ??= send(this.context, OMLX_PATHS.login, deadline, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, remember: false }) }).then(response => {
      this.cookie = extractCookie(response.setCookie);
      if (this.cookie === null) this.refusedAt = this.context.monotonic();
      return this.cookie;
    }, error => {
      if (!refusal(error)) throw error;
      this.refusedAt = this.context.monotonic();
      return null;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
}
const sessions = new WeakMap<AdapterContextV2, AdminSession>();
/** One admin session per adapter context, so `/v2/usage` reads reuse the adapter's login. */
export const adminSession = (context: AdapterContextV2): AdminSession => {
  let session = sessions.get(context);
  if (!session) sessions.set(context, session = new AdminSession(context));
  return session;
};

/** `/api/status`: 23 keys in 0.6.4 and 0.7 (fixture report); these are the ones Scope reads. */
const isStatusBody = (body: Json | null): body is Json => body !== null && typeof body.version === 'string'
  && count(body.active_requests) !== null && count(body.waiting_requests) !== null && Array.isArray(body.loaded_models);
const VERSION = /^[A-Za-z0-9._+-]{1,40}$/;
const versionOf = (body: Json | null): string | undefined => typeof body?.version === 'string' && VERSION.test(body.version) ? body.version : undefined;
/** The usage route arrived in 0.7 (0.6.4 → 404). */
const hasUsage = (version: string | undefined): boolean => {
  const match = version ? /^(\d+)\.(\d+)/.exec(version) : null;
  return match !== null && (Number(match[1]) > 0 || Number(match[2]) >= 7);
};
const contextWindowsOf = (body: Json | null): Map<string, number> => {
  const result = new Map<string, number>();
  for (const item of Array.isArray(body?.models) ? body.models : []) {
    const model = obj(item), limit = count(model?.max_context_window);
    if (typeof model?.id === 'string' && limit) result.set(model.id, limit);
  }
  return result;
};
/** `engine_pool.final_ceiling` (plan §5.2); 0 means the guard is off, so there is no ceiling. */
const ceilingOf = (health: Json | null): number | null => { const n = count(obj(health?.engine_pool)?.final_ceiling); return n ? n : null; };

// v2 mapping of the normalizer's reading (mirrors src/contract/convert-v1.ts for oMLX, in v2 units).
const GUARDS: Record<number, MemoryGuard> = { 1: 'ok', 2: 'soft', 3: 'hard' };
const phaseOf = (phase: OmlxPhase, loading: boolean, active: number | null): Phase =>
  phase === 'notLoaded' ? 'not-loaded' : phase === 'processing' && loading && !active ? 'loading' : phase;
const valid = (n: number | null): n is number => n !== null && Number.isSafeInteger(n) && n >= 0;
/** Reported prompt + output against the model limit, only where one request is live (convert-v1, panel/context.ts). */
const contextUsed = (n: OmlxNormalized): number | null => {
  if (!['prefill', 'decode', 'processing'].includes(n.phase) || (n.activeRequests ?? 0) > 1) return null;
  const prompt = n.promptTokens, limit = n.contextWindow, output = n.phase === 'prefill' ? 0 : n.completionTokens;
  if (!valid(prompt) || !valid(limit) || limit === 0 || !valid(output)) return null;
  const used = prompt + output;
  return Number.isSafeInteger(used) && used <= limit ? used : null;
};
export const requestOf = (n: OmlxNormalized): RequestV2 | null => {
  const reading = defined({
    decodeTps: opt(n.liveDecodeTPS), prefillTps: opt(n.livePrefillTPS), prefillProcessedTokens: opt(n.prefillProcessedTokens),
    prefillTotalTokens: opt(n.prefillTotalTokens), prefillFraction: opt(n.prefillProgress), prefillStale: n.prefillProgressStale || undefined,
    prefillEtaMs: opt(n.prefillEtaMs), promptTokens: opt(n.promptTokens), cachedTokens: opt(n.cachedTokens), outputTokens: opt(n.completionTokens),
    elapsedMs: opt(n.elapsedMs), contextUsedTokens: opt(contextUsed(n)),
  });
  return Object.keys(reading).length ? defined({ model: n.modelID, ...reading, contextWindowTokens: opt(n.contextWindow) }) : null;
};
const residentOf = (r: OmlxResident): ResidencyV2 => {
  const phase = phaseOf(r.phase, r.loading, r.activeRequests), active = count(r.activeRequests);
  // Per-model speed and progress only while that model has at most one request (the v2 parser's rule).
  const single = (active ?? 0) <= 1, prefill = single && phase === 'prefill';
  return defined({ model: r.id, phase, source: 'runtime' as const, active: opt(active), queued: opt(count(r.queuedRequests)),
    bytes: opt(r.allocationBytes), contextWindowTokens: opt(r.contextWindow),
    decodeTps: single && phase === 'decode' ? opt(r.tokensPerSecond) : undefined,
    prefillFraction: prefill ? opt(r.prefillProgress) : undefined, prefillTps: prefill && !r.progressStale ? opt(r.tokensPerSecond) : undefined,
    prefillStale: r.progressStale || undefined });
};
/** `/api/status` reports 0.0 rates with nothing behind them (fixture report): a rate that is exactly 0 is withheld. */
const averagesOf = (s: OmlxSession): NonNullable<RuntimeV2['server']['averages']> => defined({
  decodeTps: s.sessionAverageDecodeTPS ? s.sessionAverageDecodeTPS : undefined,
  prefillTps: s.sessionAveragePrefillTPS ? s.sessionAveragePrefillTPS : undefined,
  cacheEfficiencyFraction: s.lifetime?.promptTokensTotal ? opt(s.sessionCacheEfficiencyFraction) : undefined,
  requestsTotal: opt(count(s.lifetime?.requestsTotal)), uptimeMs: opt(s.lifetime?.uptimeMs),
});
const nonEmpty = <T extends object>(value: T): T | undefined => Object.keys(value).length ? value : undefined;

const R: Basis = 'reported';
/** The most oMLX reports (admin session, guard on, 0.7). Each reading narrows it. */
export const OMLX_CAPABILITIES: readonly CapabilityDescriptor[] = [
  { key: 'request.decodeRate', basis: R }, { key: 'request.prefillRate', basis: R }, { key: 'request.prefillProgress', basis: R },
  { key: 'request.prefillEta', basis: 'estimate' }, { key: 'request.tokens', basis: R }, { key: 'request.elapsed', basis: R },
  { key: 'request.context', basis: 'derived' }, { key: 'server.requests', basis: R }, { key: 'server.averages', basis: R },
  { key: 'server.cache', basis: R }, { key: 'server.memory.process', basis: R }, { key: 'server.memory.model', basis: R },
  { key: 'server.memory.ceiling', basis: R }, { key: 'server.residency', basis: R }, { key: 'server.usage', basis: R },
  // RequestWatch (svc-history) derives these from successive request readings (contract §4).
  { key: 'server.completions', basis: 'last-observed' },
];
const LIVE_KEYS: readonly CapabilityKey[] = ['request.decodeRate', 'request.prefillRate', 'request.prefillProgress', 'request.prefillEta',
  'request.tokens', 'request.elapsed', 'server.completions'];
const capabilities = (keys: Iterable<CapabilityKey | false>): Capabilities => {
  const wanted = new Set([...keys].filter((key): key is CapabilityKey => key !== false));
  return capabilitiesOf(OMLX_CAPABILITIES.filter(({ key }) => wanted.has(key)));
};

const EMPTY_RUNTIME = (): RuntimeV2 => ({ phase: 'unknown', request: null, server: { active: null, queued: null }, memory: {}, residency: [],
  slots: [], catalog: [], engines: [] });
const READY: StatusV2 = { state: 'ready', reason: null, params: {} };
const FALLBACK: StatusV2 = { state: 'degraded', reason: 'admin_unauthorized', params: {} };
const UNSUPPORTED: StatusV2 = { state: 'degraded', reason: 'unsupported_contract', params: {} };

export class OmlxAdapter implements AdapterV2 {
  private readonly session: AdminSession;
  private health: { body: Json | null; at: number } = { body: null, at: -Infinity };
  private windows: { value: Map<string, number>; at: number } = { value: new Map(), at: -Infinity };
  private status: { body: Json | null; at: number; okAt: number; state: 'fresh' | 'stale' | 'unavailable' } =
    { body: null, at: -Infinity, okAt: -Infinity, state: 'unavailable' };
  private prefill = new Map<string, { processed: number; changedAt: number }>();
  private uptime: { ms: number; at: number } | null = null;
  private restarts = 0;
  private disposed = false;

  constructor(private readonly context: AdapterContextV2) { this.session = adminSession(context); }

  dispose(): void { this.disposed = true; this.prefill.clear(); }

  async identity(): Promise<boolean> {
    const deadline = this.context.monotonic() + this.context.budgetMs;
    const reply = await send(this.context, OMLX_PATHS.health, deadline);
    this.health = { body: reply.body, at: this.context.monotonic() };
    return isOmlxHealth(reply.body, reply.status);
  }

  async read({ deadline: outer, tier }: ReadContext): Promise<AdapterReadingV2> {
    if (this.disposed) throw new HttpFailure('runtime_unreachable', 'This oMLX reader was closed.');
    const started = this.context.monotonic(), deadline = Math.min(started + this.context.budgetMs, outer);
    const due = (at: number, every: number): boolean => started - at >= every;
    // While the fallback serves, `/api/status` is the live source: it is read every time and its failure fails the read.
    const healthDue = due(this.health.at, HEALTH_EVERY_MS), windowsDue = due(this.windows.at, MODELS_EVERY_MS);
    const statusDue = this.session.refused || due(this.status.at, STATUS_EVERY_MS[tier]);
    const [activity, health, windows, status] = await Promise.all([
      this.session.get(OMLX_PATHS.activity, deadline),
      healthDue ? optional(send(this.context, OMLX_PATHS.health, deadline)) : null,
      windowsDue ? optional(send(this.context, OMLX_PATHS.models, deadline, { headers: bearer(this.context) })) : null,
      statusDue ? settle(send(this.context, OMLX_PATHS.status, deadline, { headers: bearer(this.context) })) : null,
    ]);
    // Optional reads keep their last value; a failed one waits its full interval, like 1.6.
    if (healthDue) this.health = { body: health?.body ?? this.health.body, at: started };
    if (windowsDue) this.windows = { value: windows ? contextWindowsOf(windows.body) : this.windows.value, at: started };
    if (status && 'value' in status) this.observeStatus(status.value, started);
    else if (status) this.status = { ...this.status, at: started, state: this.status.body ? 'stale' : 'unavailable' };
    if (activity === 'refused') {
      if (status && 'error' in status) throw status.error;
      const reply = status?.value ?? await send(this.context, OMLX_PATHS.status, deadline, { headers: bearer(this.context) });
      if (!status) this.observeStatus(reply, started);
      return this.fallback(reply);
    }
    this.observeProgress(activity.body, started);
    // Session totals nobody could refresh for a while are withheld rather than shown as current.
    const session = started - this.status.okAt <= SESSION_STALE_MS ? this.status.body : null;
    const normalized = normalizeOmlx(session, activity.body, this.windows.value, this.context.config.preferredModel,
      this.context.now(), session ? this.status.state : 'unavailable');
    return normalized ? this.adminReading(normalized) : this.reading(UNSUPPORTED, EMPTY_RUNTIME(), {});
  }

  private observeStatus(reply: Reply, at: number): void {
    const body = isStatusBody(reply.body) ? reply.body : null;
    this.status = { body: body ?? this.status.body, at, okAt: body ? at : this.status.okAt, state: body ? 'fresh' : this.status.body ? 'stale' : 'unavailable' };
    // The server restarted when its uptime fell behind the time that passed: a new listener process (and footprint).
    // Monotonic time, so a Mac sleep that a monotonic uptime skips is not a restart.
    const uptimeMs = typeof body?.uptime_seconds === 'number' && body.uptime_seconds >= 0 ? body.uptime_seconds * 1000 : null;
    const now = this.context.monotonic();
    if (uptimeMs === null) return;
    if (this.uptime && uptimeMs + RESTART_SLACK_MS < this.uptime.ms + (now - this.uptime.at)) {
      this.restarts += 1;
      this.session.usageHidden = null;       // recording may have been switched on, or the build upgraded
    }
    this.uptime = { ms: uptimeMs, at: now };
  }

  /** Observe only in service memory: request ids never leave this map (1.6 `observeProgress`, minus the trace epoch). */
  private observeProgress(activity: Json | null, observedAt: number): void {
    const live = new Set<string>(), models = obj(activity?.active_models)?.models;
    for (const value of Array.isArray(models) ? models : []) {
      const model = obj(value);
      if (!model || obj(model.cluster) !== null) continue;
      for (const entry of Array.isArray(model.prefilling) ? model.prefilling : []) {
        const flight = obj(entry);
        if (!flight || typeof flight.request_id !== 'string' || !flight.request_id.trim()) continue;
        const key = JSON.stringify([model.id, flight.request_id, flight.phase, flight.total]), processed = nonneg(flight.processed);
        live.add(key);
        if (processed === null) continue;
        const previous = this.prefill.get(key);
        if (!previous || previous.processed !== processed) this.prefill.set(key, { processed, changedAt: observedAt });
        else if (observedAt - previous.changedAt >= STALL_MS) flight.progress_stale = true;
      }
    }
    for (const key of this.prefill.keys()) if (!live.has(key)) this.prefill.delete(key);
  }

  private reading(status: StatusV2, runtime: RuntimeV2, caps: Capabilities): AdapterReadingV2 {
    return { at: this.context.now(), status, capabilities: caps, runtime, identity: defined({ version: versionOf(this.status.body) }),
      generationKey: String(this.restarts), completions: [] };
  }
  private memory(guardLevel: number | null, processBytes: number | null, modelBytes: number | null): RuntimeV2['memory'] {
    // `/health` names the ceiling; `/api/status` reports the same pool figure when health has no pool to read.
    const pool = obj(this.health.body?.engine_pool);
    const ceiling = pool ? ceilingOf(this.health.body) : count(this.status.body?.model_memory_max) || null;
    return defined({ processBytes: opt(processBytes), modelBytes: opt(modelBytes), ceilingBytes: opt(ceiling),
      guard: guardLevel === null ? undefined : GUARDS[guardLevel] });
  }
  /** The pinned preload (`/health` 503 loading) is still running before any model is resident. */
  private preloading(phase: Phase): Phase { return phase === 'not-loaded' && this.health.body?.status === 'loading' ? 'loading' : phase; }
  private usable(): boolean { return hasUsage(versionOf(this.status.body)) && this.session.usageHidden === null; }

  private adminReading(n: OmlxNormalized): AdapterReadingV2 {
    const bank = n.sessionBank, averages = nonEmpty(averagesOf(n));
    const cache = bank ? nonEmpty(defined({ ramBytes: opt(bank.hot?.totalBytes), ramEntries: opt(count(bank.hot?.entries)),
      ssdBytes: opt(bank.cold?.totalBytes), ssdEntries: opt(count(bank.cold?.entries)) })) : undefined;
    const memory = this.memory(n.memoryPressureLevel, n.memory.activeBytes, n.memory.modelBytes);
    const runtime: RuntimeV2 = {
      sampledAt: n.sampledAt, phase: this.preloading(phaseOf(n.phase, n.loading, n.activeRequests)), request: requestOf(n),
      server: defined({ active: n.activeRequests === null ? null : count(n.activeRequests), queued: n.queuedRequests === null ? null : count(n.queuedRequests),
        averages, cache }),
      memory, residency: n.residentModels.map(residentOf), residencyCount: opt(n.residentModelCount), slots: [], catalog: [], engines: [],
    };
    return this.reading(READY, runtime, capabilities([...LIVE_KEYS, this.windows.value.size > 0 && 'request.context', 'server.requests',
      'server.residency', 'server.memory.model', averages !== undefined && 'server.averages', cache !== undefined && 'server.cache',
      memory.processBytes !== undefined && 'server.memory.process', memory.ceilingBytes !== undefined && 'server.memory.ceiling',
      this.usable() && 'server.usage']));
  }

  /** Server coverage from `/api/status`: counts, totals and model memory; no per-request values, replies or usage. */
  private fallback(reply: Reply): AdapterReadingV2 {
    const body = isStatusBody(reply.body) ? reply.body : null;
    if (!body) return this.reading(UNSUPPORTED, EMPTY_RUNTIME(), {});
    const active = count(body.active_requests)!, queued = count(body.waiting_requests)!, loading = count(body.models_loading) ?? 0;
    const loaded = list(body.loaded_models, 12, value => typeof value === 'string' ? modelLabel(value) : null);
    const resident = count(body.models_loaded) ?? loaded.length;
    const phase = this.preloading(resident === 0 ? loading > 0 ? 'loading' : 'not-loaded'
      : active > 0 ? 'processing' : queued > 0 ? 'queued' : loading > 0 ? 'loading' : 'idle');
    const averages = nonEmpty(averagesOf(normalizeSession(body)));
    const memory = this.memory(null, null, count(body.model_memory_used));
    // Which model holds a request is not reported here: one resident model takes the server's phase, several are unknown.
    const residency = list(body.loaded_models, 12, value => {
      const model = typeof value === 'string' ? modelLabel(value) : null;
      return model ? defined({ model, phase: active === 0 && queued === 0 ? 'idle' as const : loaded.length === 1 ? phase : 'unknown' as const,
        source: 'runtime' as const, contextWindowTokens: opt(this.windows.value.get(value as string)) }) : null;
    });
    const runtime: RuntimeV2 = { sampledAt: this.context.now(), phase, request: null,
      server: defined({ active, queued, averages }), memory, residency, residencyCount: resident, slots: [], catalog: [], engines: [] };
    return this.reading(FALLBACK, runtime, capabilities(['server.requests', 'server.residency', averages !== undefined && 'server.averages',
      memory.modelBytes !== undefined && 'server.memory.model', memory.ceilingBytes !== undefined && 'server.memory.ceiling']));
  }
}

const hint = HINTS.find(([id]) => id === 'omlx')![1];
export const omlxDescriptor: DescriptorV2 = {
  id: 'omlx', hints: hint,
  detect: [{ probe: '/health', confidence: 'high', match: reply => isOmlxHealth(reply.body, reply.status) }],
  cadence: () => FLOOR_MS, capabilities: OMLX_CAPABILITIES, identityEveryMs: 300_000,
  create: context => new OmlxAdapter(context),
};

export const __test__ = { extractCookie, contextWindowsOf, hasUsage, isStatusBody };

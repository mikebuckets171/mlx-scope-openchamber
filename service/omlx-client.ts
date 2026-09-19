import { normalizeOmlxTelemetry, unavailableTelemetry, type TelemetrySnapshot, type TelemetryStatsState } from '../src/telemetry.ts';
import { resolveOmlxConfig, type OmlxConfig } from './config.ts';

type JsonObject = { readonly [key: string]: unknown };
type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type JsonResponse = {
  status: number;
  body: JsonObject | null;
  cookie: string | null;
};

type OmlxFailureReason = 'authentication_failed' | 'runtime_unreachable';

class OmlxFailure extends Error {
  readonly reason: OmlxFailureReason;

  constructor(reason: OmlxFailureReason, message: string) {
    super(message);
    this.name = 'OmlxFailure';
    this.reason = reason;
  }
}

const asObject = (value: unknown): JsonObject | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
);

const nonnegative = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
);

const extractCookie = (value: string | null): string | null => {
  if (value === null) return null;
  const match = /(?:^|,\s*)omlx_admin_session=([^;,]+)/i.exec(value);
  return match?.[1] ?? null;
};

const responseIsRedirect = (status: number): boolean => status >= 300 && status < 400;

const requestJSON = async ({
  url,
  init,
  fetchImpl,
  timeoutMs = 3_000,
  allowLoadingHealth = false,
}: {
  url: URL;
  init?: RequestInit;
  fetchImpl: FetchImplementation;
  timeoutMs?: number;
  allowLoadingHealth?: boolean;
}): Promise<JsonResponse> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = async (): Promise<JsonResponse> => {
    const response = await fetchImpl(url.toString(), {
      ...init,
      redirect: 'manual',
      signal: controller.signal,
    });
  if (!response || responseIsRedirect(response.status) || response.url !== '' && response.url !== url.toString()) {
    throw new OmlxFailure('runtime_unreachable', 'The oMLX runtime returned an unsafe response.');
  }
  if (response.status === 401 || response.status === 403) {
    throw new OmlxFailure('authentication_failed', 'oMLX requires a valid API key or rejected the supplied key.');
  }
  if (response.status !== 200 && !(allowLoadingHealth && response.status === 503)) {
    throw new OmlxFailure('runtime_unreachable', `The oMLX runtime returned HTTP ${response.status}.`);
  }
  let body: JsonObject | null = null;
  try {
    const reader = response.body?.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2_000_000) {
          await reader.cancel();
          throw new Error('Response too large');
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    body = asObject(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw new OmlxFailure('runtime_unreachable', 'The oMLX runtime returned invalid JSON.');
  }
  return {
    status: response.status,
    body,
    cookie: extractCookie(response.headers.get('set-cookie')),
  };
    };
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new OmlxFailure('runtime_unreachable', 'The oMLX request timed out.'));
        }, Math.max(1, timeoutMs));
      }),
    ]);
  } catch (error) {
    if (error instanceof OmlxFailure) throw error;
    throw new OmlxFailure('runtime_unreachable', 'The oMLX runtime did not answer.');
  } finally {
    clearTimeout(timer);
    // Rejected headers can arrive before an unbounded body. Release that stream
    // even when the request finishes before its timeout.
    controller.abort();
  }
};

const resettableConfig = (config: OmlxConfig): string => `${config.baseURL?.toString() ?? ''}\u0000${config.apiKey ?? ''}`;

const isStatsPayload = (body: JsonObject | null): body is JsonObject => (
  body !== null && asObject(body.engines) !== null && asObject(body.active_models) !== null
);

const isOmlxHealth = (body: JsonObject | null, status: number): boolean => {
  const pool = asObject(body?.engine_pool);
  const expectedState = status === 200 ? 'healthy' : status === 503 ? 'loading' : null;
  const count = nonnegative(pool?.model_count);
  return expectedState !== null && body?.status === expectedState && count !== null && Number.isSafeInteger(count);
};

const parseContextWindows = (body: JsonObject | null): Map<string, number> => {
  const result = new Map<string, number>();
  const models = Array.isArray(body?.models) ? body.models : [];
  for (const item of models) {
    const model = asObject(item);
    const id = typeof model?.id === 'string' ? model.id : null;
    const limit = nonnegative(model?.max_context_window);
    if (id !== null && limit !== null && Number.isSafeInteger(limit) && limit > 0) result.set(id, Math.trunc(limit));
  }
  return result;
};

export type OmlxClientOptions = {
  fetchImpl?: FetchImplementation;
  readConfig?: () => Promise<OmlxConfig>;
  now?: () => number;
  monotonicNow?: () => number;
  requestTimeoutMs?: number;
  collectionDeadlineMs?: number;
};

/** Read-only oMLX client that keeps credentials and raw payloads in the service. */
export class OmlxClient {
  private readonly fetchImpl: FetchImplementation;
  private readonly readConfig: () => Promise<OmlxConfig>;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly requestTimeoutMs: number;
  private readonly collectionDeadlineMs: number;
  private configKey = '';
  private cookie: string | null = null;
  private stats: JsonObject | null = null;
  private statsState: TelemetryStatsState = 'unavailable';
  private statsAt = Number.NEGATIVE_INFINITY;
  private identityAt = Number.NEGATIVE_INFINITY;
  private modelStatusAt = Number.NEGATIVE_INFINITY;
  private contextWindows = new Map<string, number>();
  private inFlight: Promise<TelemetrySnapshot> | null = null;
  private lastSnapshot: TelemetrySnapshot | null = null;
  private snapshotAt = Number.NEGATIVE_INFINITY;
  private failures = 0;
  private retryAt = Number.NEGATIVE_INFINITY;
  private config: OmlxConfig | null = null;
  private configAt = Number.NEGATIVE_INFINITY;
  private signalIdentity = '';
  private traceEpoch = 0;
  private prefill = new Map<string, { processed: number; changedAt: number }>();

  constructor(options: OmlxClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.readConfig = options.readConfig ?? resolveOmlxConfig;
    this.now = options.now ?? (() => Date.now());
    this.monotonicNow = options.monotonicNow ?? (options.now ? options.now : () => performance.now());
    this.requestTimeoutMs = options.requestTimeoutMs ?? 3_000;
    this.collectionDeadlineMs = options.collectionDeadlineMs ?? 8_000;
  }

  snapshot(): Promise<TelemetrySnapshot> {
    if (this.inFlight) return this.inFlight;
    const age = this.monotonicNow() - this.snapshotAt;
    if (this.lastSnapshot && age >= 0 && (age < 450 || !this.lastSnapshot.available && this.monotonicNow() < this.retryAt)) {
      return Promise.resolve(this.lastSnapshot);
    }
    this.inFlight = this.collect().catch(() => unavailableTelemetry('runtime_unreachable', 'Local telemetry is unavailable.'))
      .then((snapshot) => {
        this.lastSnapshot = snapshot;
        this.snapshotAt = this.monotonicNow();
        this.failures = snapshot.available ? 0 : Math.min(5, this.failures + 1);
        this.retryAt = snapshot.available ? Number.NEGATIVE_INFINITY
          : this.snapshotAt + Math.min(15_000, 1_000 * 2 ** (this.failures - 1));
        return snapshot;
      }).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async configuration(): Promise<OmlxConfig> {
    if (this.config === null || this.monotonicNow() - this.configAt >= 5_000) {
      this.config = await this.readConfig();
      this.configAt = this.monotonicNow();
    }
    return this.config;
  }

  private async collect(): Promise<TelemetrySnapshot> {
    const config = await this.configuration();
    if (config.baseURL === null) {
      return unavailableTelemetry('runtime_unreachable', config.error);
    }
    const key = `${resettableConfig(config)}\u0000${config.preferredModel ?? ''}`;
    if (key !== this.configKey) {
      this.configKey = key;
      this.cookie = null;
      this.stats = null;
      this.statsState = 'unavailable';
      this.statsAt = Number.NEGATIVE_INFINITY;
      this.identityAt = Number.NEGATIVE_INFINITY;
      this.modelStatusAt = Number.NEGATIVE_INFINITY;
      this.contextWindows = new Map();
      this.signalIdentity = '';
      this.prefill.clear();
      this.traceEpoch += 1;
    }

    try {
      const startedAt = this.monotonicNow();
      const deadline = startedAt + this.collectionDeadlineMs;
      const timeoutFor = (limit = this.requestTimeoutMs): number => {
        const remaining = deadline - this.monotonicNow();
        if (remaining <= 0) throw new OmlxFailure('runtime_unreachable', 'The oMLX snapshot deadline expired.');
        return Math.max(1, Math.min(limit, remaining));
      };
      if (startedAt - this.identityAt >= 300_000) {
        await this.verifyIdentity(config.baseURL, timeoutFor());
        this.identityAt = this.monotonicNow();
      }
      // Respect the server’s existing auth policy; never change it or retry a rejected key without auth.
      if (this.cookie === null && config.apiKey !== null) this.cookie = await this.login(config.baseURL, config.apiKey, timeoutFor());

      const readStatus = this.monotonicNow() - this.modelStatusAt >= 60_000;
      if (readStatus) {
        // Limit attempts even when another request in this collection fails.
        this.modelStatusAt = this.monotonicNow();
        this.contextWindows = new Map();
      }
      // Cache summaries may scan DFlash's disk snapshots; live activity stays independent.
      const readSessionStats = this.monotonicNow() - this.statsAt >= 10_000;
      const activityPromise = this.readActivity(config.baseURL, this.cookie, timeoutFor());
      const statusPromise = readStatus
        ? this.readModelStatus(config.baseURL, config.apiKey, timeoutFor(Math.min(this.requestTimeoutMs, 1_000)))
        : Promise.resolve(null);
      const statsPromise = readSessionStats
        ? this.readStats(config.baseURL, this.cookie, timeoutFor()).then(
          (value) => ({ value, error: null as unknown }),
          (error: unknown) => ({ value: null, error }),
        )
        : Promise.resolve(null);
      const [activity, contextWindows, statsResult] = await Promise.all([activityPromise, statusPromise, statsPromise]);
      if (readStatus && contextWindows !== null) {
        this.contextWindows = contextWindows;
        this.modelStatusAt = this.monotonicNow();
      }
      if (readSessionStats && statsResult !== null) {
        if (statsResult.error instanceof OmlxFailure && statsResult.error.reason === 'authentication_failed') {
          throw statsResult.error;
        }
        if (statsResult.value !== null) {
          this.stats = statsResult.value;
          this.statsState = 'fresh';
        } else {
          this.statsState = this.stats === null ? 'unavailable' : 'stale';
        }
        this.statsAt = this.monotonicNow();
      }
      this.observeProgress(activity);
      const normalized = normalizeOmlxTelemetry(
        this.stats,
        activity,
        this.contextWindows,
        config.preferredModel,
        this.now(),
        this.statsState,
      );
      if (normalized === null) {
        throw new OmlxFailure('runtime_unreachable', 'oMLX returned an unexpected telemetry shape.');
      }
      return {
        ...normalized,
        traceEpoch: this.signalIdentity ? this.traceEpoch : null,
        message: normalized.message ?? (this.statsState === 'stale'
          ? 'Live activity connected · session statistics are from the last successful read'
          : this.statsState === 'unavailable'
            ? 'Live activity connected · session statistics unavailable'
            : null),
      };
    } catch (error) {
      this.signalIdentity = '';
      this.traceEpoch += 1;
      this.prefill.clear();
      if (error instanceof OmlxFailure) {
        if (error.reason === 'authentication_failed') {
          this.cookie = null;
          this.stats = null;
          this.statsState = 'unavailable';
          this.statsAt = Number.NEGATIVE_INFINITY;
          this.configAt = Number.NEGATIVE_INFINITY;
          this.identityAt = Number.NEGATIVE_INFINITY;
        } else {
          this.identityAt = Number.NEGATIVE_INFINITY;
        }
        return unavailableTelemetry(error.reason, error.message);
      }
      this.cookie = null;
      this.stats = null;
      this.statsState = 'unavailable';
      this.identityAt = Number.NEGATIVE_INFINITY;
      return unavailableTelemetry('runtime_unreachable', 'The oMLX telemetry request failed.');
    }
  }

  /** Observe only in service memory. No request identifiers cross the SDK. */
  private observeProgress(activity: JsonObject): void {
    const active = asObject(activity.active_models);
    const observedAt = this.monotonicNow();
    const identities: string[] = [];
    const activePrefills = new Set<string>();
    for (const modelValue of Array.isArray(active?.models) ? active.models : []) {
      const model = asObject(modelValue);
      if (!model || asObject(model.cluster) !== null) continue;
      for (const kind of ['prefilling', 'generating', 'activities']) {
        for (const entry of Array.isArray(model[kind]) ? model[kind] : []) {
          const flight = asObject(entry);
          if (!flight || typeof flight.request_id !== 'string' || !flight.request_id.trim()
            || kind === 'activities' && flight.kind !== 'generate') continue;
          const identity = JSON.stringify([model.id, kind, flight.request_id, kind === 'prefilling' ? [flight.phase, flight.total] : null]);
          identities.push(identity);
          if (kind !== 'prefilling') continue;
          activePrefills.add(identity);
          const processed = nonnegative(flight.processed);
          if (processed === null) continue;
          const previous = this.prefill.get(identity);
          if (!previous || previous.processed !== processed) this.prefill.set(identity, { processed, changedAt: observedAt });
          if (previous && previous.processed === processed && observedAt - previous.changedAt >= 15_000) {
            (flight as Record<string, unknown>).progress_stale = true;
          }
        }
      }
    }
    for (const key of this.prefill.keys()) if (!activePrefills.has(key)) this.prefill.delete(key);
    const identity = identities.sort().join('|');
    if (identity !== this.signalIdentity) { this.traceEpoch += 1; this.signalIdentity = identity; }
  }

  private async verifyIdentity(baseURL: URL, timeoutMs: number): Promise<void> {
    const response = await requestJSON({
      url: new URL('/health', baseURL),
      fetchImpl: this.fetchImpl,
      timeoutMs,
      allowLoadingHealth: true,
      init: { method: 'GET', headers: { Accept: 'application/json' } },
    });
    if (!isOmlxHealth(response.body, response.status)) {
      throw new OmlxFailure('runtime_unreachable', 'The service answered, but it did not identify as oMLX.');
    }
  }

  private async login(baseURL: URL, apiKey: string, timeoutMs: number): Promise<string> {
    const response = await requestJSON({
      url: new URL('/admin/api/login', baseURL),
      fetchImpl: this.fetchImpl,
      timeoutMs,
      init: {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey, remember: false }),
      },
    });
    if (response.cookie === null) {
      throw new OmlxFailure('authentication_failed', 'oMLX login did not return a session.');
    }
    return response.cookie;
  }

  private async readModelStatus(baseURL: URL, apiKey: string | null, timeoutMs: number): Promise<Map<string, number>> {
    try {
      const response = await requestJSON({
        url: new URL('/v1/models/status', baseURL),
        fetchImpl: this.fetchImpl,
        timeoutMs,
        init: { method: 'GET', headers: { Accept: 'application/json', ...(apiKey === null ? {} : { Authorization: `Bearer ${apiKey}` }) } },
      });
      return parseContextWindows(response.body);
    } catch {
      // The supplemental endpoint is optional in older oMLX builds. It must
      // not make the main stats/activity poll fail or retry on every tick.
      return new Map();
    }
  }

  private async readStats(baseURL: URL, cookie: string | null, timeoutMs: number): Promise<JsonObject | null> {
    const response = await requestJSON({
      url: new URL('/admin/api/stats?scope=session', baseURL),
      fetchImpl: this.fetchImpl,
      timeoutMs,
      init: { method: 'GET', headers: { Accept: 'application/json', ...(cookie === null ? {} : { Cookie: `omlx_admin_session=${cookie}` }) } },
    });
    return isStatsPayload(response.body) ? response.body : null;
  }

  private async readActivity(baseURL: URL, cookie: string | null, timeoutMs: number): Promise<JsonObject> {
    const response = await requestJSON({
      url: new URL('/admin/api/activity', baseURL),
      fetchImpl: this.fetchImpl,
      timeoutMs,
      init: { method: 'GET', headers: { Accept: 'application/json', ...(cookie === null ? {} : { Cookie: `omlx_admin_session=${cookie}` }) } },
    });
    if (response.body === null) throw new OmlxFailure('runtime_unreachable', 'oMLX activity was empty.');
    return response.body;
  }
}

export const __test__ = {
  asObject,
  extractCookie,
  isOmlxHealth,
  parseContextWindows,
};

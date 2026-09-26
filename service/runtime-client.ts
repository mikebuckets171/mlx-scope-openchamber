import { randomUUID } from 'node:crypto';
import { unavailableTelemetry, type TelemetrySnapshot } from '../src/telemetry.ts';
import { runtimeNames, type Runtime, type RuntimeSelection, type ConnectionInfo } from '../src/runtime.ts';
import { resolveRuntimeConnections, type RuntimeConnections, type RuntimeConnectionConfig } from './config.ts';
import { requestJSON, HttpFailure, type FetchImplementation } from './http.ts';
import { OmlxClient, isOmlxHealth } from './omlx-client.ts';
import { LMStudioClient } from './lmstudio.ts';
import { MlxLmClient } from './mlx-lm.ts';
import { VllmMlxClient } from './vllm-mlx.ts';
import { SplashClient } from './splash.ts';
import type { RuntimeRead } from './adapter.ts';

type Adapter = { snapshot(deadline?: number): Promise<TelemetrySnapshot> };
type Slot = {
  fingerprint: string; generation: string; runtime: Runtime | null; client: Adapter | null;
  snapshot: TelemetrySnapshot | null; inFlight: Promise<TelemetrySnapshot> | null;
  sampledAt: number; retryAt: number; failures: number; deadline: number;
};
type Options = {
  fetchImpl?: FetchImplementation;
  readConfig?: () => Promise<RuntimeConnections>;
  now?: () => number;
  monotonicNow?: () => number;
  requestTimeoutMs?: number;
  collectionDeadlineMs?: number;
};

/** One demand-driven pipeline per selected connection; credentials never enter a snapshot. */
export class RuntimeClient {
  private readonly fetchImpl: FetchImplementation;
  private readonly readConfig: () => Promise<RuntimeConnections>;
  private readonly now: () => number;
  private readonly monotonic: () => number;
  private readonly timeout: number;
  private readonly budget: number;
  private configuration: RuntimeConnections | null = null;
  private configAt = -Infinity;
  private configFlight: Promise<RuntimeConnections> | null = null;
  private readonly slots = new Map<string, Slot>();

  constructor(options: Options = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.readConfig = options.readConfig ?? resolveRuntimeConnections;
    this.now = options.now ?? Date.now;
    this.monotonic = options.monotonicNow ?? (options.now ? options.now : () => performance.now());
    this.timeout = options.requestTimeoutMs ?? 3000;
    this.budget = options.collectionDeadlineMs ?? 8000;
  }
  private async config(): Promise<RuntimeConnections> {
    if (this.configuration && this.monotonic() - this.configAt < 5000) return this.configuration;
    if (!this.configFlight) this.configFlight = this.readConfig().then(value => {
      this.configuration = value; this.configAt = this.monotonic(); return value;
    }).finally(() => { this.configFlight = null; });
    return this.configFlight;
  }

  async snapshot(selection?: RuntimeSelection): Promise<TelemetrySnapshot> {
    let configuration: RuntimeConnections;
    try { configuration = await this.config(); }
    catch { configuration = { connections: [], issue: 'unreadable_config', error: 'Saved runtime connections could not be read. Reopen MLX Scope after checking the provider in OpenChamber.' }; }
    const choice = selection?.provider ? configuration.connections.find(item => item.id === selection.provider) : configuration.connections[0];
    const info: ConnectionInfo = { selected: choice?.id ?? null, label: choice?.label ?? null, runtime: selection?.runtime ?? choice?.runtime ?? null,
      choices: configuration.connections.slice(0, 8).map(item => ({ id: item.id, label: item.label, runtime: item.runtime })),
      diagnostic: 'missing', coverage: null, generation: null };
    if (!choice) return { ...unavailableTelemetry('runtime_unreachable', selection?.provider
      ? 'This saved connection is no longer configured. Choose another connection or Automatic.' : configuration.error, this.now()),
      connection: { ...info, diagnostic: configuration.issue === 'malformed_config' || configuration.issue === 'unreadable_config' ? 'unreadable' : 'missing' } };
    if (!choice.config.baseURL || !['none', 'missing_credential'].includes(choice.config.issue)) {
      return { ...unavailableTelemetry('runtime_unreachable', choice.config.error, this.now()),
        connection: { ...info, diagnostic: ['malformed_config', 'unreadable_config'].includes(choice.config.issue) ? 'unreadable' : 'invalid' } };
    }
    const key = `${choice.id}\0${selection?.runtime ?? 'auto'}`;
    const fingerprint = JSON.stringify([choice.config.baseURL.href, choice.config.apiKey, choice.config.preferredModel, info.runtime]);
    let slot = this.slots.get(key);
    if (!slot || slot.fingerprint !== fingerprint) {
      const idleKey = [...this.slots].find(([, value]) => !value.inFlight)?.[0];
      if (slot?.inFlight || !slot && this.slots.size >= 8 && idleKey === undefined) {
        return { ...unavailableTelemetry('runtime_unreachable', 'Earlier connection reads are finishing. Monitoring retries automatically.', this.now()),
          connection: { ...info, diagnostic: 'offline' } };
      }
      slot = { fingerprint, generation: randomUUID(), runtime: info.runtime, client: null, snapshot: null, inFlight: null, sampledAt: -Infinity, retryAt: -Infinity, failures: 0, deadline: 0 };
      this.slots.delete(key);
      if (this.slots.size >= 8 && idleKey !== undefined) this.slots.delete(idleKey);
      this.slots.set(key, slot);
    }
    const current = slot;
    const cadence = current.runtime === 'lmstudio' ? 5000 : current.runtime === 'mlx-lm' || current.runtime === 'splash' ? 2000 : 450;
    if (!current.inFlight && !(current.snapshot && (this.monotonic() - current.sampledAt < cadence || this.monotonic() < current.retryAt))) {
      current.deadline = this.monotonic() + this.budget;
      current.inFlight = this.collect(current, choice).catch(error => {
        const auth = error instanceof HttpFailure && error.reason === 'authentication_failed';
        return unavailableTelemetry(auth ? 'authentication_failed' : error instanceof UnsupportedRuntime ? 'unsupported_contract' : 'runtime_unreachable', auth
          ? `The saved key was rejected by ${current.runtime ? runtimeNames[current.runtime] : 'this runtime'}. Reconnect that provider in OpenChamber using its API key.`
          : error instanceof UnsupportedRuntime ? error.message
          : `${current.runtime ? runtimeNames[current.runtime] : 'The configured runtime'} is not responding with supported readings. Start it on the OpenChamber host; monitoring retries automatically.`, this.now());
      }).then(snapshot => {
        current.snapshot = snapshot; current.sampledAt = this.monotonic();
        current.failures = snapshot.available ? 0 : Math.min(5, current.failures + 1);
        current.retryAt = snapshot.available ? -Infinity : current.sampledAt + Math.min(15000, 1000 * 2 ** (current.failures - 1));
        return snapshot;
      }).finally(() => { current.inFlight = null; });
    }
    const snapshot = current.inFlight ? await current.inFlight : current.snapshot!;
    const runtime = snapshot.runtime ?? current.runtime;
    const authMessage = snapshot.reason === 'authentication_failed'
      ? choice.config.apiKey === null ? `${runtime ? runtimeNames[runtime] : 'This runtime'} needs an API key. Connect this provider in OpenChamber, then return here.`
        : `${runtime ? runtimeNames[runtime] : 'This runtime'} rejected the saved API key. Reconnect this provider in OpenChamber${runtime === 'omlx' ? ' using the main oMLX key; inference subkeys cannot read monitoring' : ''}.`
      : snapshot.message;
    return { ...snapshot, message: authMessage, connection: { ...info, runtime, generation: current.generation,
      diagnostic: snapshot.available ? runtime === 'splash' && snapshot.serverStats?.ready === false ? 'offline' : 'ready'
        : snapshot.reason === 'authentication_failed' ? 'authentication' : snapshot.reason === 'unsupported_contract' ? 'unsupported' : 'offline',
      coverage: runtime === 'splash' || runtime === 'vllm-mlx' && snapshot.available && snapshot.phase === 'unknown' && snapshot.activeRequests === null ? 'server'
        : runtime === 'omlx' || runtime === 'vllm-mlx' ? 'requests' : runtime ? 'inventory' : null } };
  }

  private async collect(slot: Slot, choice: RuntimeConnectionConfig): Promise<TelemetrySnapshot> {
    const base = choice.config.baseURL!;
    const read = async (path: string, authenticated = true) => {
      const remaining = slot.deadline - this.monotonic();
      if (remaining <= 0) throw new HttpFailure('runtime_unreachable', 'The snapshot deadline expired.');
      return requestJSON({ url: new URL(path, base), fetchImpl: this.fetchImpl, timeoutMs: Math.min(this.timeout, remaining), allowLoadingHealth: path === '/health',
        init: { method: 'GET', headers: { Accept: 'application/json', ...(authenticated && choice.config.apiKey ? { Authorization: `Bearer ${choice.config.apiKey}` } : {}) } } });
    };
    if (!slot.runtime) {
      try {
        const health = await read('/health', false);
        if (isOmlxHealth(health.body, health.status)) slot.runtime = 'omlx';
        else if (health.body && typeof health.body.model_loaded === 'boolean' && ['simple', 'batched', 'unknown'].includes(String(health.body.engine_type)) && Array.isArray(health.body.available_models)) slot.runtime = 'vllm-mlx';
      } catch (error) {
        if (!(error instanceof HttpFailure) || ![401, 403, 404].includes(error.status ?? 0)) throw error;
      }
      if (!slot.runtime) {
        try {
          const models = await read('/api/v1/models');
          if (Array.isArray(models.body?.models)) slot.runtime = 'lmstudio';
        } catch (error) { if (!(error instanceof HttpFailure) || error.status !== 404) throw error; }
      }
      if (!slot.runtime) {
        const response = await read('/v1/models');
        const models = Array.isArray(response.body?.data) ? response.body.data : [];
        const owners = models.map(model => model && typeof model === 'object' ? (model as Record<string, unknown>).owned_by : null);
        if (owners.includes('vllm-mlx') && owners.every(owner => ['vllm-mlx', 'vllm-mlx-embedding', 'vllm-mlx-reranker'].includes(String(owner)))) slot.runtime = 'vllm-mlx';
      }
      if (!slot.runtime) throw new UnsupportedRuntime('This connection does not identify a supported runtime. Choose its runtime in Change connection. OpenAI-compatible chat endpoints alone do not provide live telemetry.');
    }
    if (!slot.client) {
      const reader: RuntimeRead = async path => (await read(path, path !== '/health')).body;
      slot.client = slot.runtime === 'omlx' ? new OmlxClient({ fetchImpl: this.fetchImpl, readConfig: async () => choice.config, now: this.now, monotonicNow: this.monotonic, requestTimeoutMs: this.timeout, collectionDeadlineMs: this.budget })
        : slot.runtime === 'lmstudio' ? new LMStudioClient(reader, this.now)
        : slot.runtime === 'mlx-lm' ? new MlxLmClient(reader, this.now)
        : slot.runtime === 'splash' ? new SplashClient(reader, this.now)
        : new VllmMlxClient(reader, this.now);
    }
    return slot.client.snapshot(slot.deadline);
  }
}
class UnsupportedRuntime extends Error {}

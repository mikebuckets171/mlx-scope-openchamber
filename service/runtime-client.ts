import { unavailableTelemetry, type TelemetrySnapshot } from '../src/telemetry.ts';
import { runtimeNames, type Runtime, type RuntimeSelection, type ConnectionInfo } from '../src/runtime.ts';
import { oneOf } from '../src/contract/guards.ts';
import { PROBES, type ConnectionV2 } from '../src/contract/snapshot.ts';
import { resolveRuntimeConnections, type RuntimeConnections, type RuntimeConnectionConfig } from './config.ts';
import { requestJSON, HttpFailure, type FetchImplementation } from './http.ts';
import type { LMStudioActivityStream } from './lmstudio-activity.ts';
import type { RuntimeRead } from './adapter.ts';
import { cadenceOf, descriptor, detectRuntime, type Adapter, type Detection } from './core/registry.ts';
import { Scheduler, type Outcome, type Slot } from './core/scheduler.ts';
import { failuresOf } from './core/slot.ts';

const urlPort = (url: URL): number | null => {
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : Number.NaN;
  return Number.isInteger(port) ? port : null;
};

type SlotContext = {
  runtime: Runtime | null; client: Adapter | null; detection: Detection | null;
  completion: { key: string; seq: number } | null;
};
type Options = {
  fetchImpl?: FetchImplementation;
  readConfig?: () => Promise<RuntimeConnections>;
  now?: () => number;
  monotonicNow?: () => number;
  requestTimeoutMs?: number;
  collectionDeadlineMs?: number;
  /** Local LM Studio log-stream source; omitted or `null` keeps LM Studio inventory-only. */
  lmstudioActivity?: LMStudioActivityStream | null;
};
/** What a v2 body needs beyond the 1.x reading. */
export interface ReadingMeta {
  generation: number;                        // 0 when no slot serves the selection
  detection: ConnectionV2['detection'];
  failures: number;
  idleMs: number;
  completionSeq: number | null;              // seq of the reading's last finished request
}
export interface RuntimeReading { snapshot: TelemetrySnapshot; meta: ReadingMeta }

const ACTIVE = new Set(['decode', 'prefill', 'processing', 'queued']);
/** Work in progress: the phases 1.6 polls at its active cadence. */
export const busy = (snapshot: TelemetrySnapshot): boolean => snapshot.available && ACTIVE.has(snapshot.phase);
/** The detection probes the contract names; LM Studio's `/api/v1/models` is not one of them and stays off the wire. */
const wireProbe = oneOf(PROBES);
const probed = ({ confidence, probe }: Detection): ConnectionV2['detection'] => {
  const path = wireProbe(probe);
  return path ? { basis: 'probe', confidence, probe: path } : { basis: 'probe', confidence };
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
  private readonly scheduler: Scheduler<SlotContext, TelemetrySnapshot>;
  private readonly lmstudioActivity: LMStudioActivityStream | null;
  private completions = 0;

  constructor(options: Options = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.readConfig = options.readConfig ?? resolveRuntimeConnections;
    this.now = options.now ?? Date.now;
    this.monotonic = options.monotonicNow ?? (options.now ? options.now : () => performance.now());
    this.timeout = options.requestTimeoutMs ?? 3000;
    this.budget = options.collectionDeadlineMs ?? 8000;
    this.lmstudioActivity = options.lmstudioActivity?.available ? options.lmstudioActivity : null;
    this.scheduler = new Scheduler(this.monotonic);
  }

  /** The newest completion seq this instance has assigned; attribution verdicts may only name one at or below it. */
  get completionHead(): number { return this.completions; }
  dispose(): void { this.lmstudioActivity?.stop(); }
  private async config(): Promise<RuntimeConnections> {
    if (this.configuration && this.monotonic() - this.configAt < 5000) return this.configuration;
    if (!this.configFlight) this.configFlight = this.readConfig().then(value => {
      this.configuration = value; this.configAt = this.monotonic(); return value;
    }).finally(() => { this.configFlight = null; });
    return this.configFlight;
  }

  async snapshot(selection?: RuntimeSelection): Promise<TelemetrySnapshot> { return (await this.read(selection)).snapshot; }

  async read(selection?: RuntimeSelection): Promise<RuntimeReading> {
    let configuration: RuntimeConnections;
    try { configuration = await this.config(); }
    catch { configuration = { connections: [], issue: 'unreadable_config', error: 'Saved runtime connections could not be read. Reopen MLX Scope after checking the provider in OpenChamber.' }; }
    const choice = selection?.provider ? configuration.connections.find(item => item.id === selection.provider) : configuration.connections[0];
    const info: ConnectionInfo = { selected: choice?.id ?? null, label: choice?.label ?? null, runtime: selection?.runtime ?? choice?.runtime ?? null,
      choices: configuration.connections.slice(0, 8).map(item => ({ id: item.id, label: item.label, runtime: item.runtime })),
      diagnostic: 'missing', coverage: null, generation: null };
    const detection: ConnectionV2['detection'] = selection?.runtime ? { basis: 'explicit', confidence: 'high' }
      : choice?.runtime ? { basis: 'hint', confidence: 'medium' } : { basis: 'probe', confidence: 'low' };
    const unslotted = (snapshot: TelemetrySnapshot): RuntimeReading => ({ snapshot, meta: { generation: 0, detection, failures: 0, idleMs: 0, completionSeq: null } });
    if (!choice) return unslotted({ ...unavailableTelemetry('runtime_unreachable', selection?.provider
      ? 'This saved connection is no longer configured. Choose another connection or Automatic.' : configuration.error, this.now()),
      connection: { ...info, diagnostic: configuration.issue === 'malformed_config' || configuration.issue === 'unreadable_config' ? 'unreadable' : 'missing' } });
    if (!choice.config.baseURL || !['none', 'missing_credential'].includes(choice.config.issue)) {
      return unslotted({ ...unavailableTelemetry('runtime_unreachable', choice.config.error, this.now()),
        connection: { ...info, diagnostic: ['malformed_config', 'unreadable_config'].includes(choice.config.issue) ? 'unreadable' : 'invalid' } });
    }
    const key = `${choice.id}\0${selection?.runtime ?? 'auto'}`;
    const fingerprint = JSON.stringify([choice.config.baseURL.href, choice.config.apiKey, choice.config.preferredModel, info.runtime]);
    const slot = this.scheduler.claim(key, fingerprint, () => ({ runtime: info.runtime, client: null, detection: null, completion: null }));
    if (!slot) {
      return unslotted({ ...unavailableTelemetry('runtime_unreachable', 'Earlier connection reads are finishing. Monitoring retries automatically.', this.now()),
        connection: { ...info, diagnostic: 'offline' } });
    }
    const current = slot.context;
    const snapshot = await this.scheduler.read(slot, cadenceOf(current.runtime, { activity: this.lmstudioActivity !== null }),
      () => this.collect(current, choice).catch(error => {
        const auth = error instanceof HttpFailure && error.reason === 'authentication_failed';
        return unavailableTelemetry(auth ? 'authentication_failed' : error instanceof UnsupportedRuntime ? 'unsupported_contract' : 'runtime_unreachable', auth
          ? `The saved key was rejected by ${current.runtime ? runtimeNames[current.runtime] : 'this runtime'}. Reconnect that provider in OpenChamber using its API key.`
          : error instanceof UnsupportedRuntime ? error.message
          : `${current.runtime ? runtimeNames[current.runtime] : 'The configured runtime'} is not responding with supported readings. Start it on the OpenChamber host; monitoring retries automatically.`, this.now());
      }), outcome);
    const runtime = snapshot.runtime ?? current.runtime;
    const authMessage = snapshot.reason === 'authentication_failed'
      ? choice.config.apiKey === null ? `${runtime ? runtimeNames[runtime] : 'This runtime'} needs an API key. Connect this provider in OpenChamber, then return here.`
        : `${runtime ? runtimeNames[runtime] : 'This runtime'} rejected the saved API key. Reconnect this provider in OpenChamber${runtime === 'omlx' ? ' using the main oMLX key; inference subkeys cannot read monitoring' : ''}.`
      : snapshot.message;
    const splashModels = runtime === 'lmstudio' && (snapshot.catalog ?? []).some(model => model.format === 'splash');
    const engine = runtime === 'splash' || splashModels ? 'splash' as const : null;
    const host = runtime === 'lmstudio' && (splashModels || /bionic/i.test(`${choice.id} ${choice.label}`)) ? 'bionic' as const : null;
    return {
      snapshot: { ...snapshot, message: authMessage, connection: { ...info, runtime, generation: slot.marker, engine, host,
        diagnostic: snapshot.available ? 'ready'
          : snapshot.reason === 'authentication_failed' ? 'authentication' : snapshot.reason === 'unsupported_contract' ? 'unsupported' : 'offline',
        coverage: runtime ? descriptor(runtime).capabilities(snapshot) : null } },
      meta: { generation: slot.generation, failures: failuresOf(slot.state), idleMs: Math.max(0, this.monotonic() - slot.activeAt),
        detection: current.detection ? probed(current.detection) : detection,
        completionSeq: this.completionSeq(slot, snapshot) },
    };
  }

  /** A new seq for each distinct finished request a slot reports; the same request keeps its seq across polls. */
  private completionSeq(slot: Slot<SlotContext, TelemetrySnapshot>, snapshot: TelemetrySnapshot): number | null {
    const last = snapshot.available ? snapshot.lastRequest : null;
    if (!last) return null;
    const key = JSON.stringify([last.finishedAt, last.model, last.outputTokens, last.promptTokens]);
    if (slot.context.completion?.key !== key) slot.context.completion = { key, seq: ++this.completions };
    return slot.context.completion.seq;
  }

  private async collect(slot: SlotContext, choice: RuntimeConnectionConfig): Promise<TelemetrySnapshot> {
    const base = choice.config.baseURL!, deadline = this.monotonic() + this.budget;
    const read = async (path: string, authenticated = true) => {
      const remaining = deadline - this.monotonic();
      if (remaining <= 0) throw new HttpFailure('runtime_unreachable', 'The snapshot deadline expired.');
      return requestJSON({ url: new URL(path, base), fetchImpl: this.fetchImpl, timeoutMs: Math.min(this.timeout, remaining), allowLoadingHealth: path === '/health',
        init: { method: 'GET', headers: { Accept: 'application/json', ...(authenticated && choice.config.apiKey ? { Authorization: `Bearer ${choice.config.apiKey}` } : {}) } } });
    };
    if (!slot.runtime) {
      slot.detection = await detectRuntime(read);
      if (!slot.detection) throw new UnsupportedRuntime('This connection does not identify a supported runtime. Choose its runtime in Change connection. OpenAI-compatible chat endpoints alone do not provide live telemetry.');
      slot.runtime = slot.detection.runtime;
    }
    if (!slot.client) {
      const reader: RuntimeRead = async path => (await read(path, path !== '/health')).body;
      slot.client = descriptor(slot.runtime).create({ read: reader, config: choice.config, fetchImpl: this.fetchImpl, now: this.now,
        monotonic: this.monotonic, timeoutMs: this.timeout, budgetMs: this.budget,
        activity: () => this.lmstudioActivity?.forPort(urlPort(base)) ?? null });
    }
    return slot.client.snapshot(deadline);
  }
}
class UnsupportedRuntime extends Error {}

/** 1.6 semantics: any available reading is healthy; Splash still loading its model is degraded. */
const outcome = (snapshot: TelemetrySnapshot): Outcome => ({
  event: !snapshot.available ? { kind: 'failed', reason: snapshot.reason === 'authentication_failed' || snapshot.reason === 'unsupported_contract' ? snapshot.reason : 'runtime_unreachable' }
    : snapshot.runtime === 'splash' && snapshot.serverStats?.ready === false ? { kind: 'degraded' } : { kind: 'ready' },
  active: busy(snapshot),
});

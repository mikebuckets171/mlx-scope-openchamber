import type { AlertId, FrameReason, ReasonParams, StatusReason, WithholdReason } from '../../src/contract/reasons.ts';
import { runtimeKind, runtimeNames, type RuntimeKind } from '../../src/contract/runtime.ts';
import { gibText } from './format.ts';

// Owner: svc-2b. The English for every contract reason code; the service sends codes and params only (contract §5).
// `statusCopy` is the 2.0 callout from the approved mock's copy table; `statusMessage` is one line, and keeps the 1.6
// sentence wherever 1.6 said the same thing, so the 1.6 panel reads the same while it still renders `compat`.

export type Severity = 'info' | 'warning' | 'critical';
export interface StatusCopy { severity: Severity; title: string; detail: string; action?: string }
/** Optional context a presenter has and the params do not: the headline model (class B, in-view only). */
export interface StatusContext { model?: string | null }

const RUNTIME: Record<RuntimeKind, string> = { ...runtimeNames, splash: 'Splash' };
const nameOf = (runtime: RuntimeKind | null | undefined, fallback: string): string => runtime ? RUNTIME[runtime] : fallback;
const port = (params: ReasonParams): string => typeof params.port === 'number' ? `:${params.port}` : 'its port';
const detected = (params: ReasonParams): string => nameOf(runtimeKind(params.detected), 'another runtime');
const shortModel = (model: string | null | undefined): string | null => model?.split('/').at(-1) || null;

// 1.6 service and config wording (service/runtime-client.ts, service/config.ts, the adapters at v1.6.1), kept verbatim.
const CONFIG: Record<string, string> = {
  missing_endpoint: 'No local runtime connection found. Add your runtime as a provider in OpenChamber; saved connections are discovered automatically.',
  malformed_config: 'An existing provider configuration is malformed. Correct it in OpenChamber, then return here.',
  unreadable_config: 'An existing provider configuration or credential file could not be read.',
  read_failed: 'Saved runtime connections could not be read. Reopen MLX Scope after checking the provider in OpenChamber.',
  invalid_endpoint: 'The selected connection needs an HTTP loopback URL with an explicit port, such as http://localhost:8000/v1.',
  unsupported_config: 'A configured credential or endpoint reference could not be resolved. Reconnect this provider in OpenChamber.',
  removed: 'This saved connection is no longer configured. Choose another connection or Automatic.',
};
const UNSUPPORTED_16: Partial<Record<RuntimeKind, string>> = {
  'vllm-mlx': 'vllm-mlx returned an unsupported status response.', splash: 'Splash returned an unsupported status response.',
  lmstudio: 'LM Studio returned an unsupported model inventory.',
};
const legacy16 = (reason: StatusReason, params: ReasonParams, runtime: RuntimeKind | null, context: StatusContext): string | null => {
  const name = runtime ? runtimeNames[runtime] : null;
  switch (reason) {
    case 'runtime_unreachable': return params.deferred === true ? 'Earlier connection reads are finishing. Monitoring retries automatically.'
      : `${name ?? 'The configured runtime'} is not responding with supported readings. Start it on the OpenChamber host; monitoring retries automatically.`;
    case 'authentication_failed': return params.keySaved === false ? `${name ?? 'This runtime'} needs an API key. Connect this provider in OpenChamber, then return here.`
      : `${name ?? 'This runtime'} rejected the saved API key. Reconnect this provider in OpenChamber.`;
    case 'configuration_missing': return CONFIG[String(params.issue)] ?? CONFIG.missing_endpoint!;
    case 'unsupported_runtime': return 'This connection does not identify a supported runtime. Choose its runtime in Change connection. OpenAI-compatible chat endpoints alone do not provide live telemetry.';
    case 'unsupported_contract': return runtime ? UNSUPPORTED_16[runtime] ?? null : null;
    case 'loading': return runtime === 'splash' ? `Loading ${shortModel(context.model) ?? 'the model'}…` : null;
    default: return null;
  }
};

/** The status callout (2.0 mock copy table): severity, a title, one detail sentence and at most one action. */
export const statusCopy = (reason: StatusReason, params: ReasonParams, runtime: RuntimeKind | null, context: StatusContext = {}): StatusCopy => {
  const rt = nameOf(runtime, 'The runtime');
  switch (reason) {
    case 'runtime_unreachable': return params.deferred === true
      ? { severity: 'info', title: 'Waiting for a free connection slot', detail: 'Earlier connection reads are finishing. Monitoring retries automatically.' }
      : { severity: 'critical', title: `${rt} stopped responding`, detail: `Nothing answers on ${port(params)}. Scope checks again automatically, so start ${rt} and it picks up again.`, action: 'Connection…' };
    case 'authentication_failed': return { severity: 'critical', title: `${rt} refused Scope’s key`,
      detail: params.keySaved === false ? `${rt} needs an API key. Connect this provider in OpenChamber, then return here.`
        : 'Check the key under Connection. Scope reads it from the runtime’s own config and never stores it.', action: 'Connection…' };
    case 'configuration_missing': return params.issue === 'missing_endpoint' || params.issue === undefined
      ? { severity: 'warning', title: 'No runtime found', detail: 'Nothing answered on the usual local ports. Start a runtime, or choose one.', action: 'Choose connection' }
      : { severity: 'warning', title: 'This connection can’t be read', detail: CONFIG[String(params.issue)] ?? CONFIG.missing_endpoint!, action: 'Choose connection' };
    case 'unsupported_runtime': return { severity: 'warning', title: 'Scope doesn’t recognise this runtime',
      detail: `Something answers on ${port(params)}, but not like any runtime Scope supports.`, action: 'Choose connection' };
    case 'unsupported_contract': return { severity: 'warning', title: `${rt} answered in a shape Scope doesn’t know`,
      detail: 'Scope shows what it can still read, and checks which runtime this is after 3 tries.' };
    case 'detecting': return { severity: 'info', title: 'Looking for a runtime', detail: `Checking ${port(params)} for oMLX, llama-server, Ollama, LM Studio, Splash and vllm-mlx.` };
    case 'redetecting': return { severity: 'info', title: 'Checking which runtime this is', detail: `${rt} stopped answering like itself on ${port(params)}.` };
    case 'runtime_changed': return { severity: 'warning', title: `Looks like ${detected(params)} now`,
      detail: `${rt} is chosen, but ${detected(params)} answers on ${port(params)}. Scope never switches on its own.`, action: `Switch to ${detected(params)}` };
    case 'loading': return runtime === 'splash'
      ? { severity: 'info', title: `Loading ${shortModel(context.model) ?? 'the model'}`, detail: 'Splash answers, but its model is not ready yet.' }
      : { severity: 'info', title: `${rt} is loading a model`, detail: 'Its health check answers 503 until the model is ready.' };
    case 'recovering': return { severity: 'warning', title: 'Splash is recovering',
      detail: `It’s restarting its engine after a fault. Scope reads its status every 30 s, so it doesn’t add to the restart.${params.crashTrace === true ? ' Splash recorded a crash trace; Scope doesn’t show or send it.' : ''}` };
    case 'status_stale': return { severity: 'warning', title: 'Splash’s status is stale',
      detail: 'Splash says its status hasn’t refreshed, so Scope marks its readings last observed until it does.' };
    case 'not_admitting': return { severity: 'warning', title: 'Splash isn’t accepting new requests', detail: params.cause === 'metal'
      ? 'Splash reports its Metal device as unhealthy. New requests wait in its queue.' : 'Splash reports memory pressure as critical. New requests wait in its queue.' };
    case 'admin_unauthorized': return { severity: 'info', title: 'oMLX admin login refused',
      detail: 'Scope reads oMLX’s public status instead: server-wide totals only, with no per-request speed, reply history or usage records.', action: 'Connection…' };
    case 'lms_unavailable': return { severity: 'info', title: 'Bionic isn’t answering Scope’s check',
      detail: 'Scope runs lms only after Bionic answers, so lms can never start it. Loaded instances and engines come back when it answers.' };
    case 'metrics_required': return { severity: 'info', title: 'Live slots need --metrics',
      detail: 'This llama-server build can sleep, and reading its slots without /metrics would wake it. Start llama-server with --metrics to see slots and throughput.' };
    case 'sleeping': return { severity: 'info', title: 'llama-server is asleep',
      detail: 'It unloads the model while idle and wakes on the next request. Scope doesn’t read slots or metrics while it sleeps, so it stays asleep.' };
  }
};

/** One line for the status: the 1.6 sentence where 1.6 had one, else the callout's title and detail. */
export const statusMessage = (reason: StatusReason, params: ReasonParams, runtime: RuntimeKind | null, context: StatusContext = {}): string => {
  const copy = statusCopy(reason, params, runtime, context);
  return legacy16(reason, params, runtime, context) ?? `${copy.title}. ${copy.detail}`;
};

// Frame-side reasons: 1.6 panel/host-errors.ts wording for host failures; the mock and plan §6 for the 2.0 states.
const FRAME: Record<FrameReason, string> = {
  contract_mismatch: 'MLX Scope needs a restart. The panel was updated, but its local service is still the old version. Open Settings → Extensions → MLX Scope, then pause it and resume it.',
  needs_approval: 'MLX Scope 2.0 needs one approval: GPU, thermal and process readings; reply history stored locally. Allow its local service in Settings → Extensions.',
  service_failed: 'The MLX Scope service is stopped or failed. Reopen the extension or check its approval.',
  host_unavailable: 'OpenChamber could not reach the MLX Scope service. Reopen the panel and try again.',
  host_timeout: 'OpenChamber service access timed out before returning a reading. Try refresh again.',
  host_disconnected: 'OpenChamber disconnected this extension. Reopen the panel to reconnect.',
  host_rejected: 'OpenChamber rejected this service request.',
};
export const frameMessage = (reason: FrameReason): string => FRAME[reason];

/** The short reason inside a "Server-wide" chip (mock WITHHOLD); 'all-requests' marks readings that are server-wide by nature. */
export const WITHHOLD_PHRASES: Record<WithholdReason | 'all-requests', string> = {
  'other-provider': 'this chat uses another provider', 'model-differs': 'chat model differs', 'model-unknown': 'chat model unknown',
  'cannot-count': 'runtime can’t count requests', overlap: 'overlapping requests', 'outside-turn': 'outside this chat’s turn',
  'joined-mid-turn': 'joined mid-turn', 'not-observed': 'not observed', 'auto-off': 'auto-labelling off', 'all-requests': 'all requests',
};
/** "Server-wide · <reason>"; `other-provider` becomes "This chat uses <runtime> · Watch <runtime>" (plan §5.5). */
export const withholdMessage = (reason: WithholdReason | 'all-requests', chatRuntime: RuntimeKind | null): string =>
  reason === 'other-provider' && chatRuntime ? `This chat uses ${RUNTIME[chatRuntime]} · Watch ${RUNTIME[chatRuntime]}` : `Server-wide · ${WITHHOLD_PHRASES[reason]}`;

const THERMAL = ['normal', 'moderate', 'heavy', 'severe', 'critical'];
const minutes = (ms: unknown): number => typeof ms === 'number' ? Math.max(1, Math.round(ms / 60_000)) : 5;
const duration = (ms: unknown): string => typeof ms === 'number' ? ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min` : '30 s';
/**
 * An alert's title and detail (mock ALERT). `model-unloaded` names the model: in-view only. A toast or any share path must
 * go through panel/share/report.ts, which removes model names (P6).
 */
export const alertCopy = (id: AlertId, params: ReasonParams): { title: string; detail: string } => {
  switch (id) {
    case 'runtime-lost': return { title: `${nameOf(runtimeKind(params.runtime), 'The runtime')} stopped responding`, detail: 'Scope checks again automatically' };
    case 'model-unloaded': return { title: `${typeof params.model === 'string' ? params.model : 'A model'} was unloaded`, detail: 'Reported by the runtime · Scope never loads models' };
    case 'pressure-warning': return { title: 'macOS memory pressure: warning', detail: 'Reported by the macOS kernel · apps may be compressed or swapped' };
    case 'pressure-critical': return { title: 'macOS memory pressure: critical', detail: 'Reported by the macOS kernel · replies may slow sharply until memory frees up' };
    case 'swap-growth': return { title: `Swap grew ${gibText(typeof params.deltaBytes === 'number' ? params.deltaBytes : null)} in ${minutes(params.windowMs)} min`,
      detail: 'Within one continuous stretch of readings' };
    case 'thermal': return { title: `Thermal pressure: ${THERMAL[typeof params.level === 'number' ? params.level : 2] ?? 'heavy'}`, detail: 'Reported by macOS · the chip may run slower' };
    case 'splash-recovering': return { title: 'Splash was recovering', detail: 'Reported by Splash' };
    case 'omlx-prefill-stall': return { title: 'Prefill progress stopped moving', detail: `No change for ${duration(params.stalledMs)} · reported by oMLX` };
    case 'omlx-memory-guard': return { title: 'oMLX memory guard is active', detail: 'Reported by oMLX · new requests wait until memory frees up · not macOS memory pressure' };
  }
};
export const alertMessage = (id: AlertId, params: ReasonParams): string => alertCopy(id, params).title;

import { at, bool, count, obj, modelLabel, nonneg, oneOf, signedInt } from './guards.ts';
import { runtimeKind } from './runtime.ts';

// Codes and params only (contract §5). The English lives in panel/present/messages.ts.
export const STATUS_STATES = ['ready', 'degraded', 'detecting', 'failing', 'unconfigured', 'recovering'] as const;
export type StatusState = typeof STATUS_STATES[number];

export const STATUS_REASONS = [
  'runtime_unreachable', 'authentication_failed', 'configuration_missing', 'unsupported_runtime', 'unsupported_contract',
  'detecting', 'redetecting', 'runtime_changed', 'loading', 'recovering', 'status_stale', 'not_admitting',
  'admin_unauthorized', 'lms_unavailable', 'metrics_required', 'sleeping',
] as const;
export type StatusReason = typeof STATUS_REASONS[number];

/** Panel-side only; never sent by the service. */
export const FRAME_REASONS = [
  'contract_mismatch', 'needs_approval', 'service_failed', 'host_unavailable', 'host_timeout', 'host_disconnected', 'host_rejected',
] as const;
export type FrameReason = typeof FRAME_REASONS[number];

/** Why an item stays "Server-wide" (plan §5.5). One reason per item. */
export const WITHHOLD_REASONS = [
  'projects-loading', 'projects-error', 'too-many-projects', 'several-chats', 'subagent-running', 'other-provider',
  'model-differs', 'model-unknown', 'cannot-count', 'overlap', 'outside-turn', 'joined-mid-turn', 'not-observed', 'auto-off',
] as const;
export type WithholdReason = typeof WITHHOLD_REASONS[number];

export const ALERT_IDS = [
  'runtime-lost', 'model-unloaded', 'pressure-warning', 'pressure-critical', 'swap-growth', 'thermal',
  'splash-recovering', 'omlx-prefill-stall', 'omlx-memory-guard',
] as const;
/** No GPU-limit alert (G1), and never an alert on GPU utilisation. */
export type AlertId = typeof ALERT_IDS[number];

export type ReasonParams = Record<string, string | number | boolean>;

export const statusState = oneOf(STATUS_STATES);
export const statusReason = oneOf(STATUS_REASONS);
export const frameReason = oneOf(FRAME_REASONS);
export const withholdReason = oneOf(WITHHOLD_REASONS);
export const alertId = oneOf(ALERT_IDS);

// Params never carry free text from a runtime: each is a number, a boolean, a runtime kind or a model label (class B).
const PARAM_KINDS = {
  port: (value: unknown) => { const n = count(value); return n !== null && n >= 1 && n <= 65_535 ? n : null; },
  at, ms: nonneg, bytes: signedInt, boolean: bool, runtime: runtimeKind, model: (value: unknown) => modelLabel(value),
  pressureLevel: oneOf([1, 2, 4] as const), thermalLevel: oneOf([0, 1, 2, 3, 4] as const),
} satisfies Record<string, (value: unknown) => string | number | boolean | null>;
type ParamKind = keyof typeof PARAM_KINDS;
type Allowlist = Readonly<Record<string, ParamKind>>;

const NONE: Allowlist = {};
export const STATUS_PARAMS: Readonly<Record<StatusReason, Allowlist>> = {
  runtime_unreachable: { port: 'port', sinceAt: 'at' }, authentication_failed: NONE, configuration_missing: NONE,
  unsupported_runtime: NONE, unsupported_contract: NONE, detecting: { port: 'port' }, redetecting: { port: 'port' },
  runtime_changed: { detected: 'runtime', port: 'port' }, loading: NONE,
  // Splash free text (transport.error, metal.failure_reason, the crash-trace path) crosses only as presence booleans.
  recovering: { retryInMs: 'ms', crashTrace: 'boolean', transportError: 'boolean' },
  status_stale: { staleSinceAt: 'at', transportError: 'boolean' },
  not_admitting: { metalUnhealthy: 'boolean', memoryCritical: 'boolean', metalFailure: 'boolean' },
  admin_unauthorized: NONE, lms_unavailable: NONE, metrics_required: NONE, sleeping: NONE,
};
export const ALERT_PARAMS: Readonly<Record<AlertId, Allowlist>> = {
  'runtime-lost': { runtime: 'runtime' }, 'model-unloaded': { model: 'model' },
  'pressure-warning': { level: 'pressureLevel' }, 'pressure-critical': { level: 'pressureLevel' },
  'swap-growth': { deltaBytes: 'bytes', windowMs: 'ms' }, thermal: { level: 'thermalLevel' },
  'splash-recovering': { retryInMs: 'ms', crashTrace: 'boolean' }, 'omlx-prefill-stall': { stalledMs: 'ms' }, 'omlx-memory-guard': NONE,
};

/** Keeps only allowlisted params whose values pass their kind; everything else is dropped. */
export const parseParams = (value: unknown, allowed: Allowlist): ReasonParams => {
  const source = obj(value), result: ReasonParams = {};
  if (source) for (const [key, kind] of Object.entries(allowed)) {
    const parsed = Object.hasOwn(source, key) ? PARAM_KINDS[kind](source[key]) : null;
    if (parsed !== null) result[key] = parsed;
  }
  return result;
};

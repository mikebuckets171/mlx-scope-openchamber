import type { Severity } from '../../src/contract/alerts.ts';
import type { ReasonParams } from '../../src/contract/reasons.ts';
import type { RuntimeKind } from '../../src/contract/runtime.ts';
import type { ConnectionV2, Phase, SnapshotV2 } from '../../src/contract/snapshot.ts';
import { clock, dur, size } from './format.ts';

// The 2.0 panel's English, from the approved G2 mock copy table (docs/design/2.0-mock.html), amended by S2: no
// sessions grant, so no other-chat or subagent reasons, and the inferred ⓘ says what can't be ruled out.

/** Short product names for sentences; `runtimeNames` (src/contract/runtime.ts) stays the menu vocabulary. */
export const RT: Record<RuntimeKind, string> = {
  omlx: 'oMLX', lmstudio: 'LM Studio', splash: 'Splash', 'vllm-mlx': 'vllm-mlx', 'mlx-lm': 'mlx-lm', 'llama-server': 'llama-server', ollama: 'Ollama',
};
type Named = Pick<ConnectionV2, 'runtime' | 'host' | 'engine' | 'label'> & { id?: string };
/** The runtime as a sentence subject: "Bionic" rather than "LM Studio" when Bionic hosts it. */
export const rtName = (connection: Named | null): string =>
  connection?.host === 'bionic' ? 'Bionic' : connection?.runtime ? RT[connection.runtime] : 'the runtime';
/** What is being watched, as the masthead names it. */
export const connName = (connection: Named | null): string => {
  if (!connection) return 'Local runtime';
  if (connection.runtime === 'lmstudio' && connection.engine === 'splash') return connection.host === 'bionic' ? 'Splash via Bionic' : 'Splash via LM Studio';
  if (connection.host === 'bionic') return 'Bionic';
  // "Automatic" names the choice, not the runtime; once one is detected, say which.
  return connection.id === 'auto' && connection.runtime ? RT[connection.runtime] : connection.label;
};

export const PHASE: Record<Phase, string> = {
  decode: 'Generating', prefill: 'Reading context', idle: 'Idle', queued: 'Queued', processing: 'Processing', loading: 'Loading',
  'not-loaded': 'No model loaded', unknown: 'Connected',
};
const STATE_WORD: Partial<Record<SnapshotV2['status']['state'], string>> = { recovering: 'Recovering', failing: 'Offline', detecting: 'Detecting', unconfigured: 'Not set up' };
const REASON_WORD: Partial<Record<string, string>> = { status_stale: 'Status stale', not_admitting: 'Not admitting', runtime_changed: 'Runtime changed', sleeping: 'Asleep', loading: 'Loading' };
export const phaseLabel = (snapshot: SnapshotV2): string =>
  STATE_WORD[snapshot.status.state] ?? (snapshot.status.reason ? REASON_WORD[snapshot.status.reason] : undefined) ?? PHASE[snapshot.runtime.phase];

export type Level = 'normal' | 'warning' | 'critical';
export const PRESSURE: Record<1 | 2 | 4, [word: string, level: Level]> = { 1: ['Normal', 'normal'], 2: ['Warning', 'warning'], 4: ['Critical', 'critical'] };
/** notifyutil thermal pressure 0–4: the user-facing word, and macOS's own level name for the ⓘ. One threshold everywhere (G2). */
export const THERMAL: ReadonlyArray<readonly [word: string, macos: string]> = [['Normal', 'nominal'], ['Moderate', 'moderate'], ['Heavy', 'heavy'], ['Severe', 'trapping'], ['Critical', 'sleeping']];
export const THERMAL_WARN = 2;
export const thermalLevel = (level: number): Level => level >= 3 ? 'critical' : level >= THERMAL_WARN ? 'warning' : 'normal';

/** "Server-wide · <why>": one reason per item. Unknown codes read as not observed rather than inventing one. */
const WITHHOLD: Record<string, (chatRuntime: string | null) => string> = {
  'other-provider': chat => chat ? `this chat uses ${chat}` : 'this chat uses another runtime', 'model-differs': () => 'chat model differs',
  'model-unknown': () => 'chat model unknown', 'cannot-count': () => 'runtime can’t count requests', overlap: () => 'overlapping requests',
  'outside-turn': () => 'outside this chat’s turn', 'joined-mid-turn': () => 'joined mid-turn', 'not-observed': () => 'not observed',
  'auto-off': () => 'auto-labelling off', 'all-requests': () => 'all requests',
};
export const withheldWhy = (reason: string, chatRuntime: string | null = null): string => (WITHHOLD[reason] ?? WITHHOLD['not-observed']!)(chatRuntime);

/** The ⓘ behind an attribution chip: [title, first, second?]. */
export const whyCopy = (key: string, rt: string, live: boolean, chatRuntime: string | null = null): [string, string, ...string[]] => {
  const alternating = 'Alternating requests from another chat can’t be ruled out.';
  switch (key) {
    case 'inferred': return ['This chat · inferred', live
      ? `${rt} matches this chat’s model with one request at a time. Scope has observed this turn from the start.`
      : `${rt} matched this chat’s model with one request at a time. Scope observed the whole reply.`,
    `Inferred from chat activity; ${rt} reports no chat identity. ${alternating} Background calls, including title generation, may fall inside this turn.`];
    case 'armed': return ['Next reply · armed', live
      ? `You armed Next reply. Each observed step matches this chat’s model on ${rt}.`
      : `You armed Next reply. Every step matched this chat’s model on ${rt}.`,
    `Chat activity is inferred, not reported by ${rt}. ${alternating}`];
    case 'other-provider': return ['Server-wide', `This chat uses ${chatRuntime ?? 'another runtime'}. ${rt} is serving another app or chat.`,
      chatRuntime ? `Watch ${chatRuntime} to label this chat’s readings.` : 'Watch this chat’s runtime to label its readings.'];
    case 'model-differs': return ['Server-wide', `${rt} is running a different model for another app or chat.`, 'Scope never loads or switches models.'];
    case 'model-unknown': return ['Server-wide', `This chat’s model is unknown; ${rt} readings can’t be attributed.`];
    case 'not-observed': return ['Server-wide', `No Scope view observed this turn on ${rt}.`, 'Labels need a Scope view open for the whole reply.'];
    case 'overlap': return ['Server-wide', `Requests overlapped on ${rt}; readings can’t be attributed.`, 'Per-request speed comes back when one request runs.'];
    case 'cannot-count': return ['Server-wide', `${rt} reports no request count; readings can’t be attributed.`];
    case 'outside-turn': return ['Server-wide', `${rt} ran this request outside the turn, perhaps for a title or recap.`];
    case 'joined-mid-turn': return ['Server-wide', `Scope joined this turn on ${rt} after it started.`, 'The next turn is labelled from its start.'];
    case 'auto-off': return ['Server-wide', 'Automatic per-chat labels are turned off.', 'Next reply still measures one reply when you arm it.'];
    default: return ['Server-wide', `Everything ${rt} is doing, from any app or chat.`, 'Per-chat labels need per-request readings and one running chat.'];
  }
};

type Params = ReasonParams;
const runtimeOf = (params: Params, key: string): string | null => typeof params[key] === 'string' ? RT[params[key] as RuntimeKind] ?? null : null;
/** Alert → [title, detail]. The title can carry a model name (class B): it is for the in-view callout only. */
export const alertCopy = (id: string, params: Params): [string, string] => {
  switch (id) {
    case 'runtime-lost': return [`${runtimeOf(params, 'runtime') ?? 'The runtime'} stopped responding`, 'Scope checks again automatically'];
    case 'model-unloaded': return [typeof params.model === 'string' ? `${params.model} was unloaded` : 'A model was unloaded', 'Reported by the runtime · Scope never loads models'];
    case 'pressure-warning': return ['macOS memory pressure: warning', 'Reported by the macOS kernel · apps may be compressed or swapped'];
    case 'pressure-critical': return ['macOS memory pressure: critical', 'Reported by the macOS kernel · replies may slow sharply until memory frees up'];
    case 'swap-growth': return [`Swap grew ${typeof params.deltaBytes === 'number' ? size(params.deltaBytes) : 'quickly'}${typeof params.windowMs === 'number' ? ` in ${Math.max(1, Math.round(params.windowMs / 60_000))} min` : ''}`,
      'Within one continuous stretch of readings'];
    case 'thermal': return [`Thermal pressure: ${(THERMAL[typeof params.level === 'number' ? params.level : 2]?.[0] ?? 'Heavy').toLowerCase()}`, 'Reported by macOS · the chip may run slower'];
    case 'splash-recovering': return ['Splash was recovering', 'Reported by Splash'];
    case 'omlx-prefill-stall': return ['Prefill progress stopped moving', `No change for ${dur(typeof params.stalledMs === 'number' ? params.stalledMs : 30_000)} · reported by oMLX`];
    case 'omlx-memory-guard': return ['oMLX memory guard is active', 'Reported by oMLX · new requests wait until memory frees up · not macOS memory pressure'];
    default: return ['Scope noticed a change', 'Reported by the runtime'];
  }
};
/** Toast text never names a model (P6): the one class-B alert reads generically. */
export const alertToastCopy = (id: string, params: Params): string => {
  const [title, detail] = alertCopy(id, id === 'model-unloaded' ? {} : params);
  return `MLX Scope · ${title}. ${detail}.`;
};

export interface StatusCopy { severity: Severity; title: string; detail: string; since?: number; action?: 'connection' | 'switch' }
const port = (params: Params): string => typeof params.port === 'number' ? `:${params.port}` : 'its port';
/** Why a connection can't be read (`configuration_missing {issue}`): the 1.6 configuration wording. */
const CONFIG: Partial<Record<string, string>> = {
  malformed_config: 'Correct the malformed provider configuration in OpenChamber.',
  unreadable_config: 'A provider configuration or credential file is unreadable.',
  read_failed: 'Check the provider in OpenChamber, then reopen Scope.',
  invalid_endpoint: 'Use an HTTP loopback URL with a port, e.g. http://localhost:8000/v1.',
  unsupported_config: 'Unresolved credential or endpoint. Reconnect the provider in OpenChamber.',
  removed: 'Connection removed. Choose another or Automatic.',
};
/** A status reason as the one callout that carries it; nothing else in the view repeats it. */
export const statusCopy = (snapshot: SnapshotV2): StatusCopy | null => {
  const { reason, params, sinceAt } = snapshot.status, rt = rtName(snapshot.connection);
  const since = typeof params.sinceAt === 'number' ? params.sinceAt : sinceAt;
  switch (reason) {
    // All eight connection slots are mid-read: this one waits its turn (1.6 "Earlier connection reads are finishing").
    case 'runtime_unreachable': return params.deferred === true
      ? { severity: 'info', title: 'Waiting for a free connection slot', detail: 'Other reads are finishing. Scope retries automatically.' }
      : { severity: 'critical', title: `${rt === 'the runtime' ? 'The runtime' : rt} stopped responding`, since,
        detail: `Start ${rt} on ${port(params)}. Scope retries automatically.`, action: 'connection' };
    case 'authentication_failed': return { severity: 'critical', title: `${rt === 'the runtime' ? 'The runtime' : rt} ${params.keySaved === false ? 'needs an API key' : 'refused Scope’s key'}`,
      detail: params.keySaved === false ? 'Connect the provider in OpenChamber. Scope never stores keys.'
        : 'Check Connection. Scope reads the runtime’s key without storing it.', action: 'connection' };
    case 'configuration_missing': return typeof params.issue === 'string' && CONFIG[params.issue]
      ? { severity: 'warning', title: 'This connection can’t be read', detail: CONFIG[params.issue]!, action: 'connection' }
      : { severity: 'warning', title: 'No runtime found', detail: 'Nothing answered on the usual local ports. Start a runtime, or choose one.', action: 'connection' };
    case 'unsupported_runtime': return { severity: 'warning', title: 'Scope doesn’t recognise this runtime',
      detail: `Unsupported runtime on ${port(params)}.`, action: 'connection' };
    case 'unsupported_contract': return { severity: 'warning', title: `${rt === 'the runtime' ? 'The runtime' : rt} answered in a shape Scope doesn’t know`,
      detail: 'Readable metrics remain. Scope redetects after 3 tries.' };
    case 'detecting': return { severity: 'info', title: 'Looking for a runtime', detail: `Checking ${port(params)} for a supported runtime.` };
    case 'redetecting': return { severity: 'info', title: 'Checking which runtime this is', detail: `${rt} stopped answering like itself on ${port(params)}.` };
    case 'runtime_changed': {
      const detected = runtimeOf(params, 'detected') ?? 'another runtime';
      return { severity: 'warning', title: `Looks like ${detected} now`, action: 'switch',
        detail: `${detected} answers on ${port(params)}; ${connName(snapshot.connection)} is selected. Scope never switches automatically.` };
    }
    case 'loading': return { severity: 'info', title: `${rt === 'the runtime' ? 'The runtime' : rt} is loading a model`,
      detail: snapshot.connection.runtime === 'llama-server' ? 'Its health check answers 503 until the model is ready.' : 'Readings start when the model is ready.' };
    case 'recovering': return { severity: 'warning', title: 'Splash is recovering', since,
      detail: `Its engine is restarting after a fault. Scope checks status every 30 s.${params.crashTrace === true ? ' Crash trace recorded; Scope never shows or sends it.' : ''}` };
    case 'status_stale': return { severity: 'warning', title: 'Splash’s status is stale', since,
      detail: 'Splash hasn’t refreshed its status. Readings are last observed.' };
    case 'not_admitting': return { severity: 'warning', title: 'Splash isn’t accepting new requests',
      detail: params.cause === 'metal' || params.metalUnhealthy === true ? 'Metal device unhealthy; new requests wait in the queue.'
        : params.cause === 'memory' || params.memoryCritical === true ? 'Runtime memory pressure critical; new requests wait in the queue.'
          : 'Splash isn’t ready; new requests wait in the queue.' };
    case 'admin_unauthorized': return { severity: 'info', title: 'oMLX admin login refused', action: 'connection',
      detail: 'Public status only: server-wide totals, without request speed, reply history or usage records.' };
    case 'lms_unavailable': return { severity: 'info', title: 'Bionic isn’t answering Scope’s check',
      detail: 'Scope waits for Bionic before running lms. It never starts Bionic; instance and engine readings resume when Bionic answers.' };
    // wakes: the build has --metrics, but its /metrics wakes a sleeping server (b7492–b10518), so the fix is an update (§12.9).
    case 'metrics_required': return params.wakes === true
      ? { severity: 'info', title: 'Live slots need a newer llama-server',
        detail: '/metrics wakes this build. Update to b10519+ for slots and throughput.' }
      : { severity: 'info', title: 'Live slots need --metrics',
        detail: 'Start with --metrics for slots and throughput without waking the server.' };
    case 'sleeping': return { severity: 'info', title: 'llama-server is asleep',
      detail: 'Model unloaded until the next request. Scope skips slots to preserve sleep.' };
    default: {
      // A state without a reason still says what it means; a reason code this build doesn't know never blanks the view.
      const state = snapshot.status.state;
      if (state === 'failing') return { severity: 'critical', title: `${rt === 'the runtime' ? 'The runtime' : rt} isn’t answering`, since,
        detail: 'Scope checks again automatically.', action: 'connection' };
      if (state === 'unconfigured') return { severity: 'warning', title: 'No runtime found', detail: 'Nothing answered on the usual local ports. Start a runtime, or choose one.', action: 'connection' };
      if (state === 'detecting') return { severity: 'info', title: 'Looking for a runtime', detail: 'Checking the usual local ports.' };
      return null;
    }
  }
};
/** Line 2 of the 280 px glance while a status message holds it: one short phrase; the callout in Scope has the rest. */
const GLANCE_NOTE: Partial<Record<string, string>> = {
  runtime_unreachable: 'Scope checks again automatically', authentication_failed: 'Check the key under Connection',
  configuration_missing: 'Start a runtime, or choose one', unsupported_runtime: 'Choose a connection in MLX Scope',
  unsupported_contract: 'Scope shows what it can still read', detecting: 'Checking the usual local ports', redetecting: 'Checking which runtime answers',
  runtime_changed: 'Scope never switches on its own', loading: 'Readings start when it’s ready', recovering: 'Scope reads its status every 30 s',
  status_stale: 'Its readings are last observed', not_admitting: 'New requests wait in its queue', admin_unauthorized: 'Server-wide totals only',
  lms_unavailable: 'Scope never starts Bionic', metrics_required: 'Live slots need --metrics or an update', sleeping: 'Scope lets it sleep',
};
export const statusGlanceNote = (snapshot: SnapshotV2): string => (snapshot.status.reason ? GLANCE_NOTE[snapshot.status.reason] : undefined)
  ?? (snapshot.status.state === 'unconfigured' ? GLANCE_NOTE.configuration_missing! : snapshot.status.state === 'detecting' ? GLANCE_NOTE.detecting! : GLANCE_NOTE.runtime_unreachable!);

export const SEVERITY_WORD: Record<Severity, string> = { critical: 'Critical', warning: 'Warning', info: 'Notice' };
export const sinceText = (at: number | undefined, now: number): string => at === undefined ? '' : `since ${clock(at, now)}`;

// Frame states: the service can't answer, so nothing below is a runtime reading (plan §6, SPIKES S11). No sessions grant (S2).
export const APPROVAL = {
  title: 'MLX Scope 2.0 needs one approval',
  body: 'Allow Mac GPU, thermal and process readings, plus LM Studio’s CLI without starting it. Chat labels use the open chat’s activity without extra permissions. History stays local.',
  steps: ['Open Settings → Extensions → MLX Scope.', 'Choose Needs approval, then allow and enable.'],
  grant: [
    ['GPU readings', '/usr/sbin/ioreg'], ['Thermal pressure', '/usr/bin/notifyutil'], ['oMLX process memory', '/usr/sbin/lsof, /usr/bin/footprint'],
    ['LM Studio and Bionic', '~/.lmstudio/bin/lms, ~/.cache/lm-studio/bin/lms', 'never starts either app'],
    ['Chip power (optional)', '/opt/homebrew/bin/macmon, /usr/local/bin/macmon', 'only if you installed macmon'],
    // By name: the panel bundle never carries the service's own exec paths (scripts/verify-package.ts leak check).
    ['Memory (as in 1.x)', 'vm_stat, sysctl', 'the two commands 1.x already ran'],
  ] as ReadonlyArray<readonly [string, string, string?]>,
  note: 'Reads start after approval. Saved 1.6 captures stay. No sudo, osascript or powermetrics.',
  glance: 'Settings → Extensions → MLX Scope',
} as const;
export const RESTART = {
  title: 'MLX Scope needs a restart',
  body: 'The panel was updated, but its local service is still the old version.',
  steps: ['Open Settings → Extensions → MLX Scope.', 'Pause it, then resume it.'],
  note: 'Your history and captures are kept.',
  glance: 'Pause and resume it in Settings → Extensions',
} as const;
export const TIP = 'Replace Turn stats: hide it in Panel sections and drag MLX Scope into its place';
export const TIP_INFO = 'Turn stats hides for all chats. For cloud chats, Scope shows “Chat uses a non-local model”.';
export const FIRST_RUN = 'Recording reply history locally';
export const NON_LOCAL = 'Chat uses a non-local model';
export const NO_FRESH = 'No fresh readings';
export const NO_FRESH_DETAIL = 'Retained readings are not live. Scope keeps asking.';
/** A poll with no body: the host or the service failed. The detail is 1.6's message (panel/host-errors.ts), unchanged. */
export const FRAME_TITLE: Partial<Record<string, string>> = {
  service_failed: 'MLX Scope’s service isn’t running', host_unavailable: 'OpenChamber can’t reach MLX Scope’s service',
  host_timeout: 'MLX Scope’s service didn’t answer in time', host_disconnected: 'OpenChamber disconnected MLX Scope',
  host_rejected: 'OpenChamber rejected Scope’s request', unparseable_snapshot: 'Scope couldn’t read its service’s reply',
  service_not_granted: 'MLX Scope’s service isn’t approved', runtime_unreachable: 'Waiting for a reading',
};

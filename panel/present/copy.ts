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
  connection?.host === 'bionic' ? 'Bionic' : connection?.runtime ? RT[connection.runtime] : 'the server';
/** What is being watched, as the masthead names it. */
export const connName = (connection: Named | null): string => {
  if (!connection) return 'Local server';
  if (connection.runtime === 'lmstudio' && connection.engine === 'splash') return connection.host === 'bionic' ? 'Splash via Bionic' : 'Splash via LM Studio';
  if (connection.host === 'bionic') return 'Bionic';
  if (connection.host === 'llama-swap' && connection.runtime) return `${RT[connection.runtime]} via llama-swap`;
  // "Automatic" names the choice, not the runtime; once one is detected, say which.
  return connection.id === 'auto' && connection.runtime ? RT[connection.runtime] : connection.label;
};

export const PHASE: Record<Phase, string> = {
  decode: 'Generating', prefill: 'Reading prompt', idle: 'Idle', queued: 'Waiting', processing: 'Working', loading: 'Loading',
  'not-loaded': 'No model loaded', unknown: 'Connected',
};
const STATE_WORD: Partial<Record<SnapshotV2['status']['state'], string>> = { recovering: 'Recovering', failing: 'Offline', detecting: 'Detecting', unconfigured: 'Not set up' };
const REASON_WORD: Partial<Record<string, string>> = { status_stale: 'Waiting for update', not_admitting: 'Not ready', runtime_changed: 'Server changed', sleeping: 'Asleep', loading: 'Loading' };
export const phaseLabel = (snapshot: SnapshotV2): string =>
  STATE_WORD[snapshot.status.state] ?? (snapshot.status.reason ? REASON_WORD[snapshot.status.reason] : undefined) ?? PHASE[snapshot.runtime.phase];

export type Level = 'normal' | 'warning' | 'critical';
export const PRESSURE: Record<1 | 2 | 4, [word: string, level: Level]> = { 1: ['Normal', 'normal'], 2: ['Warning', 'warning'], 4: ['Critical', 'critical'] };
/** notifyutil thermal pressure 0–4: the user-facing word, and macOS's own level name for the ⓘ. One threshold everywhere (G2). */
export const THERMAL: ReadonlyArray<readonly [word: string, macos: string]> = [['Normal', 'nominal'], ['Moderate', 'moderate'], ['Heavy', 'heavy'], ['Severe', 'trapping'], ['Critical', 'sleeping']];
export const THERMAL_WARN = 2;
export const thermalLevel = (level: number): Level => level >= 3 ? 'critical' : level >= THERMAL_WARN ? 'warning' : 'normal';

/** "Server-wide · <why>": one reason per item. Unknown codes read as not observed rather than inventing one. */
const WITHHOLD: Record<string, string> = {
  'other-provider': 'this chat uses another server', 'model-differs': 'different chat model',
  'model-unknown': 'chat model unknown', 'cannot-count': 'request count unavailable', overlap: 'several requests at once',
  'outside-turn': 'outside this reply', 'joined-mid-turn': 'monitoring started during this reply', 'not-observed': 'not recorded',
  'auto-off': 'auto-labelling off', 'all-requests': 'all requests',
};
export const withheldWhy = (reason: string, chatRuntime: string | null = null): string => reason === 'other-provider' && chatRuntime ? `this chat uses ${chatRuntime}` : WITHHOLD[reason] ?? WITHHOLD['not-observed']!;

const allActivity = (...detail: [string, ...string[]]): [string, string, ...string[]] => ['Engine', ...detail];
const attributionBoundary = (rt: string): string => `${rt} does not identify which chat made a request. Alternating requests from another chat can’t be ruled out.`;
/** The ⓘ behind an attribution chip: [title, first, second?]. */
export const whyCopy = (key: string, rt: string, live: boolean, chatRuntime: string | null = null): [string, string, ...string[]] => {
  switch (key) {
    case 'inferred': return ['This chat', live
      ? `${rt} matches this chat’s model with one request at a time. Scope has observed this turn from the start.`
      : `${rt} matched this chat’s model with one request at a time. Scope observed the whole reply.`,
    `Scope matches chat activity; ${attributionBoundary(rt)} Calls for titles may be included.`];
    case 'armed': return ['This chat', `You measured this reply with Scope 5.0; every step matched this chat’s model on ${rt}.`, attributionBoundary(rt)];
    case 'other-provider': return allActivity(`This chat uses ${chatRuntime ?? 'another server'}. ${rt} is serving another app or chat.`,
      chatRuntime ? `Watch ${chatRuntime} to label this chat’s readings.` : 'Watch this chat’s server to label its readings.');
    case 'model-differs': return allActivity(`${rt} is running a different model for another app or chat.`, 'Scope never loads or switches models.');
    case 'model-unknown': return allActivity(`Scope does not know this chat’s model, so it cannot match these readings to the chat.`);
    case 'not-observed': return allActivity(`Scope was not watching this reply on ${rt}.`, 'Keep Scope open for the whole reply to match its readings.');
    case 'overlap': return allActivity(`Several requests ran at once on ${rt}, so Scope cannot separate this chat’s readings.`, 'Individual request speed returns when one request runs.');
    case 'cannot-count': return allActivity(`${rt} does not count requests, so Scope cannot match readings to this chat.`);
    case 'outside-turn': return allActivity(`${rt} ran this request outside the reply, perhaps for a title or recap.`);
    case 'joined-mid-turn': return allActivity(`Scope started watching this reply on ${rt} after it began.`, 'The next reply can be matched from its start.');
    case 'auto-off': return allActivity('Automatic chat labels are turned off.', 'Turn them on in History → Reply history.');
    default: return allActivity(`Everything ${rt} is doing, from any app or chat.`, 'Chat labels need separate request readings and one request at a time.');
  }
};

type Params = ReasonParams;
const runtimeOf = (params: Params, key: string): string | null => typeof params[key] === 'string' ? RT[params[key] as RuntimeKind] ?? null : null;
/** Alert → [title, detail]. The title can carry a model name (class B): it is for the in-view callout only. */
export const alertCopy = (id: string, params: Params): [string, string] => {
  switch (id) {
    case 'runtime-lost': return [`${runtimeOf(params, 'runtime') ?? 'The server'} stopped responding`, 'Scope checks again automatically'];
    case 'model-unloaded': return [typeof params.model === 'string' ? `${params.model} was unloaded` : 'A model was unloaded', 'Reported by the server · Scope never loads models'];
    case 'pressure-warning': return ['macOS memory pressure: warning', 'Reported by macOS · it may move some app memory to disk'];
    case 'pressure-critical': return ['macOS memory pressure: critical', 'Reported by macOS · replies may slow until memory frees up'];
    case 'swap-growth': return [`Swap grew ${typeof params.deltaBytes === 'number' ? size(params.deltaBytes) : 'quickly'}${typeof params.windowMs === 'number' ? ` in ${Math.max(1, Math.round(params.windowMs / 60_000))} min` : ''}`,
      'Within one continuous stretch of readings'];
    case 'thermal': return [`Heat: ${(THERMAL[typeof params.level === 'number' ? params.level : 2]?.[0] ?? 'Heavy').toLowerCase()}`, 'Reported by macOS · the chip may run slower'];
    case 'splash-recovering': return ['Splash was recovering', 'Reported by Splash'];
    case 'omlx-prefill-stall': return ['Prefill progress stopped moving', `No change for ${dur(typeof params.stalledMs === 'number' ? params.stalledMs : 30_000)} · reported by oMLX`];
    case 'omlx-memory-guard': return ['oMLX is waiting for memory', 'Reported by oMLX · new requests wait until enough memory is available'];
    default: return ['Scope noticed a change', 'Reported by the server'];
  }
};
/** Toast text never names a model (P6): the one class-B alert reads generically. */
export const alertToastCopy = (id: string, params: Params): string => {
  const [title, detail] = alertCopy(id, id === 'model-unloaded' ? {} : params);
  return `MLX Scope · ${title}. ${detail}.`;
};

export interface StatusCopy { severity: Severity; title: string; detail: string; since?: number; action?: 'connection' | 'switch' }
const statusMessage = (severity: Severity, title: string, detail: string, extra?: Pick<StatusCopy, 'since' | 'action'>): StatusCopy =>
  ({ severity, title, detail, ...extra });
const port = (params: Params): string => typeof params.port === 'number' ? `:${params.port}` : 'its port';
const missingConnection = (): StatusCopy => statusMessage('warning', 'No local server found', 'Nothing answered on the usual local ports. Start a server, or choose one.', { action: 'connection' });
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
  const since = typeof params.sinceAt === 'number' ? params.sinceAt : sinceAt, subject = rt === 'the server' ? 'The server' : rt;
  switch (reason) {
    // All eight connection slots are mid-read: this one waits its turn (1.6 "Earlier connection reads are finishing").
    case 'runtime_unreachable': return params.deferred === true
      ? statusMessage('info', 'Waiting for a free connection slot', 'Other reads are finishing. Scope retries automatically.')
      : statusMessage('critical', `${subject} stopped responding`, `Start ${rt} on ${port(params)}. Scope retries automatically.`, { since, action: 'connection' });
    case 'authentication_failed': return statusMessage('critical', `${subject} ${params.keySaved === false ? 'needs an API key' : 'refused Scope’s key'}`, params.keySaved === false ? 'Connect the provider in OpenChamber. Scope never stores keys.'
        : 'Check Connection. Scope reads the server’s key without storing it.', { action: 'connection' });
    case 'configuration_missing': return typeof params.issue === 'string' && CONFIG[params.issue]
      ? statusMessage('warning', 'This connection can’t be read', CONFIG[params.issue]!, { action: 'connection' })
      : missingConnection();
    case 'unsupported_runtime': return statusMessage('warning', 'Scope doesn’t recognise this server', `Unsupported server on ${port(params)}.`, { action: 'connection' });
    case 'unsupported_contract': return statusMessage('warning', `${subject} answered in a shape Scope doesn’t know`, 'Scope shows the readings it understands and checks again automatically.');
    case 'detecting': return statusMessage('info', 'Looking for a local server', `Checking ${port(params)} for a supported server.`);
    case 'redetecting': return statusMessage('info', 'Checking which server this is', `${rt} stopped answering like itself on ${port(params)}.`);
    case 'runtime_changed': {
      const detected = runtimeOf(params, 'detected') ?? 'another server';
      return statusMessage('warning', `Looks like ${detected} now`, `${detected} answers on ${port(params)}; ${connName(snapshot.connection)} is selected. Scope never switches automatically.`, { action: 'switch' });
    }
    case 'loading': return statusMessage('info', `${subject} is loading a model`, 'Readings start when the model is ready.');
    case 'recovering': return statusMessage('warning', 'Splash is recovering', `Splash is restarting after a problem. Scope checks again every 30 seconds.${params.crashTrace === true ? ' Splash saved an error report; Scope does not share it.' : ''}`, { since });
    case 'status_stale': return statusMessage('warning', 'Waiting for a Splash update', 'Splash has not sent an update. Older readings stay labeled.', { since });
    case 'not_admitting': return statusMessage('warning', 'Splash isn’t accepting new requests', params.cause === 'metal' || params.metalUnhealthy === true ? 'Splash reported a graphics problem. New requests are waiting.'
        : params.cause === 'memory' || params.memoryCritical === true ? 'Memory is full. New requests are waiting.'
          : 'Splash is not ready. New requests are waiting.');
    case 'admin_unauthorized': return statusMessage('info', 'oMLX admin login refused', 'Only server totals are available. Individual speeds, reply history and usage are unavailable.', { action: 'connection' });
    case 'lms_unavailable': return statusMessage('info', 'Bionic isn’t answering Scope’s check', 'Scope waits for Bionic before running lms. It never starts Bionic; model details return when Bionic answers.');
    // wakes: the build has --metrics, but its /metrics wakes a sleeping server (b7492–b10518), so the fix is an update (§12.9).
    case 'metrics_required': return statusMessage('info', params.wakes === true ? 'Live requests need a newer llama-server' : 'Live request details need --metrics',
      `${params.wakes === true ? 'Update to b10519+' : 'Start with --metrics'} to read active requests and speeds without waking the model.`);
    case 'sleeping': return statusMessage('info', 'llama-server is asleep', 'The model will load on the next request. Scope lets it sleep.');
    default: {
      // A state without a reason still says what it means; a reason code this build doesn't know never blanks the view.
      const state = snapshot.status.state;
      if (state === 'failing') return statusMessage('critical', `${subject} isn’t answering`, 'Scope checks again automatically.', { since, action: 'connection' });
      if (state === 'unconfigured') return missingConnection();
      if (state === 'detecting') return statusMessage('info', 'Looking for a local server', 'Checking the usual local ports.');
      return null;
    }
  }
};
/** Line 2 of the 280 px glance while a status message holds it: one short phrase; the callout in Scope has the rest. */
const GLANCE_NOTE: Partial<Record<string, string>> = {
  runtime_unreachable: 'Scope checks again automatically', authentication_failed: 'Check the key under Connection',
  configuration_missing: 'Start a server, or choose one', unsupported_runtime: 'Choose a connection in MLX Scope',
  unsupported_contract: 'Scope shows what it can still read', detecting: 'Checking the usual local ports', redetecting: 'Checking which server answers',
  runtime_changed: 'Scope never switches on its own', loading: 'Readings start when it’s ready', recovering: 'Scope reads its status every 30 s',
  status_stale: 'Waiting for updated readings', not_admitting: 'New requests wait in its queue', admin_unauthorized: 'Server totals only',
  lms_unavailable: 'Scope never starts Bionic', metrics_required: 'Live request details need --metrics or an update', sleeping: 'Waiting for the next request',
};
export const statusGlanceNote = (snapshot: SnapshotV2): string => (snapshot.status.reason ? GLANCE_NOTE[snapshot.status.reason] : undefined)
  ?? (snapshot.status.state === 'unconfigured' ? GLANCE_NOTE.configuration_missing! : snapshot.status.state === 'detecting' ? GLANCE_NOTE.detecting! : GLANCE_NOTE.runtime_unreachable!);

export const SEVERITY_WORD: Record<Severity, string> = { critical: 'Critical', warning: 'Warning', info: 'Notice' };
export const sinceText = (at: number | undefined, now: number): string => at === undefined ? '' : `since ${clock(at, now)}`;

// Frame states: the service can't answer, so nothing below is a runtime reading (plan §6, SPIKES S11). No sessions grant (S2).
export const APPROVAL = {
  title: 'MLX Scope needs one approval',
  body: 'Allow Mac GPU, thermal and process readings, plus LM Studio’s CLI without starting it. Chat labels use the open chat’s activity without extra permissions. History stays local.',
  steps: ['Open Settings → Extensions → MLX Scope.', 'Choose Needs approval, then allow and enable.'],
  grant: [
    ['GPU readings', '/usr/sbin/ioreg'], ['Thermal pressure', '/usr/bin/notifyutil'], ['oMLX process memory', '/usr/sbin/lsof, /usr/bin/footprint'],
    ['LM Studio and Bionic', '~/.lmstudio/bin/lms, ~/.cache/lm-studio/bin/lms', 'never starts either app'],
    ['Chip power (optional)', '/opt/homebrew/bin/macmon, /usr/local/bin/macmon', 'only if you installed macmon'],
    // By name: the panel bundle never carries the service's own exec paths (scripts/verify-package.ts leak check).
    ['Memory (as in 1.x)', 'vm_stat, sysctl', 'the two commands 1.x already ran'],
  ] as ReadonlyArray<readonly [string, string, string?]>,
  note: 'Reads start after approval. Your history stays. No sudo, osascript or powermetrics.',
  glance: 'Settings → Extensions → MLX Scope',
} as const;
export const RESTART = {
  title: 'MLX Scope needs a restart',
  body: 'The panel was updated, but its local service is still the old version.',
  steps: ['Open Settings → Extensions → MLX Scope.', 'Pause it, then resume it.'],
  note: 'Your history is kept.',
  glance: 'Pause and resume it in Settings → Extensions',
} as const;
export const TIP = 'Replace Turn stats: hide it in Panel sections and drag MLX Scope into its place';
export const TIP_INFO = 'Turn stats hides for all chats. For cloud chats, Scope shows “This chat is not using a local model”.';
export const FIRST_RUN = 'Recording reply history locally';
export const NON_LOCAL = 'This chat is not using a local model';
export const NO_FRESH = 'No fresh readings';
export const NO_FRESH_DETAIL = 'Older readings are not current. Scope is waiting for an update.';
export const CHAT_UNAVAILABLE = 'Chat identity unavailable';
/** A read with no body: a host/service failure or deliberately withheld collection. */
export const FRAME_TITLE: Partial<Record<string, string>> = {
  chat_unavailable: CHAT_UNAVAILABLE,
  service_failed: 'MLX Scope’s service isn’t running', host_unavailable: 'OpenChamber can’t reach MLX Scope’s service',
  host_timeout: 'MLX Scope’s service didn’t answer in time', host_disconnected: 'OpenChamber disconnected MLX Scope',
  host_rejected: 'OpenChamber rejected Scope’s request', unparseable_snapshot: 'Scope couldn’t read its service’s reply',
  service_not_granted: 'MLX Scope’s service isn’t approved', runtime_unreachable: 'Waiting for a reading',
};

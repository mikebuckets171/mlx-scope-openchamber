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
  const alternating = 'Another chat alternating requests on the same runtime during this turn can’t be ruled out.';
  switch (key) {
    case 'inferred': return ['This chat · inferred', live
      ? `So far only this chat has been running on ${rt}, its model matches, and Scope has seen every reading since the reply started.`
      : `Only this chat was running on ${rt}, its model matched, and Scope saw the whole reply.`,
    `Inferred from OpenChamber’s activity for this chat: ${rt} doesn’t report which chat a request came from. ${alternating} OpenChamber’s own background model calls, such as title generation, can fall inside an inferred turn.`];
    case 'armed': return ['Next reply · armed', live
      ? `You armed Next reply, and so far at every step this chat has been running on ${rt} with a matching model.`
      : `You armed Next reply, and at every step this chat was running on ${rt} with a matching model.`,
    `Still inferred from chat activity, not reported by ${rt}. ${alternating}`];
    case 'other-provider': return ['Server-wide', `This chat runs on ${chatRuntime ?? 'another runtime'}, so what ${rt} is doing belongs to another app or chat.`,
      chatRuntime ? `Watch ${chatRuntime} to label this chat’s readings.` : 'Watch this chat’s runtime to label its readings.'];
    case 'model-differs': return ['Server-wide', `This chat’s model isn’t the model ${rt} is running, so the reading belongs to another app or chat.`, 'Scope never loads or switches models.'];
    case 'model-unknown': return ['Server-wide', `OpenChamber doesn’t say which model this chat uses, so readings on ${rt} can’t be tied to it.`];
    case 'not-observed': return ['Server-wide', `No Scope view saw this chat’s turn while the reply ran on ${rt}, so it can’t be tied to a chat.`, 'Labels need a Scope view open for the whole reply.'];
    case 'overlap': return ['Server-wide', `More than one request was running on ${rt}, so no reading belongs to a single chat.`, 'Per-request speed comes back when one request runs.'];
    case 'cannot-count': return ['Server-wide', `${rt} doesn’t report how many requests are running, so no reading can be tied to a chat.`];
    case 'outside-turn': return ['Server-wide', `This request ran on ${rt} outside this chat’s turn, such as a title or recap request, so it isn’t labelled.`];
    case 'joined-mid-turn': return ['Server-wide', `Scope opened while this chat’s turn was already running on ${rt}, so it didn’t see the turn start.`, 'The next turn is labelled from its start.'];
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
  malformed_config: 'An existing provider configuration is malformed. Correct it in OpenChamber, then return here.',
  unreadable_config: 'An existing provider configuration or credential file could not be read.',
  read_failed: 'Saved runtime connections could not be read. Reopen MLX Scope after checking the provider in OpenChamber.',
  invalid_endpoint: 'The selected connection needs an HTTP loopback URL with an explicit port, such as http://localhost:8000/v1.',
  unsupported_config: 'A configured credential or endpoint reference could not be resolved. Reconnect this provider in OpenChamber.',
  removed: 'This saved connection is no longer configured. Choose another connection or Automatic.',
};
/** A status reason as the one callout that carries it; nothing else in the view repeats it. */
export const statusCopy = (snapshot: SnapshotV2): StatusCopy | null => {
  const { reason, params, sinceAt } = snapshot.status, rt = rtName(snapshot.connection);
  const since = typeof params.sinceAt === 'number' ? params.sinceAt : sinceAt;
  switch (reason) {
    // All eight connection slots are mid-read: this one waits its turn (1.6 "Earlier connection reads are finishing").
    case 'runtime_unreachable': return params.deferred === true
      ? { severity: 'info', title: 'Waiting for a free connection slot', detail: 'Earlier connection reads are finishing. Monitoring retries automatically.' }
      : { severity: 'critical', title: `${rt === 'the runtime' ? 'The runtime' : rt} stopped responding`, since,
        detail: `Nothing answers on ${port(params)}. Scope checks again automatically, so start ${rt} and it picks up again.`, action: 'connection' };
    case 'authentication_failed': return { severity: 'critical', title: `${rt === 'the runtime' ? 'The runtime' : rt} ${params.keySaved === false ? 'needs an API key' : 'refused Scope’s key'}`,
      detail: params.keySaved === false ? 'Connect this provider in OpenChamber, then return here. Scope never stores keys.'
        : 'Check the key under Connection. Scope reads it from the runtime’s own config and never stores it.', action: 'connection' };
    case 'configuration_missing': return typeof params.issue === 'string' && CONFIG[params.issue]
      ? { severity: 'warning', title: 'This connection can’t be read', detail: CONFIG[params.issue]!, action: 'connection' }
      : { severity: 'warning', title: 'No runtime found', detail: 'Nothing answered on the usual local ports. Start a runtime, or choose one.', action: 'connection' };
    case 'unsupported_runtime': return { severity: 'warning', title: 'Scope doesn’t recognise this runtime',
      detail: `Something answers on ${port(params)}, but not like any runtime Scope supports.`, action: 'connection' };
    case 'unsupported_contract': return { severity: 'warning', title: `${rt === 'the runtime' ? 'The runtime' : rt} answered in a shape Scope doesn’t know`,
      detail: 'Scope shows what it can still read, and checks which runtime this is after 3 tries.' };
    case 'detecting': return { severity: 'info', title: 'Looking for a runtime', detail: `Checking ${port(params)} for oMLX, llama-server, Ollama, LM Studio, Splash and vllm-mlx.` };
    case 'redetecting': return { severity: 'info', title: 'Checking which runtime this is', detail: `${rt} stopped answering like itself on ${port(params)}.` };
    case 'runtime_changed': {
      const detected = runtimeOf(params, 'detected') ?? 'another runtime';
      return { severity: 'warning', title: `Looks like ${detected} now`, action: 'switch',
        detail: `${connName(snapshot.connection)} is chosen, but ${detected} answers on ${port(params)}. Scope never switches on its own.` };
    }
    case 'loading': return { severity: 'info', title: `${rt === 'the runtime' ? 'The runtime' : rt} is loading a model`,
      detail: snapshot.connection.runtime === 'llama-server' ? 'Its health check answers 503 until the model is ready.' : 'Readings start when the model is ready.' };
    case 'recovering': return { severity: 'warning', title: 'Splash is recovering', since,
      detail: `It’s restarting its engine after a fault. Scope reads its status every 30 s, so it doesn’t add to the restart.${params.crashTrace === true ? ' Splash recorded a crash trace; Scope doesn’t show or send it.' : ''}` };
    case 'status_stale': return { severity: 'warning', title: 'Splash’s status is stale', since,
      detail: 'Splash says its status hasn’t refreshed, so Scope marks its readings last observed until it does.' };
    case 'not_admitting': return { severity: 'warning', title: 'Splash isn’t accepting new requests',
      detail: params.cause === 'metal' || params.metalUnhealthy === true ? 'Splash reports its Metal device as unhealthy. New requests wait in its queue.'
        : params.cause === 'memory' || params.memoryCritical === true ? 'Splash reports memory pressure as critical. New requests wait in its queue.'
          : 'Splash reports it isn’t ready for new requests. They wait in its queue.' };
    case 'admin_unauthorized': return { severity: 'info', title: 'oMLX admin login refused', action: 'connection',
      detail: 'Scope reads oMLX’s public status instead: server-wide totals only, with no per-request speed, reply history or usage records.' };
    case 'lms_unavailable': return { severity: 'info', title: 'Bionic isn’t answering Scope’s check',
      detail: 'Scope runs lms only after Bionic answers, so lms can never start it. Loaded instances and engines come back when it answers.' };
    // wakes: the build has --metrics, but its /metrics wakes a sleeping server (b7492–b10518), so the fix is an update (§12.9).
    case 'metrics_required': return params.wakes === true
      ? { severity: 'info', title: 'Live slots need a newer llama-server',
        detail: 'This build can sleep, and its /metrics wakes it. Update llama-server to b10519 or later to see slots and throughput.' }
      : { severity: 'info', title: 'Live slots need --metrics',
        detail: 'This llama-server build can sleep, and reading its slots without /metrics would wake it. Start llama-server with --metrics to see slots and throughput.' };
    case 'sleeping': return { severity: 'info', title: 'llama-server is asleep',
      detail: 'It unloads the model while idle and wakes on the next request. Scope doesn’t read its slots while it sleeps, so it stays asleep.' };
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
  body: 'GPU, thermal and process readings for this Mac, and the LM Studio command line without ever starting it. Per-chat labels use only the open chat’s activity, which needs no extra permission. Reply history stays on this Mac.',
  steps: ['Open Settings → Extensions → MLX Scope.', 'Choose Review permissions, then approve.'],
  grant: [
    ['GPU readings', '/usr/sbin/ioreg'], ['Thermal pressure', '/usr/bin/notifyutil'], ['oMLX process memory', '/usr/sbin/lsof, /usr/bin/footprint'],
    ['LM Studio and Bionic', '~/.lmstudio/bin/lms, ~/.cache/lm-studio/bin/lms', 'never starts either app'],
    ['Chip power (optional)', '/opt/homebrew/bin/macmon, /usr/local/bin/macmon', 'only if you installed macmon'],
    // By name: the panel bundle never carries the service's own exec paths (scripts/verify-package.ts leak check).
    ['Memory (as in 1.x)', 'vm_stat, sysctl', 'the two commands 1.x already ran'],
  ] as ReadonlyArray<readonly [string, string, string?]>,
  note: 'Nothing is read until you approve. Your saved 1.6 captures are kept. No sudo, osascript or powermetrics.',
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
export const TIP_INFO = 'Hiding Turn stats hides it for every chat, including cloud chats, where MLX Scope shows only “Chat uses a non-local model”.';
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

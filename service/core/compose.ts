import type { AlertLogEntryV2, AlertV2 } from '../../src/contract/alerts.ts';
import { capabilityScope, type Capabilities, type CapabilityKey } from '../../src/contract/capabilities.ts';
import type { CompletionsV2 } from '../../src/contract/completion.ts';
import type { HostV2 } from '../../src/contract/host.ts';
import type { SnapshotQuery } from '../../src/contract/query.ts';
import { parseParams, STATUS_PARAMS } from '../../src/contract/reasons.ts';
import { parseSnapshotV2, requiredCapabilities, type LeaseV2, type SnapshotV2 } from '../../src/contract/snapshot.ts';
import { CONTRACT_VERSION } from '../../src/contract/version.ts';
import { busy, type RuntimeReading } from '../runtime-client.ts';
import type { LeaseView } from './lease.ts';
import { nextPollMs } from './scheduler.ts';

export interface ComposeInput {
  reading: RuntimeReading;
  host: HostV2 | null;
  completions: CompletionsV2;
  alerts: { alerts: AlertV2[]; alertLog: AlertLogEntryV2[] };
  service: { version: string; instance: string };
  serverNow: number;
  lease: LeaseView;
  marksHead: number;
  query: Pick<SnapshotQuery, 'surface'>;
}

/**
 * What the host reading can report: the CPU and memory card whenever there is a reading (1.6 showed it), each other part
 * when present. Only macmon power is an estimate. svc-host may declare these itself; absent parts claim nothing (P3).
 */
export const hostCapabilities = (host: HostV2 | null): Capabilities => {
  if (!host) return {};
  const keys = new Set<CapabilityKey>(['host.cpu', 'host.memory', ...host.mac ? ['host.swap' as const] : [], ...requiredCapabilities({ host })]);
  return Object.fromEntries([...keys].map(key => [key, { scope: capabilityScope(key), basis: key === 'host.power' ? 'estimate' : 'reported' }]));
};

/**
 * The `/v2/snapshot` body: the adapter reading, the host, the slot's completions and the service's own state (identity,
 * lease, cadence, marks, alerts). Nothing is spread from the reading, so bridge fields and service-only meta never reach the
 * wire, and the parser then withholds any value its capability does not cover. A body that breaks the contract throws.
 */
export const composeSnapshot = ({ reading, host, completions, alerts, service, serverNow, lease, marksHead, query }: ComposeInput): SnapshotV2 => {
  const { yielded, ...wireLease } = lease, meta = reading.meta, { status } = reading;
  const capabilities: Capabilities = { ...hostCapabilities(host), ...reading.capabilities };
  // Completions came through this pipeline, so it can report them; each item keeps its own basis.
  const last = completions.items.at(-1);
  if (last && !capabilities['server.completions']) capabilities['server.completions'] = { scope: 'server', basis: last.basis };
  const body: SnapshotV2 = {
    // Params are allowlisted before the whole-body class A check, so a stray adapter param is dropped, not a failed poll.
    contractVersion: CONTRACT_VERSION, serverNow, service, connection: meta.connection, capabilities,
    status: { ...status, params: status.reason ? parseParams(status.params, STATUS_PARAMS[status.reason]) : {} },
    runtime: { ...reading.runtime, sampledAt: reading.at }, host, completions: { ...completions, instance: service.instance }, marksHead,
    alerts: alerts.alerts, alertLog: alerts.alertLog, lease: wireLease satisfies LeaseV2,
    nextPollMs: nextPollMs({ surface: query.surface, active: busy(reading.runtime), idleMs: meta.idleMs, failures: meta.failures, hostLive: host !== null, yielded }),
    compat: meta.compat,
  };
  const snapshot = parseSnapshotV2(JSON.parse(JSON.stringify(body)));
  if (!snapshot) throw new TypeError('The reading could not form a v2 snapshot.');
  return snapshot;
};

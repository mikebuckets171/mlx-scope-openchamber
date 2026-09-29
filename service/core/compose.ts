import { toSnapshotV2 } from '../../src/contract/convert-v1.ts';
import type { SnapshotQuery } from '../../src/contract/query.ts';
import type { LeaseV2, SnapshotV2 } from '../../src/contract/snapshot.ts';
import type { SystemSnapshot } from '../../src/system.ts';
import { busy, type RuntimeReading } from '../runtime-client.ts';
import type { LeaseView } from './lease.ts';
import { nextPollMs } from './scheduler.ts';
import type { VerdictV2 } from './verdicts.ts';

export interface ComposeInput {
  reading: RuntimeReading;
  system: SystemSnapshot | null;
  service: { version: string; instance: string };
  serverNow: number;
  lease: LeaseView;
  marksHead: number;
  verdict: (seq: number) => VerdictV2 | undefined;
  query: Pick<SnapshotQuery, 'surface' | 'since'>;
}

/**
 * The `/v2/snapshot` body: the 1.x reading through the 2a bridge, plus what only the service knows (identity, lease,
 * cadence, turn marks and verdicts). The converter validates it, so a body that breaks the contract never leaves.
 */
export const composeSnapshot = ({ reading: { snapshot: reading, meta }, system, service, serverNow, lease, marksHead, verdict, query }: ComposeInput): SnapshotV2 => {
  const { yielded, ...wireLease } = lease;
  const pollMs = nextPollMs({ surface: query.surface, active: busy(reading), idleMs: meta.idleMs,
    failures: meta.failures, hostLive: system !== null, yielded });
  const snapshot = toSnapshotV2({ ...reading, system }, { service, serverNow, generation: meta.generation, detection: meta.detection,
    completionSeq: meta.completionSeq ?? undefined, marksHead, lease: wireLease satisfies LeaseV2, nextPollMs: pollMs });
  const { completions } = snapshot, since = query.since;
  // Stage 2a has no completion ring: the only item is the runtime's own last request, when it reports one.
  completions.items = completions.items.filter(item => since === undefined || item.seq > since)
    .map(item => { const label = verdict(item.seq); return label ? { ...item, verdict: label } : item; });
  // A cursor past this ring's newest seq was not issued by it: an earlier service start, or another connection.
  if (since !== undefined && since > completions.cursor) completions.reset = true;
  return snapshot;
};

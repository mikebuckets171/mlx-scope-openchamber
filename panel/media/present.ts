import type { MediaJobV1, MediaSnapshotV1 } from '../../src/contract/media.ts';
import { mediaTerminal } from '../../src/contract/media.ts';
import { chatKey } from '../../src/contract/chat-key.ts';
import { dur } from '../present/format.ts';

export const PHASE_LABEL = { queued: 'Queued', waiting: 'Waiting', preparing: 'Preparing', rewriting: 'Rewriting', 'encoding-references': 'Encoding references', sampling: 'Sampling', decoding: 'Decoding', finishing: 'Finishing', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', unknown: 'Working' } as const;
export const mediaJobKey = (job: Pick<MediaJobV1, 'sourceId' | 'id'>): string => `${job.sourceId}/${job.id}`;
export const jobOwnership = (job: MediaJobV1, sessionId: string | null): string => job.ownership.sessionKey
  ? sessionId && job.ownership.sessionKey === chatKey('session', sessionId) ? 'This chat' : 'Other chat'
  : job.ownership.projectKey ? 'Project · chat unassigned' : 'Unassigned';
export const orderedMediaJobs = (snapshot: MediaSnapshotV1 | null, sessionId: string | null): MediaJobV1[] => [...snapshot?.jobs ?? []].sort((a, b) => {
  const priority = (job: MediaJobV1): number => (mediaTerminal(job.state) ? 4 : 0) + (jobOwnership(job, sessionId) === 'This chat' ? 0 : 1);
  return priority(a) - priority(b) || (b.queuedAtMs ?? b.observedAtMs) - (a.queuedAtMs ?? a.observedAtMs) || mediaJobKey(a).localeCompare(mediaJobKey(b));
});
/** A producer timestamp can be old during a long phase: only the service's freshness verdict, or a lost Scope response, invalidates it. */
export const mediaJobView = (job: MediaJobV1, now: number, lost: boolean, cancelling = false) => {
  const terminal = mediaTerminal(job.state), fresh = !lost && job.freshness === 'live', progress = fresh && !cancelling && job.state !== 'cancelling' ? job.progress : null;
  const phase = PHASE_LABEL[job.phase], status = cancelling || job.state === 'cancelling' ? 'Cancelling' : !terminal && !fresh ? job.freshness === 'unavailable' ? 'Telemetry unavailable' : 'Waiting for update' : PHASE_LABEL[job.state === 'running' ? job.phase : job.state];
  const start = job.startedAtMs ?? job.queuedAtMs, end = job.finishedAtMs ?? Math.min(now, job.sampledAtMs);
  const fraction = progress ? progress.value / progress.total : null;
  const percent = fraction === null ? null : `${Math.floor(fraction * 100)}%`;
  const counters = progress ? progress.unit === 'percent' ? percent! : `${progress.value} / ${progress.total} ${progress.unit}` : null;
  return { phase, status, fresh, terminal, progress, fraction, percent, counters,
    elapsed: start != null && end >= start ? dur(end - start) : null,
    canCancel: fresh && job.cancel.supported && !terminal && !cancelling && job.state !== 'cancelling',
    detail: !fresh && !terminal ? 'Last observation retained; no live progress is available.' : job.message ?? null };
};

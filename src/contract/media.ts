import { at, count, defined, label, nonneg, obj, oneOf } from './guards.ts';

export const MEDIA_STATES = ['queued', 'waiting', 'running', 'cancelling', 'completed', 'failed', 'cancelled'] as const;
export const MEDIA_PHASES = ['queued', 'waiting', 'preparing', 'rewriting', 'encoding-references', 'sampling', 'decoding', 'finishing', 'completed', 'failed', 'cancelled', 'unknown'] as const;
export const MEDIA_UNITS = ['steps', 'blocks', 'tiles', 'frames', 'units', 'percent'] as const;
export type MediaState = typeof MEDIA_STATES[number];
export type MediaPhase = typeof MEDIA_PHASES[number];
export type MediaProgressV1 = { value: number; total: number; unit: typeof MEDIA_UNITS[number]; basis: 'phase' };
export type MediaOwnershipV1 = { sessionKey?: string; projectKey?: string };
export interface MediaJobV1 {
  id: string;
  sourceId: string;
  kind: 'image' | 'video' | 'unknown';
  name: string;
  state: MediaState;
  phase: MediaPhase;
  /** Opaque node/phase identity where a backend can run the same phase more than once. */
  phaseKey?: string;
  /** Measured phase-local counters only. Null means indeterminate. */
  progress: MediaProgressV1 | null;
  /** An explicitly historical report for this same phase/node. Never a live reading. */
  lastProgress?: MediaProgressV1 | null;
  lastProgressAtMs?: number;
  /**
   * Finish-time estimate (Unix ms) for a live, running job whose source declares the current phase final or dominant.
   * Derived by the service from at least two producer-timestamped samples of this phase only; absent otherwise.
   */
  etaAtMs?: number;
  /** The held estimate for the same phase while the job is stale or unavailable. Explicitly historical, never live. */
  lastEtaAtMs?: number;
  /** Present only with `etaAtMs` or `lastEtaAtMs`. */
  etaBasis?: 'measured-window';
  /** Reading a file does not refresh its producer observation. */
  sampledAtMs: number;
  observedAtMs: number;
  progressAtMs?: number;
  queuedAtMs?: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  freshness: 'live' | 'stale' | 'last' | 'unavailable';
  ownership: MediaOwnershipV1;
  cancel: { supported: boolean };
  /** Allowlisted explanation, never backend error strings or prompts. */
  message?: string;
}
export interface MediaSourceV1 {
  id: string;
  kind: 'comfyui' | 'local-video' | 'qwen-image' | 'feed';
  label: string;
  state: 'ready' | 'disconnected' | 'unavailable' | 'unsupported';
  capabilities: { progress: boolean; cancel: boolean };
  message?: string;
}
export interface MediaSnapshotV1 {
  schemaVersion: 1;
  /** Explicit global preference. An empty discovery result is still enabled. */
  enabled?: boolean;
  sampledAtMs: number;
  nextPollMs: number;
  sources: MediaSourceV1[];
  jobs: MediaJobV1[];
}
export interface MediaCancelResultV1 {
  schemaVersion: 1;
  sourceId: string;
  jobId: string;
  status: 'requested' | 'unsupported' | 'not-found' | 'conflict' | 'failed';
}
export const MEDIA_JOB_LIMIT = 64;
export const MEDIA_SOURCE_LIMIT = 8;
/** A finish-time estimate further than this from its latest sample is not plausible enough to show. */
export const MEDIA_ETA_HORIZON_MS = 86_400_000;
export const mediaId = (value: unknown): string | null => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(value) ? value : null;
const hash = (value: unknown): string | undefined => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
export const mediaTerminal = (state: MediaState): boolean => state === 'completed' || state === 'failed' || state === 'cancelled';
export const withdrawMediaProgress = (job: MediaJobV1, freshness: 'stale' | 'unavailable'): MediaJobV1 => {
  const progress = job.state === 'running' ? job.progress ?? job.lastProgress : null;
  const observed = job.progress ? job.progressAtMs ?? job.observedAtMs : job.lastProgressAtMs;
  // A live estimate becomes the held estimate for the same report; it is never refreshed while withdrawn.
  const eta = progress ? job.progress ? job.etaAtMs : job.lastEtaAtMs : undefined;
  return { ...job, freshness, progress: null, cancel: { supported: false },
    lastProgress: progress ?? undefined, lastProgressAtMs: progress ? observed ?? job.observedAtMs : undefined,
    etaAtMs: undefined, lastEtaAtMs: eta, etaBasis: eta === undefined ? undefined : 'measured-window' };
};
export const parseMediaProgress = (raw: unknown): MediaProgressV1 | null => {
  const item = obj(raw), unit = oneOf(MEDIA_UNITS)(item?.unit), value = unit === 'percent' ? nonneg(item?.value) : count(item?.value), total = count(item?.total);
  return item?.basis === 'phase' && value !== null && total !== null && total > 0 && total <= 1_000_000 && value <= total && unit && (unit !== 'percent' || total === 100)
    ? { value, total, unit, basis: 'phase' } : null;
};
export const parseMediaJob = (raw: unknown): MediaJobV1 | null => {
  const item = obj(raw), id = mediaId(item?.id), sourceId = mediaId(item?.sourceId);
  const kind = oneOf(['image', 'video', 'unknown'] as const)(item?.kind), name = label(item?.name, 80);
  const state = oneOf(MEDIA_STATES)(item?.state), phase = oneOf(MEDIA_PHASES)(item?.phase);
  const sampledAtMs = at(item?.sampledAtMs), observedAtMs = at(item?.observedAtMs);
  const freshness = oneOf(['live', 'stale', 'last', 'unavailable'] as const)(item?.freshness);
  const ownership = obj(item?.ownership), cancel = obj(item?.cancel);
  if (!item || !id || !sourceId || !kind || !name || !state || !phase || sampledAtMs === null || observedAtMs === null || observedAtMs > sampledAtMs || !freshness
    || typeof cancel?.supported !== 'boolean' || (mediaTerminal(state) && freshness !== 'last') || (!mediaTerminal(state) && freshness === 'last')) return null;
  const optionalTime = (key: string): number | undefined => { const value = at(item[key]); return value !== null && value <= sampledAtMs ? value : undefined; };
  const progress = parseMediaProgress(item.progress);
  const lastAt = optionalTime('lastProgressAtMs');
  const lastProgress = state === 'running' && (freshness === 'stale' || freshness === 'unavailable') && lastAt !== undefined && lastAt <= observedAtMs
    ? parseMediaProgress(item.lastProgress) : null;
  const liveProgress = freshness === 'live' && state === 'running' ? progress : null, progressAtMs = optionalTime('progressAtMs');
  // An estimate needs its basis and the measured counters it was derived from; it cannot precede that report or run past the horizon.
  const estimate = (raw: unknown, from: number | undefined): number | undefined => {
    const value = at(raw);
    return item.etaBasis === 'measured-window' && value !== null && from !== undefined && value >= from && value <= from + MEDIA_ETA_HORIZON_MS ? value : undefined;
  };
  const etaAtMs = liveProgress ? estimate(item.etaAtMs, progressAtMs ?? observedAtMs) : undefined;
  const lastEtaAtMs = lastProgress ? estimate(item.lastEtaAtMs, lastAt) : undefined;
  return defined({ id, sourceId, kind, name, state, phase, phaseKey: hash(item.phaseKey), sampledAtMs, observedAtMs, freshness,
    progress: liveProgress,
    lastProgress: lastProgress ?? undefined, lastProgressAtMs: lastProgress ? lastAt : undefined,
    etaAtMs, lastEtaAtMs, etaBasis: etaAtMs !== undefined || lastEtaAtMs !== undefined ? 'measured-window' as const : undefined,
    progressAtMs, queuedAtMs: optionalTime('queuedAtMs'), startedAtMs: optionalTime('startedAtMs'), finishedAtMs: optionalTime('finishedAtMs'),
    ownership: defined({ sessionKey: hash(ownership?.sessionKey), projectKey: hash(ownership?.projectKey) }),
    cancel: { supported: cancel.supported && !mediaTerminal(state) && freshness === 'live' }, message: label(item.message, 120) ?? undefined });
};
export const parseMediaSnapshot = (raw: unknown): MediaSnapshotV1 | null => {
  const item = obj(raw), sampledAtMs = at(item?.sampledAtMs), nextPollMs = count(item?.nextPollMs);
  if (item?.schemaVersion !== 1 || sampledAtMs === null || nextPollMs === null || nextPollMs < 1_000 || nextPollMs > 60_000 || !Array.isArray(item.jobs) || !Array.isArray(item.sources)) return null;
  const sources: MediaSourceV1[] = [];
  for (const raw of item.sources.slice(0, MEDIA_SOURCE_LIMIT)) {
    const source = obj(raw), id = mediaId(source?.id), kind = oneOf(['comfyui', 'local-video', 'qwen-image', 'feed'] as const)(source?.kind);
    const state = oneOf(['ready', 'disconnected', 'unavailable', 'unsupported'] as const)(source?.state), name = label(source?.label, 80), capabilities = obj(source?.capabilities);
    if (id && kind && state && name && typeof capabilities?.progress === 'boolean' && typeof capabilities.cancel === 'boolean')
      sources.push(defined({ id, kind, state, label: name, capabilities: { progress: capabilities.progress, cancel: capabilities.cancel }, message: label(source?.message, 120) ?? undefined }));
  }
  const ids = new Set(sources.map(source => source.id));
  return { schemaVersion: 1, ...typeof item.enabled === 'boolean' ? { enabled: item.enabled } : {}, sampledAtMs, nextPollMs, sources, jobs: item.jobs.slice(0, MEDIA_JOB_LIMIT).map(parseMediaJob).filter((job): job is MediaJobV1 => !!job && ids.has(job.sourceId)) };
};

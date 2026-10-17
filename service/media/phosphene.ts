import { chatKey } from '../../src/contract/chat-key.ts';
import { count, defined, obj } from '../../src/contract/guards.ts';
import { MEDIA_ETA_HORIZON_MS, mediaId, mediaTerminal, parseMediaProgress, type MediaJobV1, type MediaPhase, type MediaSourceV1, type MediaState } from '../../src/contract/media.ts';
import { requestJSON } from '../http.ts';
import type { MediaAdapterOptions, MediaCollection } from './adapters.ts';
import type { MediaSourceConfig } from './discovery.ts';

// Phosphene (4.19) publishes its render queue at GET /status. Only the fields named here are read: the job ids, states,
// start and run times, the mode and engine names (to tell an image from a video), the phase, the step counters and
// Phosphene's own time-left estimate. Prompts, parameters, file paths, logs, previews and outputs are never kept.
// Observe-only: Scope has no route that starts, stops or changes a Phosphene job.

/** How often the queue is read while a job runs or waits, and while it is idle. */
export const PHOSPHENE_READ_MS = { active: 15_000, idle: 30_000 } as const;
/** A job last observed longer ago than 2.5 reads is stale. */
export const PHOSPHENE_STALE_MS = 37_500;
const STATUS_MAX_BYTES = 1_000_000, TERMINAL_LIMIT = 8, RETENTION_MS = 86_400_000;
const PHASES: Readonly<Record<string, MediaPhase>> = { setup: 'preparing', load: 'preparing', download: 'preparing', denoise: 'sampling', decode: 'decoding', post: 'finishing' };
const ENDED: Readonly<Record<string, MediaState>> = { done: 'completed', failed: 'failed', error: 'failed', cancelled: 'cancelled', stopped: 'cancelled' };
const ms = (seconds: unknown): number | undefined => typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
/** The medium, from the job's mode and engine names only: training and music are not image or video renders. */
const kindOf = (params: unknown): MediaJobV1['kind'] => {
  const item = obj(params), mode = typeof item?.mode === 'string' ? item.mode : '', engine = typeof item?.engine === 'string' ? item.engine : '';
  return engine === 'music' || mode === 'train' ? 'unknown' : mode === 'image' ? 'image' : mode ? 'video' : 'unknown';
};
const nameOf = (kind: MediaJobV1['kind'], id: string): string => `${kind === 'image' ? 'Image' : kind === 'video' ? 'Video' : 'Job'} ${id.slice(-8)}`;

export const phosphene = async (config: MediaSourceConfig, options: MediaAdapterOptions): Promise<MediaCollection> => {
  const body = (await requestJSON({ url: new URL('/status', config.origin), fetchImpl: options.fetchImpl, timeoutMs: 1800, maxBytes: STATUS_MAX_BYTES })).body;
  const now = options.now(), serverNow = ms(body?.server_now);
  if (!body || typeof body.running !== 'boolean' || typeof body.paused !== 'boolean' || !serverNow || !Array.isArray(body.queue) || !Array.isArray(body.history)) {
    throw new Error('Invalid Phosphene status');
  }
  // Phosphene runs on this Mac: its clock is ours, but a reading is never dated after it arrived.
  const observedAtMs = Math.min(now, serverNow), before = (value: number | undefined) => value === undefined ? undefined : Math.min(value, observedAtMs);
  const source: MediaSourceV1 = { id: config.id, kind: 'phosphene', label: config.label, state: 'ready', capabilities: { progress: false, cancel: false } };
  const jobs: MediaJobV1[] = [], reportedEta = new Map<string, number>();
  const job = (id: string, params: unknown, state: MediaState, phase: MediaPhase, extra: Partial<MediaJobV1> = {}): MediaJobV1 => {
    const kind = kindOf(params);
    return defined({ id, sourceId: config.id, kind, name: nameOf(kind, id), state, phase, progress: null, sampledAtMs: now, observedAtMs,
      freshness: mediaTerminal(state) ? 'last' as const : 'live' as const, ownership: {}, cancel: { supported: false }, ...extra });
  };
  const current = obj(body.current), currentId = mediaId(current?.id);
  if (current && currentId) {
    const progress = obj(current.progress), phase = typeof progress?.phase === 'string' ? progress.phase : '';
    const waiting = phase === 'waiting' || !!current.waiting_note;
    // Step counters exist only while denoising; an H3 clip denoises once per window, each its own phase.
    const counters = !waiting && phase === 'denoise'
      ? parseMediaProgress({ basis: 'phase', value: count(progress?.denoise_step), total: count(progress?.denoise_total), unit: 'steps' }) : null;
    const window = count(progress?.window), windows = count(progress?.window_total);
    jobs.push(job(currentId, current.params, waiting ? 'waiting' : 'running', waiting ? 'waiting' : PHASES[phase] ?? 'unknown', {
      progress: counters, phaseKey: counters && windows && windows > 1 && window ? chatKey('model', `${currentId}\0window ${window}`) : undefined,
      startedAtMs: before(ms(current.started_ts)), message: waiting ? 'Waiting for the GPU' : undefined }));
    const left = ms(progress?.remaining_sec);
    if (counters && left !== undefined && left <= MEDIA_ETA_HORIZON_MS) reportedEta.set(currentId, observedAtMs + left);
    source.capabilities.progress = !!counters;
  }
  for (const raw of body.queue.slice(0, 32)) {
    const item = obj(raw), id = mediaId(item?.id);
    if (item && id && id !== currentId) jobs.push(job(id, item.params, 'queued', 'queued', { message: body.paused ? 'Phosphene’s queue is paused' : undefined }));
  }
  let ended = 0;
  for (const raw of body.history.slice(0, 32)) {
    const item = obj(raw), id = mediaId(item?.id), state = ENDED[String(item?.status)];
    if (!item || !id || !state || ended >= TERMINAL_LIMIT || jobs.some(entry => entry.id === id)) continue;
    const started = before(ms(item.started_ts)), elapsed = ms(item.elapsed_sec);
    const finished = started !== undefined && elapsed !== undefined ? before(started + elapsed) : undefined;
    if (finished !== undefined && observedAtMs - finished > RETENTION_MS) continue;
    ended++;
    jobs.push(job(id, item.params, state, state as MediaPhase, { startedAtMs: started, finishedAtMs: finished, observedAtMs: finished ?? observedAtMs,
      message: state === 'failed' ? 'Generation failed. Check Phosphene.' : undefined }));
  }
  return { source, jobs, reportedEta, staleMs: PHOSPHENE_STALE_MS,
    ttlMs: jobs.some(entry => !mediaTerminal(entry.state)) ? PHOSPHENE_READ_MS.active : PHOSPHENE_READ_MS.idle };
};

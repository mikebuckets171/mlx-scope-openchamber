import { join } from 'node:path';
import { chatKey } from '../../src/contract/chat-key.ts';
import { at, obj, label, oneOf, defined } from '../../src/contract/guards.ts';
import { MEDIA_PHASES, mediaId, mediaTerminal, parseMediaJob, parseMediaProgress, withdrawMediaProgress, type MediaJobV1, type MediaPhase, type MediaSourceV1, type MediaState } from '../../src/contract/media.ts';
import { requestJSON, type FetchImplementation } from '../http.ts';
import type { MediaSourceConfig } from './discovery.ts';
import { directoryExists, directoryStamp, jsonFiles, readBounded } from './files.ts';

export interface MediaCollection { source: MediaSourceV1; jobs: MediaJobV1[]; correlations?: Map<string, string> }
export interface VideoHistory { stamp: string; until: number; jobs: MediaJobV1[]; active: Set<string> }
export interface MediaAdapterOptions { now: () => number; fetchImpl: FetchImplementation; cancelLocalVideo?: (id: string) => Promise<boolean>; localVideoDirectory?: string; videoHistory?: Map<string, VideoHistory> }
const STALE_MS = 15_000;
const RETENTION_MS = 86_400_000;
export const timestamp = (raw: unknown): number | undefined => {
  const value = typeof raw === 'string' ? Date.parse(raw) : at(raw);
  return value !== null && Number.isFinite(value) && value >= 0 ? value : undefined;
};
const time = (raw: unknown, now: number): number | undefined => { const value = timestamp(raw); return value !== undefined && value <= now ? value : undefined; };
const phaseOf = (raw: unknown): MediaPhase => {
  const name = typeof raw === 'string' ? raw.toLowerCase().replaceAll('_', '-').replaceAll(' ', '-') : '';
  return oneOf(MEDIA_PHASES)(name) ?? ({ denoise: 'sampling', 'vae-decode': 'decoding', encode: 'encoding-references', 'reference-encoding': 'encoding-references', generate: 'sampling', working: 'unknown' } as Record<string, MediaPhase>)[name] ?? 'unknown';
};
const sourceOf = (config: MediaSourceConfig): MediaSourceV1 => ({ id: config.id, kind: config.kind, label: config.label, state: 'ready', capabilities: { progress: false, cancel: false } });
const ownershipOf = (session: unknown): MediaJobV1['ownership'] => typeof session === 'string' && session.length > 0 && session.length <= 512 ? { sessionKey: chatKey('session', session) } : {};
const progressFrom = (raw: unknown): MediaJobV1['progress'] => {
  const item = obj(raw);
  if (!item) return null;
  return parseMediaProgress({ basis: 'phase', value: item.completed_units ?? item.step ?? item.value, total: item.total_units ?? item.total,
    unit: item.unit ?? 'units' }) ?? parseMediaProgress({ basis: 'phase', value: item.percent, total: 100, unit: 'percent' });
};
const freshJob = (job: MediaJobV1, now: number): MediaJobV1 => {
  const terminal = mediaTerminal(job.state), fresh = now - job.observedAtMs <= STALE_MS;
  if (!terminal && !fresh) return withdrawMediaProgress(job, 'stale');
  return { ...job, freshness: terminal ? 'last' : 'live', progress: job.state === 'running' ? job.progress : null,
    lastProgress: undefined, lastProgressAtMs: undefined,
    cancel: { supported: !terminal && fresh && job.cancel.supported } };
};
const safePhase = (state: MediaState, phase: unknown): MediaPhase => mediaTerminal(state) ? state as 'completed' | 'failed' | 'cancelled' : state === 'queued' ? 'queued' : state === 'waiting' ? 'waiting' : phaseOf(phase);

export const localVideo = async (config: MediaSourceConfig, options: MediaAdapterOptions): Promise<MediaCollection> => {
  const now = options.now(), source = sourceOf(config), jobs: MediaJobV1[] = [];
  if (!await directoryExists(config.directory!)) throw new Error('Queue unavailable');
  source.capabilities.cancel = !!options.cancelLocalVideo && options.localVideoDirectory === config.directory;
  const historyKey = `${config.id}\0${config.directory}`, previous = options.videoHistory?.get(historyKey);
  const stamp = (await Promise.all(['done','failed','cancelled'].map(bucket => directoryStamp(join(config.directory!, bucket))))).join('|');
  let useHistory = !!previous && previous.stamp === stamp && now < previous.until;
  for (const bucket of ['running', 'pending', 'done', 'failed', 'cancelled']) {
    if (bucket === 'done' && previous?.active.size) {
      const active = new Set(jobs.map(job => job.id));
      if ([...previous.active].some(id => !active.has(id))) useHistory = false;
    }
    if (useHistory && ['done','failed','cancelled'].includes(bucket)) continue;
    const files = await jsonFiles(join(config.directory!, bucket), 128);
    for (const name of files.sort().reverse().slice(0, 32)) {
      const file = await readBounded(join(config.directory!, bucket, name), 256_000);
      if (!file) continue;
      let record; try { record = obj(JSON.parse(file.text)); } catch { continue; }
      const id = mediaId(record?.id);
      if (!record || !id || name !== `${id}.json`) continue;
      const state: MediaState = bucket === 'pending' ? 'queued' : bucket === 'done' ? 'completed' : bucket === 'running' ? record.waiting_reason ? 'waiting' : 'running' : bucket as 'failed' | 'cancelled';
      const progress = obj(record.progress), observed = time(progress?.observed_at, now) ?? Math.min(file.modifiedAtMs, now), finished = time(record.finished_at, now);
      if (mediaTerminal(state) && now - (finished ?? observed) > RETENTION_MS) continue;
      const reason = record.waiting_reason;
      const message = state === 'waiting' ? typeof reason === 'string' && /chat|llm|handoff/i.test(reason) ? 'Waiting for chat handoff' : 'Waiting for the GPU' : state === 'failed' ? 'Generation failed. Check the source application.' : undefined;
      const job = freshJob(defined({ id, sourceId: config.id, kind: 'video' as const,
        // Producer names may be prompts; use a stable neutral name and short queue identifier.
        name: `Video ${id.slice(-8)}`, state, phase: safePhase(state, progress?.phase), progress: progressFrom(progress), sampledAtMs: now, observedAtMs: observed,
        progressAtMs: time(progress?.observed_at, now), queuedAtMs: time(record.queued_at, now), startedAtMs: time(record.started_at, now), finishedAtMs: finished,
        freshness: 'live' as const, ownership: ownershipOf(record.session_id), cancel: { supported: source.capabilities.cancel }, message }), now);
      source.capabilities.progress ||= !!job.progress;
      jobs.push(job);
    }
  }
  const active = new Set(jobs.filter(job => !mediaTerminal(job.state)).map(job => job.id));
  if (useHistory) jobs.push(...previous!.jobs.filter(job => now - (job.finishedAtMs ?? job.observedAtMs) <= RETENTION_MS));
  options.videoHistory?.set(historyKey, { stamp, until: useHistory ? previous!.until : now + 30_000,
    jobs: jobs.filter(job => mediaTerminal(job.state)).slice(0, 96), active });
  return { source, jobs };
};

export const privateToken = async (path: string | undefined): Promise<string | null> => {
  if (!path) return null;
  const file = await readBounded(path, 4096, true), token = file?.text.trim();
  return token && token.length >= 16 && !/[\s\u0000-\u001f]/.test(token) ? token : null;
};
const headers = async (path: string | undefined): Promise<Record<string, string>> => {
  const token = await privateToken(path); if (path && !token) throw new Error('Credential unavailable');
  return token ? { Authorization: `Bearer ${token}` } : {};
};
const get = async (config: MediaSourceConfig, route: string, options: MediaAdapterOptions, helper = false): Promise<Record<string, unknown>> => {
  const auth = await headers(helper ? config.helperTokenPath : config.tokenPath);
  const result = await requestJSON({ url: new URL(route, config.origin), init: { headers: auth }, fetchImpl: options.fetchImpl, timeoutMs: 1800 });
  if (!result.body) throw new Error('Invalid media response'); return result.body;
};
const comfyState = (raw: unknown): MediaState | null => ({ pending: 'queued', in_progress: 'running', completed: 'completed', failed: 'failed', cancelled: 'cancelled' } as Record<string, MediaState>)[String(raw)] ?? null;
export const comfyUI = async (config: MediaSourceConfig, options: MediaAdapterOptions): Promise<MediaCollection> => {
  let now = options.now();
  const source = sourceOf(config), jobs: MediaJobV1[] = [];
  if (!config.version) { const stats = await get(config, '/system_stats', options); config.version = label(obj(stats.system)?.comfyui_version, 40) ?? undefined; }
  let rows: unknown[] = [], basic = true;
  try { const body = await get(config, '/api/jobs?limit=32&sort_order=desc', options); if (!Array.isArray(body.jobs)) throw new Error('Invalid jobs'); rows = body.jobs.slice(0, 32); }
  catch {
    basic = false;
    const queue = await get(config, '/queue', options);
    for (const [key, state] of [['queue_running', 'in_progress'], ['queue_pending', 'pending']] as const)
      for (const item of Array.isArray(queue[key]) ? queue[key].slice(0, 32) : []) if (Array.isArray(item)) rows.push({ id: item[1], status: state });
  }
  now = options.now();
  source.capabilities.cancel = config.version === '0.38.0' && basic;
  for (const raw of rows) {
    const item = obj(raw), id = mediaId(item?.id), state = comfyState(item?.status);
    if (!item || !id || !state) continue;
    const finished = time(item.execution_end_time, now), queued = time(item.create_time, now);
    if (mediaTerminal(state) && finished !== undefined && now - finished > RETENTION_MS) continue;
    jobs.push(defined({ id, sourceId: config.id, kind: 'unknown' as const, name: `ComfyUI job ${id.slice(0, 8)}`, state, phase: safePhase(state, null),
      progress: null, sampledAtMs: now, observedAtMs: now, queuedAtMs: queued, startedAtMs: time(item.execution_start_time, now), finishedAtMs: finished,
      freshness: mediaTerminal(state) ? 'last' as const : 'live' as const, ownership: {}, cancel: { supported: source.capabilities.cancel && !mediaTerminal(state) },
      message: state === 'failed' ? 'Generation failed. Check ComfyUI.' : undefined }));
  }
  if (config.helperTokenPath) {
    try {
      const helper = await get(config, '/mlx-scope/v1/progress', options, true);
      now = options.now();
      const observed = time(helper.observedAtMs, now);
      if (helper.schemaVersion === 1 && helper.helperVersion === '1.0.0' && helper.comfyVersion === '0.38.0' && helper.supported === true && observed !== undefined && now - observed <= STALE_MS && Array.isArray(helper.jobs)) {
        source.capabilities.progress = true;
        const nodes = helper.jobs.slice(0, 16).map(obj).filter((item): item is Record<string, unknown> => item !== null);
        for (const job of jobs.filter(job => job.state === 'running')) {
          const matches = nodes.filter(item => item.promptId === job.id);
          // Parallel graph branches have no single truthful phase-local percentage.
          if (matches.length !== 1) continue;
          const item = matches[0]!;
          const counters = obj(item.progress);
          job.phase = phaseOf(item.phase); job.progressAtMs = time(item.progressChangedAtMs, now);
          if (typeof item.nodeId === 'string' && item.nodeId.length <= 128) job.phaseKey = chatKey('model', `${job.id}\0${item.nodeId}`);
          // The registry's untouched default 0/1 is not measured progress.
          job.progress = counters?.value === 0 && counters.total === 1 ? null : parseMediaProgress({ ...counters, basis: 'phase' });
          job.observedAtMs = observed; job.sampledAtMs = now;
        }
      }
    } catch { /* Basic lifecycle monitoring continues when the optional helper is absent. */ }
  }
  return { source, jobs };
};

export const qwenImage = async (config: MediaSourceConfig, options: MediaAdapterOptions): Promise<MediaCollection> => {
  const source = sourceOf(config), body = await get(config, '/mlx-scope/v1/media', options), now = options.now(), jobs: MediaJobV1[] = [], correlations = new Map<string, string>();
  const observed = time(body.observedAtMs, now);
  if (body.schemaVersion !== 1 || body.producer !== 'qwen-image' || !Array.isArray(body.jobs) || observed === undefined) throw new Error('Unsupported Qwen telemetry');
  for (const raw of body.jobs.slice(0, 32)) {
    const item = obj(raw), id = mediaId(item?.jobId), state = oneOf(['queued', 'waiting', 'running', 'cancelling', 'completed', 'failed', 'cancelled'] as const)(item?.state);
    if (!item || !id || !state) continue;
    const updated = time(item.updatedAtMs, now), terminal = mediaTerminal(state);
    if (terminal && updated !== undefined && now - updated > RETENTION_MS) continue;
    const job = freshJob(defined({ id, sourceId: config.id, kind: 'image' as const, name: `Image ${id.slice(-8)}`, state, phase: safePhase(state, item.phase), progress: null,
      sampledAtMs: now, observedAtMs: observed, progressAtMs: updated, queuedAtMs: time(item.createdAtMs, now), startedAtMs: time(item.startedAtMs, now), finishedAtMs: terminal ? updated : undefined,
      freshness: 'live' as const, ownership: ownershipOf(item.sessionId), cancel: { supported: item.canCancel === true },
      message: item.cancellationUnconfirmed === true ? 'Cancellation has not been confirmed by the source.' : state === 'waiting'
        ? item.waitingReason === 'chat-handoff' ? 'Waiting for chat handoff' : item.waitingReason === 'memory' ? 'Waiting for memory' : 'Waiting for the GPU' : undefined }), now);
    if (mediaId(item.promptId)) correlations.set(id, item.promptId as string);
    source.capabilities.cancel ||= job.cancel.supported;
    jobs.push(job);
  }
  return { source, jobs, correlations };
};

export const localFeed = async (config: MediaSourceConfig, options: MediaAdapterOptions): Promise<MediaCollection> => {
  const now = options.now(), source = sourceOf(config), jobs: MediaJobV1[] = [];
  if (!await directoryExists(config.directory!)) throw new Error('Feed unavailable');
  for (const name of (await jsonFiles(config.directory!, 32)).slice(0, 16)) {
    const file = await readBounded(join(config.directory!, name), 64_000, true);
    if (!file) continue;
    let body; try { body = obj(JSON.parse(file.text)); } catch { continue; }
    const observed = time(body?.observedAtMs, now), expiry = timestamp(body?.expiresAtMs);
    if (!body || body.schemaVersion !== 1 || !Array.isArray(body.jobs) || observed === undefined || expiry === undefined || expiry <= now || expiry > observed + 60_000) continue;
    for (const raw of body.jobs.slice(0, 32)) {
      const item = obj(raw); if (!item) continue;
      const stale = !mediaTerminal(item.state as MediaState) && now - observed > STALE_MS;
      const job = parseMediaJob({ ...item, sourceId: config.id, name: item.kind === 'video' ? 'Video generation' : item.kind === 'image' ? 'Image generation' : 'Media generation', sampledAtMs: now,
        ...stale && item.state === 'running' ? {lastProgress:parseMediaProgress(item.progress) ?? item.lastProgress,lastProgressAtMs:time(item.progressAtMs,observed) ?? observed} : {},
        observedAtMs: observed, freshness: mediaTerminal(item.state as MediaState) ? 'last' : now - observed <= STALE_MS ? 'live' : 'stale', cancel: { supported: false } });
      if (job) { source.capabilities.progress ||= !!job.progress; jobs.push(job); }
    }
  }
  return { source, jobs };
};

export const collectMedia = (config: MediaSourceConfig, options: MediaAdapterOptions): Promise<MediaCollection> =>
  config.kind === 'comfyui' ? comfyUI(config, options) : config.kind === 'local-video' ? localVideo(config, options) : config.kind === 'qwen-image' ? qwenImage(config, options) : localFeed(config, options);

export const cancelMedia = async (config: MediaSourceConfig, id: string, options: MediaAdapterOptions): Promise<boolean> => {
  if (config.kind === 'local-video') return config.directory === options.localVideoDirectory && await options.cancelLocalVideo?.(id) || false;
  if (config.kind !== 'comfyui' && config.kind !== 'qwen-image') return false;
  const route = config.kind === 'comfyui' ? `/api/jobs/${encodeURIComponent(id)}/cancel` : `/mlx-scope/v1/media/${encodeURIComponent(id)}/cancel`;
  const auth = await headers(config.tokenPath);
  // Qwen's handler may acknowledge a request with202; its scoped job event remains the cancellation owner.
  let response: Response | null = null;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 1800);
  try {
    response = await options.fetchImpl(new URL(route, config.origin), { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}', redirect: 'manual', signal: controller.signal });
    if (response.status !== 200 && response.status !== 202) return false;
    if (response.url && response.url !== new URL(route, config.origin).toString()) return false;
    const reader = response.body?.getReader(); let size = 0, text = '';
    if (reader) while (true) { const result = await reader.read(); if (result.done) break; size += result.value.length; if (size > 4096) { await reader.cancel(); return false; } text += new TextDecoder().decode(result.value); }
    const body = obj(JSON.parse(text)); return config.kind === 'comfyui' ? body?.cancelled === true : body?.status === 'cancelling' || body?.state === 'cancelling' || body?.cancelled === true;
  } finally { clearTimeout(timer); controller.abort(); }
};

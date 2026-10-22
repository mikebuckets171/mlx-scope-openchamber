import { chatKey } from '../../src/contract/chat-key.ts';
import { at, obj, label, oneOf, defined } from '../../src/contract/guards.ts';
import { MEDIA_PHASES, mediaId, mediaTerminal, parseMediaProgress, type MediaJobV1, type MediaPhase, type MediaSourceV1, type MediaState } from '../../src/contract/media.ts';
import { requestJSON, type FetchImplementation } from '../http.ts';
import type { MediaSourceConfig } from './discovery.ts';
import { readBounded } from './files.ts';
import { drawThings } from './draw-things.ts';
import type { Exec } from '../lib/argv.ts';

export interface MediaCollection {
  source: MediaSourceV1; jobs: MediaJobV1[];
  /** How long this collection is reused, and after how long a job it holds is stale; defaults 1.8 s and 15 s. */
  ttlMs?: number;
  staleMs?: number;
}
export interface MediaAdapterOptions { now: () => number; fetchImpl: FetchImplementation; exec?: Exec }
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
const safePhase = (state: MediaState, phase: unknown): MediaPhase => mediaTerminal(state) ? state as 'completed' | 'failed' | 'cancelled' : state === 'queued' ? 'queued' : state === 'waiting' ? 'waiting' : phaseOf(phase);

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

export const collectMedia = (config: MediaSourceConfig, options: MediaAdapterOptions): Promise<MediaCollection> =>
  config.kind === 'draw-things' ? drawThings(config, options) : comfyUI(config, options);

export const cancelMedia = async (config: MediaSourceConfig, id: string, options: MediaAdapterOptions): Promise<boolean> => {
  if (config.kind !== 'comfyui') return false;
  const route = `/api/jobs/${encodeURIComponent(id)}/cancel`;
  const auth = await headers(config.tokenPath);
  let response: Response | null = null;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 1800);
  try {
    response = await options.fetchImpl(new URL(route, config.origin), { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}', redirect: 'manual', signal: controller.signal });
    if (response.status !== 200 && response.status !== 202) return false;
    if (response.url && response.url !== new URL(route, config.origin).toString()) return false;
    const reader = response.body?.getReader(); let size = 0, text = '';
    if (reader) while (true) { const result = await reader.read(); if (result.done) break; size += result.value.length; if (size > 4096) { await reader.cancel(); return false; } text += new TextDecoder().decode(result.value); }
    return obj(JSON.parse(text))?.cancelled === true;
  } finally { clearTimeout(timer); controller.abort(); }
};

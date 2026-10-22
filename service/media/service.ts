import { mediaTerminal, withdrawMediaProgress, MEDIA_JOB_LIMIT, type MediaCancelResultV1, type MediaJobV1, type MediaSnapshotV1 } from '../../src/contract/media.ts';
import { HttpFailure, type FetchImplementation } from '../http.ts';
import { cancelMedia, collectMedia, type MediaAdapterOptions, type MediaCollection } from './adapters.ts';
import { MediaDiscovery, type MediaSourceConfig } from './discovery.ts';
import { DRAW_THINGS_READ_MS } from './draw-things.ts';
import type { Exec } from '../lib/argv.ts';

interface SourceSlot { value?: MediaCollection; until: number; fingerprint: string; flight?: Promise<MediaCollection> }
/** View-driven only: no watcher, interval, worker, socket subscription or generation owner. */
export interface MediaServiceOptions {
  home: string;
  now?: () => number;
  fetchImpl?: FetchImplementation;
  env?: NodeJS.ProcessEnv;
  /** The allowlisted host probe (lsof) the Draw Things adapter reads running renders with. */
  exec?: Exec;
  /** Test seam. Production uses bounded, cached, read-only discovery. */
  configurations?: () => Promise<MediaSourceConfig[]>;
}
export class MediaService {
  private discovery: MediaDiscovery;
  private slots = new Map<string, SourceSlot>();
  private pending = new Map<string, number>();
  private cancels = new Map<string, Promise<MediaCancelResultV1>>();
  private progress = new Map<string, { key: string; at: number }>();
  private options: MediaAdapterOptions;
  private generation = 0;
  private snapshotFlight: Promise<MediaSnapshotV1> | null = null;
  private snapshotCache: { value: MediaSnapshotV1; until: number } | null = null;
  constructor(private input: MediaServiceOptions) {
    this.options = { now: input.now ?? Date.now, fetchImpl: input.fetchImpl ?? fetch, exec: input.exec };
    this.discovery = new MediaDiscovery({ home: input.home, fetchImpl: this.options.fetchImpl, now: this.options.now, env: input.env, drawThings: input.exec !== undefined });
  }
  configurations(): Promise<MediaSourceConfig[]> { return this.input.configurations?.() ?? this.discovery.configurations(); }
  get enabled(): boolean { return this.discovery.enabled; }
  /**
   * Whether a local media job is running, from the last snapshot a visible view asked for. Never starts a collection:
   * without a snapshot from the last 15 s it is unknown (null).
   */
  runningNow(now = this.options.now()): boolean | null {
    const cached = this.snapshotCache?.value;
    if (!cached || now - cached.sampledAtMs > 15_000) return null;
    return cached.jobs.some(job => job.state === 'running' && job.freshness === 'live');
  }
  invalidate(enabled?: boolean): void { this.generation++; this.snapshotCache = null; this.discovery.invalidate(enabled); for (const slot of this.slots.values()) slot.until = 0; }
  private async read(config: MediaSourceConfig, fresh = false): Promise<MediaCollection> {
    const now = this.options.now();
    const fingerprint = JSON.stringify([config.kind, config.origin, config.directory, config.tokenPath, config.helperTokenPath]);
    let slot = this.slots.get(config.id);
    if (!slot || slot.fingerprint !== fingerprint) {
      slot = { until: 0, fingerprint }; this.slots.set(config.id, slot);
      for (const key of this.progress.keys()) if (key.startsWith(`${config.id}/`)) this.progress.delete(key);
    }
    if (slot.flight) return slot.flight;
    if (!fresh && slot.value && now < slot.until) return slot.value;
    const current = slot;
    current.flight = collectMedia(config, this.options).catch((error): MediaCollection => ({
      source: { id: config.id, kind: config.kind, label: config.label,
        state: 'disconnected', capabilities: { progress: false, cancel: false },
        message: 'Source unavailable. Open its application or check Connections.' },
      jobs: (current.value?.jobs ?? []).map(job => mediaTerminal(job.state) ? job : withdrawMediaProgress(job, 'unavailable')),
      ...config.kind === 'draw-things' ? { ttlMs: DRAW_THINGS_READ_MS.idle, staleMs: current.value?.staleMs } : {},
    })).then(value => { current.value = value; current.until = this.options.now() + (value.ttlMs ?? 1800); return value; }).finally(() => { delete current.flight; });
    return current.flight;
  }
  snapshot(): Promise<MediaSnapshotV1> {
    if (this.snapshotFlight) return this.snapshotFlight;
    if (this.snapshotCache && this.options.now() < this.snapshotCache.until) return Promise.resolve(this.snapshotCache.value);
    const generation = this.generation;
    const flight = this.compose().then(value => {
      if (generation !== this.generation) { this.snapshotFlight = null; return this.snapshot(); }
      const expiry = value.jobs.filter(job => job.freshness === 'live').map(job => job.observedAtMs + 15_000);
      this.snapshotCache = { value, until: Math.min(this.options.now() + 250, ...expiry) }; return value;
    }).finally(() => { if (this.snapshotFlight === flight) this.snapshotFlight = null; });
    this.snapshotFlight = flight; return this.snapshotFlight;
  }
  private async compose(): Promise<MediaSnapshotV1> {
    const configs = await this.configurations(), ids = new Set(configs.map(config => config.id));
    for (const id of this.slots.keys()) if (!ids.has(id)) this.slots.delete(id);
    const collections = await Promise.all(configs.map(config => this.read(config))), now = this.options.now();
    let jobs = collections.flatMap(collection => collection.jobs.map(job => ({ ...job, sampledAtMs: now, cancel: { ...job.cancel } })));
    const staleAfter = new Map(collections.map(collection => [collection.source.id, collection.staleMs ?? 15_000]));
    for (const job of jobs) {
      const key = `${job.sourceId}/${job.id}`, progressKey = JSON.stringify([job.phase, job.phaseKey, job.progress]);
      if (job.progress && job.freshness === 'live') {
        // A producer timestamp can be old during a long phase: only the freshness verdict invalidates the report.
        const previous = this.progress.get(key);
        if (!previous || previous.key !== progressKey) this.progress.set(key, { key: progressKey, at: job.observedAtMs });
        job.progressAtMs ??= this.progress.get(key)?.at;
      }
      if (mediaTerminal(job.state)) this.pending.delete(key);
      const requested = this.pending.get(key);
      if (requested !== undefined && !mediaTerminal(job.state)) {
        job.state = 'cancelling'; job.cancel.supported = false;
        job.message = now - requested > 15_000 ? 'Cancellation has not been confirmed by the source.' : 'Waiting for cancellation acknowledgement';
      }
      if (!mediaTerminal(job.state) && now - job.observedAtMs > (staleAfter.get(job.sourceId) ?? 15_000)) Object.assign(job, withdrawMediaProgress(job, job.freshness === 'unavailable' ? 'unavailable' : 'stale'));
      if (job.state !== 'running') { job.progress = null; job.lastProgress = undefined; job.lastProgressAtMs = undefined; }
      if (job.state !== 'running' || job.freshness === 'live') { job.lastProgress = undefined; job.lastProgressAtMs = undefined; }
    }
    jobs.sort((a, b) => Number(mediaTerminal(a.state)) - Number(mediaTerminal(b.state)) || (b.finishedAtMs ?? b.queuedAtMs ?? b.observedAtMs) - (a.finishedAtMs ?? a.queuedAtMs ?? a.observedAtMs));
    jobs = jobs.slice(0, MEDIA_JOB_LIMIT);
    const keys = new Set(jobs.map(job => `${job.sourceId}/${job.id}`));
    for (const key of this.progress.keys()) if (!keys.has(key)) this.progress.delete(key);
    return { schemaVersion: 1, enabled: this.discovery.enabled, sampledAtMs: now, nextPollMs: collections.length === 0 ? 30_000 : jobs.some(job => !mediaTerminal(job.state)) ? 2000 : 5000, sources: collections.map(item => item.source), jobs };
  }
  cancel(sourceId: string, jobId: string): Promise<MediaCancelResultV1> {
    const key = `${sourceId}/${jobId}`, flight = this.cancels.get(key);
    if (flight) return flight;
    const work = this.doCancel(sourceId, jobId).finally(() => { this.cancels.delete(key); });
    this.cancels.set(key, work); return work;
  }
  private async doCancel(sourceId: string, jobId: string): Promise<MediaCancelResultV1> {
    const result = (status: MediaCancelResultV1['status']): MediaCancelResultV1 => ({ schemaVersion: 1, sourceId, jobId, status });
    const config = (await this.configurations()).find(source => source.id === sourceId);
    if (!config) return result('not-found');
    const key = `${sourceId}/${jobId}`;
    if (this.pending.has(key)) return result('requested');
    const latest = await this.read(config, true), job = latest.jobs.find(job => job.id === jobId);
    if (!job) return result('not-found');
    if (mediaTerminal(job.state) || job.freshness !== 'live' || this.options.now() - job.observedAtMs > 15_000) return result('conflict');
    if (!job.cancel.supported) return result('unsupported');
    try {
      if (!await cancelMedia(config, jobId, this.options)) return result('failed');
      this.pending.set(key, this.options.now()); this.slots.get(sourceId)!.until = 0; this.generation++; this.snapshotCache = null; return result('requested');
    } catch { return result('failed'); }
  }
}

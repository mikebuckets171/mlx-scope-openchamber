import { mediaTerminal, MEDIA_JOB_LIMIT, type MediaCancelResultV1, type MediaJobV1, type MediaSnapshotV1 } from '../../src/contract/media.ts';
import { HttpFailure, type FetchImplementation } from '../http.ts';
import { cancelMedia, collectMedia, type MediaAdapterOptions, type MediaCollection } from './adapters.ts';
import { MediaDiscovery, type MediaSourceConfig } from './discovery.ts';

interface SourceSlot { value?: MediaCollection; until: number; fingerprint: string; flight?: Promise<MediaCollection> }
export interface MediaServiceOptions {
  home: string;
  now?: () => number;
  fetchImpl?: FetchImplementation;
  env?: NodeJS.ProcessEnv;
  cancelLocalVideo?: (id: string) => Promise<boolean>;
  localVideoDirectory?: string;
  /** Test seam. Production uses bounded, cached, read-only discovery. */
  configurations?: () => Promise<MediaSourceConfig[]>;
}
/** View-driven only: no watcher, interval, worker, socket subscription or generation owner. */
export class MediaService {
  private discovery: MediaDiscovery;
  private slots = new Map<string, SourceSlot>();
  private pending = new Map<string, number>();
  private cancels = new Map<string, Promise<MediaCancelResultV1>>();
  private progress = new Map<string, { key: string; at: number }>();
  private options: MediaAdapterOptions;
  constructor(private input: MediaServiceOptions) {
    this.options = { now: input.now ?? Date.now, fetchImpl: input.fetchImpl ?? fetch, cancelLocalVideo: input.cancelLocalVideo, localVideoDirectory: input.localVideoDirectory };
    this.discovery = new MediaDiscovery({ home: input.home, fetchImpl: this.options.fetchImpl, now: this.options.now, env: input.env });
  }
  configurations(): Promise<MediaSourceConfig[]> { return this.input.configurations?.() ?? this.discovery.configurations(); }
  get enabled(): boolean { return this.discovery.enabled; }
  invalidate(enabled?: boolean): void { this.discovery.invalidate(enabled); for (const slot of this.slots.values()) slot.until = 0; }
  private async read(config: MediaSourceConfig, fresh = false): Promise<MediaCollection> {
    const now = this.options.now();
    const fingerprint = JSON.stringify([config.kind, config.origin, config.directory, config.tokenPath, config.helperTokenPath]);
    let slot = this.slots.get(config.id);
    if (!slot || slot.fingerprint !== fingerprint) {
      slot = { until: 0, fingerprint }; this.slots.set(config.id, slot);
      for (const map of [this.progress, this.pending]) for (const key of map.keys()) if (key.startsWith(`${config.id}/`)) map.delete(key);
    }
    if (slot.flight) return slot.flight;
    if (!fresh && slot.value && now < slot.until) return slot.value;
    const current = slot;
    current.flight = collectMedia(config, this.options).catch((error): MediaCollection => ({
      source: { id: config.id, kind: config.kind, label: config.label,
        state: config.kind === 'qwen-image' && error instanceof HttpFailure && error.status === 404 ? 'unsupported' : 'disconnected', capabilities: { progress: false, cancel: false },
        message: config.kind === 'qwen-image' && error instanceof HttpFailure && error.status === 404 ? 'This image workflow does not publish media progress yet.' : 'Source unavailable. Open its application or check Connections.' },
      jobs: (current.value?.jobs ?? []).map(job => mediaTerminal(job.state) ? job : { ...job, freshness: 'unavailable', progress: null, cancel: { supported: false } }),
    })).then(value => { current.value = value; current.until = this.options.now() + 1800; return value; }).finally(() => { delete current.flight; });
    return current.flight;
  }
  async snapshot(): Promise<MediaSnapshotV1> {
    const configs = await this.configurations(), ids = new Set(configs.map(config => config.id));
    for (const id of this.slots.keys()) if (!ids.has(id)) this.slots.delete(id);
    const collections = await Promise.all(configs.map(config => this.read(config))), now = this.options.now();
    let jobs = collections.flatMap(collection => collection.jobs.map(job => ({ ...job, sampledAtMs: now, cancel: { ...job.cancel } })));
    // A queue can atomically move a record between directories during a read. Completion wins that race.
    const unique = new Map<string, MediaJobV1>();
    for (const job of jobs) {
      const key = `${job.sourceId}/${job.id}`, previous = unique.get(key);
      if (!previous || mediaTerminal(job.state) && !mediaTerminal(previous.state) || mediaTerminal(job.state) === mediaTerminal(previous.state) && job.observedAtMs > previous.observedAtMs) unique.set(key, job);
    }
    jobs = [...unique.values()];
    // Ownership comes from the submitting bridge. Matching a prompt does not create a new job or duplicate it.
    for (const collection of collections) for (const [bridgeId, promptId] of collection.correlations ?? []) {
      const bridge = jobs.find(job => job.id === bridgeId && job.sourceId === collection.source.id);
      const matches = jobs.filter(job => job.id === promptId && collections.some(item => item.source.id === job.sourceId && item.source.kind === 'comfyui'));
      if (!bridge || matches.length !== 1) continue;
      const engine = matches[0]!;
      if (bridge.state === 'running' && engine.state === 'running' && engine.freshness === 'live') {
        bridge.progress = engine.progress; bridge.phase = engine.phase; bridge.phaseKey = engine.phaseKey; bridge.progressAtMs = engine.progressAtMs;
      }
      jobs = jobs.filter(job => job !== engine);
    }
    for (const job of jobs) {
      const key = `${job.sourceId}/${job.id}`, progressKey = JSON.stringify([job.phase, job.phaseKey, job.progress]);
      if (job.progress && job.freshness === 'live') {
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
      if (!mediaTerminal(job.state) && now - job.observedAtMs > 15_000) { job.freshness = 'stale'; job.progress = null; job.cancel.supported = false; }
    }
    jobs.sort((a, b) => Number(mediaTerminal(a.state)) - Number(mediaTerminal(b.state)) || (b.finishedAtMs ?? b.queuedAtMs ?? b.observedAtMs) - (a.finishedAtMs ?? a.queuedAtMs ?? a.observedAtMs));
    jobs = jobs.slice(0, MEDIA_JOB_LIMIT);
    const keys = new Set(jobs.map(job => `${job.sourceId}/${job.id}`));
    for (const map of [this.progress, this.pending]) for (const key of map.keys()) if (!keys.has(key)) map.delete(key);
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
      this.pending.set(key, this.options.now()); this.slots.get(sourceId)!.until = 0; return result('requested');
    } catch { return result('failed'); }
  }
}

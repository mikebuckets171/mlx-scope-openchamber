import { mediaTerminal, withdrawMediaProgress, MEDIA_ETA_HORIZON_MS, MEDIA_JOB_LIMIT, type MediaCancelResultV1, type MediaJobV1, type MediaProgressV1, type MediaSnapshotV1 } from '../../src/contract/media.ts';
import { HttpFailure, type FetchImplementation } from '../http.ts';
import { cancelMedia, collectMedia, type MediaAdapterOptions, type MediaCollection } from './adapters.ts';
import { MediaDiscovery, type MediaSourceConfig } from './discovery.ts';

interface SourceSlot { value?: MediaCollection; until: number; fingerprint: string; flight?: Promise<MediaCollection> }
interface RateSample { at: number; value: number }
/** Producer-timestamped samples of one phase identity, and the estimate last derived from them. */
interface RateWindow { identity: string; samples: RateSample[]; eta?: number }
/** Enough distinct reports to follow a changing rate; old ones fall out. */
export const RATE_SAMPLE_LIMIT = 8;
const phaseIdentity = (job: MediaJobV1, progress: MediaProgressV1): string => JSON.stringify([job.phase, job.phaseKey ?? null, progress.unit, progress.total]);
/**
 * A finish time from this phase's own measured rate: the first and latest distinct reports, which strictly increase in both
 * value and producer time. Undefined without two such samples, a positive rate, or a plausible horizon. The estimate never
 * precedes `reportedAt`, the producer time of the latest report: the job was still running then.
 */
export const measuredFinish = (samples: readonly RateSample[], total: number, reportedAt: number): number | undefined => {
  const first = samples[0], last = samples.at(-1);
  if (!first || !last || samples.length < 2 || last.at <= first.at || last.value <= first.value) return undefined;
  const rate = (last.value - first.value) / (last.at - first.at);
  if (!Number.isFinite(rate) || rate <= 0) return undefined;
  const eta = Math.max(Math.ceil(last.at + (total - last.value) / rate), reportedAt);
  return eta - last.at <= MEDIA_ETA_HORIZON_MS ? eta : undefined;
};
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
  private rates = new Map<string, RateWindow>();
  private options: MediaAdapterOptions;
  private generation = 0;
  private snapshotFlight: Promise<MediaSnapshotV1> | null = null;
  private snapshotCache: { value: MediaSnapshotV1; until: number } | null = null;
  constructor(private input: MediaServiceOptions) {
    this.options = { now: input.now ?? Date.now, fetchImpl: input.fetchImpl ?? fetch, cancelLocalVideo: input.cancelLocalVideo, localVideoDirectory: input.localVideoDirectory, videoHistory: new Map() };
    this.discovery = new MediaDiscovery({ home: input.home, fetchImpl: this.options.fetchImpl, now: this.options.now, env: input.env });
  }
  configurations(): Promise<MediaSourceConfig[]> { return this.input.configurations?.() ?? this.discovery.configurations(); }
  get enabled(): boolean { return this.discovery.enabled; }
  invalidate(enabled?: boolean): void { this.generation++; this.snapshotCache = null; this.options.videoHistory?.clear(); this.discovery.invalidate(enabled); for (const slot of this.slots.values()) slot.until = 0; }
  /**
   * Keeps this phase's rate window and sets a live or held estimate. Samples are the producer's own times for each distinct
   * value (adapter progress-change time, or the producer observation that first carried the value), never Scope's read time.
   * Any change of phase identity starts a new window, so an estimate is never stitched across phases.
   */
  private estimate(key: string, job: MediaJobV1, eligible: boolean): void {
    // Only this service measures an estimate; anything an adapter or producer supplied is discarded first.
    delete job.etaAtMs; delete job.lastEtaAtMs; delete job.etaBasis;
    const live = job.state === 'running' && job.freshness === 'live' ? job.progress : null;
    if (live && job.progressAtMs !== undefined) {
      const identity = phaseIdentity(job, live), sample = { at: job.progressAtMs, value: live.value };
      let window = this.rates.get(key);
      if (!window || window.identity !== identity) { window = { identity, samples: [] }; this.rates.set(key, window); }
      const last = window.samples.at(-1);
      if (!last) window.samples.push(sample);
      else if (sample.value > last.value && sample.at > last.at) { window.samples.push(sample); if (window.samples.length > RATE_SAMPLE_LIMIT) window.samples.shift(); }
      // A counter that runs backwards, or a later value without a later producer time, cannot be measured: start again.
      // A repeated value keeps the time it was first reported.
      else if (sample.value !== last.value) window.samples = [sample];
      window.eta = eligible ? measuredFinish(window.samples, live.total, job.progressAtMs) : undefined;
      if (window.eta !== undefined) { job.etaAtMs = window.eta; job.etaBasis = 'measured-window'; }
      return;
    }
    const window = this.rates.get(key), held = job.lastProgress;
    if (job.state === 'running' && (job.freshness === 'stale' || job.freshness === 'unavailable')) {
      // A held estimate belongs to the exact report the job retains; it is never extended while the job is not observed.
      if (held && window?.eta !== undefined && window.identity === phaseIdentity(job, held) && window.samples.at(-1)?.value === held.value
        && job.lastProgressAtMs !== undefined && window.eta >= job.lastProgressAtMs && window.eta - job.lastProgressAtMs <= MEDIA_ETA_HORIZON_MS) {
        job.lastEtaAtMs = window.eta; job.etaBasis = 'measured-window';
      }
      return;
    }
    // Indeterminate, paused, queued, cancelling or ended work: the measured window no longer describes this job.
    this.rates.delete(key);
  }
  private async read(config: MediaSourceConfig, fresh = false): Promise<MediaCollection> {
    const now = this.options.now();
    const fingerprint = JSON.stringify([config.kind, config.origin, config.directory, config.tokenPath, config.helperTokenPath]);
    let slot = this.slots.get(config.id);
    if (!slot || slot.fingerprint !== fingerprint) {
      slot = { until: 0, fingerprint }; this.slots.set(config.id, slot);
      for (const map of [this.progress, this.pending, this.rates]) for (const key of map.keys()) if (key.startsWith(`${config.id}/`)) map.delete(key);
    }
    if (slot.flight) return slot.flight;
    if (!fresh && slot.value && now < slot.until) return slot.value;
    const current = slot;
    current.flight = collectMedia(config, this.options).catch((error): MediaCollection => ({
      source: { id: config.id, kind: config.kind, label: config.label,
        state: config.kind === 'qwen-image' && error instanceof HttpFailure && error.status === 404 ? 'unsupported' : 'disconnected', capabilities: { progress: false, cancel: false },
        message: config.kind === 'qwen-image' && error instanceof HttpFailure && error.status === 404 ? 'This image workflow does not publish media progress yet.' : 'Source unavailable. Open its application or check Connections.' },
      jobs: (current.value?.jobs ?? []).map(job => mediaTerminal(job.state) ? job : withdrawMediaProgress(job, 'unavailable')),
    })).then(value => { current.value = value; current.until = this.options.now() + 1800; return value; }).finally(() => { delete current.flight; });
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
    this.snapshotFlight = flight; return flight;
  }
  private async compose(): Promise<MediaSnapshotV1> {
    const configs = await this.configurations(), ids = new Set(configs.map(config => config.id));
    for (const id of this.slots.keys()) if (!ids.has(id)) this.slots.delete(id);
    const historyKeys = new Set(configs.filter(config => config.kind === 'local-video').map(config => `${config.id}\0${config.directory}`));
    for (const key of this.options.videoHistory!.keys()) if (!historyKeys.has(key)) this.options.videoHistory!.delete(key);
    const collections = await Promise.all(configs.map(config => this.read(config))), now = this.options.now();
    let jobs = collections.flatMap(collection => collection.jobs.map(job => ({ ...job, sampledAtMs: now, cancel: { ...job.cancel } })));
    // Each adapter declares, per job, when its current phase is final or dominant. Nothing is inferred here.
    const eligible = new Set(collections.flatMap(collection => [...collection.finalPhase ?? []].map(id => `${collection.source.id}/${id}`)));
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
      if (bridge.state === 'running' && engine.state === 'running' && (bridge.phase === 'unknown' || bridge.phase === engine.phase)) {
        bridge.progress = engine.progress; bridge.phase = engine.phase; bridge.phaseKey = engine.phaseKey; bridge.progressAtMs = engine.progressAtMs;
        if (eligible.has(`${engine.sourceId}/${engine.id}`)) eligible.add(`${bridge.sourceId}/${bridge.id}`);
        if (engine.freshness === 'stale' || engine.freshness === 'unavailable') {
          bridge.freshness = engine.freshness; bridge.lastProgress = engine.lastProgress; bridge.lastProgressAtMs = engine.lastProgressAtMs; bridge.cancel.supported = false;
        }
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
      this.estimate(key, job, eligible.has(key));
      if (mediaTerminal(job.state)) this.pending.delete(key);
      const requested = this.pending.get(key);
      if (requested !== undefined && !mediaTerminal(job.state)) {
        job.state = 'cancelling'; job.cancel.supported = false;
        job.message = now - requested > 15_000 ? 'Cancellation has not been confirmed by the source.' : 'Waiting for cancellation acknowledgement';
      }
      if (!mediaTerminal(job.state) && now - job.observedAtMs > 15_000) Object.assign(job, withdrawMediaProgress(job, job.freshness === 'unavailable' ? 'unavailable' : 'stale'));
      if (job.state !== 'running') { job.progress = null; delete job.etaAtMs; }
      if (job.state !== 'running' || job.freshness === 'live') { job.lastProgress = undefined; job.lastProgressAtMs = undefined; delete job.lastEtaAtMs; }
      if (job.etaAtMs === undefined && job.lastEtaAtMs === undefined) delete job.etaBasis;
      for (const field of ['etaAtMs', 'lastEtaAtMs'] as const) if (job[field] === undefined) delete job[field];
    }
    jobs.sort((a, b) => Number(mediaTerminal(a.state)) - Number(mediaTerminal(b.state)) || (b.finishedAtMs ?? b.queuedAtMs ?? b.observedAtMs) - (a.finishedAtMs ?? a.queuedAtMs ?? a.observedAtMs));
    jobs = jobs.slice(0, MEDIA_JOB_LIMIT);
    const keys = new Set(jobs.map(job => `${job.sourceId}/${job.id}`));
    for (const map of [this.progress, this.pending, this.rates]) for (const key of map.keys()) if (!keys.has(key)) map.delete(key);
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

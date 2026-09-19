import type { HostClient } from '@openchamber/sdk';
import type { TelemetrySnapshot } from '../src/telemetry.ts';
import type { Capture } from './capture.ts';
import { capturedRate } from './capture.ts';

export const SAVED_LIMIT = 12;
export const SAVED_KEY = 'observation.v1.';
export const measurementLabels = {
  generation: ['Reported generation', 'tok/s'], recentOutput: ['Recent observed output', 'tok/s'],
  prefillRemaining: ['Prefill remaining', '%'], processed: ['Prefill processed', 'tokens'],
  total: ['Prefill stage total', 'tokens'], stageEstimate: ['Reported stage estimate', 's'],
  active: ['Active requests', ''], queued: ['Queued requests', ''],
  cpu: ['Host CPU', '%'], memory: ['Non-free host RAM', 'GiB'],
  footprint: ['Runtime process footprint', 'GiB'], swap: ['Swap used', 'GiB'],
  observedGeneration: ['Observed generation', 'tok/s'], generationSeconds: ['Generation observed', 's'],
  tokenIncrements: ['Observed output increments', 'tokens'], duration: ['Window observed', 's'],
  meanCPU: ['Mean sampled host CPU', '%'], meanMemory: ['Mean sampled non-free RAM', 'GiB'],
  peakMemory: ['Peak sampled non-free RAM', 'GiB'], cpuSamples: ['CPU samples', ''],
  memorySamples: ['RAM samples', ''], processSamples: ['Footprint samples', ''], requestCountChange: ['Reported completed-request change', ''],
  samples: ['Samples', ''], peakCPU: ['Peak sampled host CPU', '%'],
  peakFootprint: ['Peak sampled runtime footprint', 'GiB'],
} as const;
type Metric = keyof typeof measurementLabels;
type Measurements = Partial<Record<Metric, number | null>>;
const phases = ['connecting', 'reconnecting', 'offline', 'notLoaded', 'idle', 'queued', 'prefill', 'decode', 'processing', 'unknown'] as const;
export type Observation = {
  savedAt: number; sampledAt: number; kind: 'snapshot' | 'capture' | 'comparison';
  state: 'observed' | 'held' | 'finished' | 'interrupted'; phase: typeof phases[number];
  measurements: Measurements; reference?: Measurements;
  referenceSampledAt?: number | null; referenceState?: 'finished' | 'interrupted' | null;
};
const gib = (value: number | null | undefined): number | null => value == null ? null : value * 1e9 / 1024 ** 3;
const numeric = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const sanitizeMeasurements = (value: unknown): Measurements => {
  const source = object(value), result: Measurements = {};
  if (source) for (const key of Object.keys(measurementLabels) as Metric[]) {
    if (Object.hasOwn(source, key)) result[key] = numeric(source[key]);
  }
  return result;
};

/** Rebuild the allowlist on read and write. Stored text, model names and identifiers never survive. */
export const sanitizeObservation = (value: unknown): Observation | null => {
  const source = object(value);
  if (!source || !['snapshot', 'capture', 'comparison'].includes(String(source.kind))
    || !['observed', 'held', 'finished', 'interrupted'].includes(String(source.state))
    || !phases.includes(source.phase as typeof phases[number])) return null;
  const savedAt = numeric(source.savedAt), sampledAt = numeric(source.sampledAt);
  if (!savedAt || !sampledAt || savedAt > 8.64e15 || sampledAt > 8.64e15) return null;
  return { savedAt, sampledAt, kind: source.kind as Observation['kind'], state: source.state as Observation['state'],
    phase: source.phase as Observation['phase'], measurements: sanitizeMeasurements(source.measurements),
    ...(source.kind === 'comparison' ? { reference: sanitizeMeasurements(source.reference),
      referenceSampledAt: numeric(source.referenceSampledAt) !== null && Number(source.referenceSampledAt) > 0 && Number(source.referenceSampledAt) <= 8.64e15 ? Number(source.referenceSampledAt) : null,
      referenceState: source.referenceState === 'finished' || source.referenceState === 'interrupted' ? source.referenceState : null } : {}) };
};

export const snapshotObservation = (snapshot: TelemetrySnapshot, held: boolean, recentOutput: number | null, now = Date.now()): Observation => {
  const current = snapshot.available ? snapshot : null;
  const native = snapshot.system?.macOS;
  const nativeFresh = native && now >= native.sampledAt && now - native.sampledAt <= 20_000;
  return { savedAt: now, sampledAt: snapshot.sampledAt, kind: 'snapshot', state: held ? 'held' : 'observed', phase: snapshot.phase,
    measurements: {
      generation: current?.liveDecodeTPS ?? null, recentOutput,
      prefillRemaining: current?.prefillProgress == null ? null : (1 - current.prefillProgress) * 100,
      processed: current?.prefillProcessedTokens ?? null, total: current?.prefillTotalTokens ?? null,
      stageEstimate: !held && !current?.prefillProgressStale ? current?.prefillETASeconds ?? null : null,
      active: current?.activeRequests ?? null, queued: current?.queuedRequests ?? null,
      cpu: snapshot.system?.cpuPercent ?? null, memory: gib(snapshot.system?.memoryUsedGB),
      footprint: gib(current?.memory?.activeGB), swap: gib(nativeFresh ? native.swapUsedGB : null),
    } };
};

const captureMeasurements = (capture: Capture): Measurements => ({
  observedGeneration: capturedRate(capture), generationSeconds: capture.decodeSeconds,
  tokenIncrements: capture.decodeTokens, duration: capture.seconds, samples: capture.samples,
  peakCPU: capture.peakCPU, peakFootprint: gib(capture.peakProcessGB),
  meanCPU: capture.meanCPU, meanMemory: gib(capture.meanMemoryGB), peakMemory: gib(capture.peakMemoryGB),
  cpuSamples: capture.cpuSamples, memorySamples: capture.memorySamples, processSamples: capture.processSamples,
  requestCountChange: capture.requestCountChange,
});
export const captureObservation = (capture: Capture, reference: Capture | null, now = Date.now()): Observation => ({
  savedAt: now, sampledAt: capture.lastAt, kind: reference ? 'comparison' : 'capture',
  state: capture.status === 'finished' ? 'finished' : 'interrupted', phase: 'unknown',
  measurements: captureMeasurements(capture), ...(reference ? { reference: captureMeasurements(reference), referenceSampledAt:reference.lastAt,
    referenceState:reference.status === 'finished' ? 'finished' as const : 'interrupted' as const } : {}),
});

export const observationTitle = (item: Observation): string => item.kind === 'snapshot' ? 'Runtime snapshot' : item.kind === 'comparison' ? 'Capture with reference' : 'Observation capture';
export const observationReport = (item: Observation): string => {
  const lines = [`MLX Scope — ${observationTitle(item).toLowerCase()}`, `Saved: ${new Date(item.savedAt).toISOString()}`,
    `Observed: ${new Date(item.sampledAt).toISOString()} · ${item.state}${item.kind === 'snapshot' ? ` · ${item.phase}` : ''}`,
    'Server-wide observations, not selected-chat attribution or a controlled benchmark. Differences do not establish causality.'];
  const print = (values: Measurements) => {
    for (const key of Object.keys(measurementLabels) as Metric[]) {
      if (!Object.hasOwn(values, key)) continue;
      const value = values[key];
      const [label, unit] = measurementLabels[key];
      const rendered = value == null ? 'not reported' : key === 'prefillRemaining' && value > 0 && value < 1 ? '<1' : Number(value.toFixed(2)).toLocaleString('en-US');
      lines.push(`${label}: ${rendered}${value == null || !unit ? '' : ` ${unit}`}`);
    }
  };
  print(item.measurements);
  if (item.reference) {
    lines.push(`Pinned reference: ${item.referenceSampledAt ? new Date(item.referenceSampledAt).toISOString() : 'time not recorded'} · ${item.referenceState ?? 'status not recorded'}`,
      'Reference model identity is not stored.'); print(item.reference);
  }
  return lines.join('\n');
};

export class SavedObservations {
  items: Observation[] = [];
  private pending: Promise<unknown> = Promise.resolve();
  private readonly keys = new WeakMap<Observation, string>();
  constructor(private readonly storage: HostClient['storage']) {}
  private async entries(): Promise<{key: string; item: Observation}[]> {
    const keys = (await this.storage.keys()).filter(key => key.startsWith(SAVED_KEY)).sort().reverse();
    const records = await Promise.all(keys.slice(0, SAVED_LIMIT).map(async key => {
      const item = sanitizeObservation(await this.storage.get(key));
      return item ? {key, item} : null;
    }));
    return records.filter((entry): entry is {key: string; item: Observation} => entry !== null);
  }
  private async read(): Promise<void> {
    const entries = await this.entries();
    this.items = entries.map(({key,item}) => { this.keys.set(item,key); return item; });
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.pending.catch(() => {}).then(work); this.pending = next; return next;
  }
  load(): Promise<void> { return this.enqueue(() => this.read()); }
  save(value: Observation): Promise<void> {
    const item = sanitizeObservation(value);
    if (!item) return Promise.reject(new Error('Invalid observation'));
    return this.enqueue(async () => {
      // Each save has its own key, so simultaneous views cannot overwrite each other.
      // getRandomValues remains available when the host is served over plain HTTP.
      const suffix = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
      const key = `${SAVED_KEY}${String(item.savedAt).padStart(16, '0')}.${suffix}`;
      await this.storage.set(key, item);
      const keys = (await this.storage.keys()).filter(key => key.startsWith(SAVED_KEY)).sort().reverse();
      for (const obsolete of keys.slice(SAVED_LIMIT)) await this.storage.delete(obsolete);
      await this.read();
    });
  }
  delete(item: Observation): Promise<void> {
    const key = this.keys.get(item);
    if (!key) return Promise.reject(new Error('Observation is no longer loaded'));
    return this.enqueue(async () => { await this.storage.delete(key); await this.read(); });
  }
  clear(): Promise<void> {
    return this.enqueue(async () => {
      const keys = (await this.storage.keys()).filter(key => key.startsWith(SAVED_KEY));
      for (const key of keys) await this.storage.delete(key);
      await this.read();
    });
  }
}

import type { HostClient } from '@openchamber/sdk';
import type { Capture } from './capture.ts';
import { capturedRate } from './capture.ts';
import { gib } from './present/format.ts';
import type { Reading } from './present/reading.ts';

export const SAVED_LIMIT = 12;
export const SAVED_KEY = 'observation.v1.';
export const measurementLabels = {
  generation: ['Generation speed', 'tok/s'], recentOutput: ['Recent generation speed', 'tok/s'],
  prefillRemaining: ['Prompt reading left', '%'], processed: ['Prompt tokens read', 'tokens'],
  total: ['Prompt tokens being read', 'tokens'], stageEstimate: ['Estimated time left', 's'],
  active: ['Active requests', ''], queued: ['Queued requests', ''],
  splashDecode: ['Splash average generation speed since model start', 'tok/s'],
  splashCompleted: ['Splash finished requests since model start', ''],
  splashFailed: ['Splash failed requests since model start', ''],
  splashMetalCurrent: ['Splash GPU memory now', 'GiB'],
  splashMetalPeak: ['Splash peak GPU memory', 'GiB'],
  cpu: ['Mac CPU use', '%'], memory: ['Memory allocated', 'GiB'],
  footprint: ['Server memory in use', 'GiB'], swap: ['Swap in use', 'GiB'],
  observedGeneration: ['Measured generation speed', 'tok/s'], generationSeconds: ['Time spent generating', 's'],
  tokenIncrements: ['New output tokens', 'tokens'], duration: ['Recorded time', 's'],
  meanCPU: ['Average CPU use', '%'], meanMemory: ['Average memory allocated', 'GiB'],
  peakMemory: ['Peak memory allocated', 'GiB'], cpuSamples: ['CPU readings', ''],
  memorySamples: ['Memory readings', ''], processSamples: ['Server memory readings', ''], requestCountChange: ['New finished requests', ''],
  samples: ['Readings', ''], peakCPU: ['Peak CPU use', '%'],
  peakFootprint: ['Peak server memory in use', 'GiB'],
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

export const snapshotObservation = (reading: Reading, held: boolean, recentOutput: number | null, now = Date.now()): Observation => {
  const current = reading.available ? reading : null, request = current?.request;
  const native = reading.host?.mac;
  const nativeFresh = native && now >= native.sampledAt && now - native.sampledAt <= 20_000;
  return { savedAt: now, sampledAt: reading.sampledAt, kind: 'snapshot', state: held ? 'held' : 'observed', phase: reading.phase,
    measurements: {
      generation: request?.decodeTps ?? null, recentOutput,
      prefillRemaining: request?.prefillFraction == null ? null : (1 - request.prefillFraction) * 100,
      processed: request?.prefillProcessedTokens ?? null, total: request?.prefillTotalTokens ?? null,
      stageEstimate: !held && request?.prefillStale !== true && request?.prefillEtaMs != null ? request.prefillEtaMs / 1000 : null,
      active: current?.active ?? null, queued: current?.queued ?? null,
      cpu: reading.host?.cpuPercent ?? null, memory: gib(reading.host?.memUsedBytes),
      footprint: gib(current?.memory.processBytes), swap: gib(nativeFresh ? native.swapUsedBytes : null),
      ...(current?.runtime === 'splash' && current.splash ? {
        splashDecode: current.splash.decodeTps,
        splashCompleted: current.splash.completed,
        splashFailed: current.splash.failed,
        splashMetalCurrent: gib(current.splash.metalBytes),
        splashMetalPeak: gib(current.splash.metalPeakBytes),
      } : {}),
    } };
};

const captureMeasurements = (capture: Capture): Measurements => ({
  observedGeneration: capturedRate(capture), generationSeconds: capture.decodeSeconds,
  tokenIncrements: capture.decodeTokens, duration: capture.seconds, samples: capture.samples,
  peakCPU: capture.peakCPU, peakFootprint: gib(capture.peakProcessBytes),
  meanCPU: capture.meanCPU, meanMemory: gib(capture.meanMemoryBytes), peakMemory: gib(capture.peakMemoryBytes),
  cpuSamples: capture.cpuSamples, memorySamples: capture.memorySamples, processSamples: capture.processSamples,
  requestCountChange: capture.requestCountChange,
});
export const captureObservation = (capture: Capture, reference: Capture | null, now = Date.now()): Observation => ({
  savedAt: now, sampledAt: capture.lastAt, kind: reference ? 'comparison' : 'capture',
  state: capture.status === 'finished' ? 'finished' : 'interrupted', phase: 'unknown',
  measurements: captureMeasurements(capture), ...(reference ? { reference: captureMeasurements(reference), referenceSampledAt:reference.lastAt,
    referenceState:reference.status === 'finished' ? 'finished' as const : 'interrupted' as const } : {}),
});

export const observationTitle = (item: Observation): string => item.kind === 'snapshot' ? 'Server snapshot' : item.kind === 'comparison' ? 'Capture with reference' : 'Recorded activity';
export const observationReport = (item: Observation): string => {
  const lines = [`MLX Scope — ${observationTitle(item).toLowerCase()}`, `Saved: ${new Date(item.savedAt).toISOString()}`,
    `Observed: ${new Date(item.sampledAt).toISOString()} · ${item.state}${item.kind === 'snapshot' ? ` · ${item.phase}` : ''}`,
    'These readings cover all server activity. Other apps and chats can affect the results.'];
  if (Object.hasOwn(item.measurements, 'splashDecode') || Object.hasOwn(item.measurements, 'splashCompleted')) {
    lines.push('Splash averages include all requests since this model started.');
  }
  const print = (values: Measurements) => {
    for (const key of Object.keys(measurementLabels) as Metric[]) {
      if (!Object.hasOwn(values, key)) continue;
      const value = values[key];
      if (value == null) continue;
      const [label, unit] = measurementLabels[key];
      const rendered = value == null ? 'not reported' : key === 'prefillRemaining' && value > 0 && value < 1 ? '<1' : Number(value.toFixed(2)).toLocaleString('en-US');
      lines.push(`${label}: ${rendered}${value == null || !unit ? '' : ` ${unit}`}`);
    }
  };
  print(item.measurements);
  if (item.reference) {
    lines.push(`Pinned reference: ${item.referenceSampledAt ? new Date(item.referenceSampledAt).toISOString() : 'time not recorded'} · ${item.referenceState ?? 'status not recorded'}`,
      'The reference model name is not saved.'); print(item.reference);
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

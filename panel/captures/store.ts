import type { HostClient } from '@openchamber/sdk';
import { at, finite, obj, oneOf } from '../../src/contract/guards.ts';
import { runtimeKind } from '../../src/contract/runtime.ts';
import { KEYS, rand4 } from '../history/ledger-schema.ts';

// Owner: ledger. Saved captures (capture.v2.<ts36>, ≤ 12), successor of panel/saved.ts. Class B: no model names stored.

export const CAPTURE_LIMIT = 12;
/**
 * The only measurement keys a capture keeps. The suffix is the unit (contract §3): *Bytes safe integers, *Tokens
 * integers, *Fraction 0…1, *Ms and *Tps ≥ 0; the rest are counts. Migrated 1.x values use the same keys.
 */
export const CAPTURE_MEASUREMENTS = [
  'decodeTps', 'prefillTps', 'ttftMs', 'elapsedMs', 'decodeMs', 'prefillMs', 'promptTokens', 'cachedTokens', 'outputTokens',
  'contextUsedTokens', 'contextWindowTokens', 'cacheFraction',
  'windowMs', 'samples', 'observedDecodeTps', 'observedOutputTokens', 'completedRequestsDelta',
  'meanCpuFraction', 'peakCpuFraction', 'cpuSamples', 'meanMemUsedBytes', 'peakMemUsedBytes', 'memorySamples',
  'peakFootprintBytes', 'footprintSamples', 'swapDeltaBytes',
  'recentOutputTps', 'prefillRemainingFraction', 'prefillProcessedTokens', 'prefillTotalTokens', 'prefillEtaMs',
  'activeRequests', 'queuedRequests', 'splashDecodeTps', 'splashCompletedRequests', 'splashFailedRequests',
  'splashMetalBytes', 'splashMetalPeakBytes', 'cpuFraction', 'memUsedBytes', 'footprintBytes', 'swapUsedBytes',
] as const;
export type CaptureMeasurement = typeof CAPTURE_MEASUREMENTS[number];
export const V1_PHASES = ['connecting', 'reconnecting', 'offline', 'notLoaded', 'idle', 'queued', 'prefill', 'decode', 'processing', 'unknown'] as const;
export interface CaptureV2 {
  v: 2;
  savedAt: number;
  kind: 'snapshot' | 'window' | 'next-reply' | 'comparison';
  runtime: string | null;                    // RuntimeKind or null; never a model name
  label: 'server-wide' | 'armed';
  measurements: Record<string, number>;      // allowlisted keys in bytes/ms/tps/fraction units
  reference?: Record<string, number>;
  state: 'finished' | 'interrupted';
  /** Migrated from `observation.v1.*`: shown read-only as "Saved in 1.x"; never pruned by new saves. */
  origin?: 'v1';
  sampledAt?: number;                        // when the reading was taken or the window ended
  held?: true;                               // 1.x: saved while paused or with stale prefill progress
  phase?: typeof V1_PHASES[number];          // 1.x snapshot phase
  referenceSampledAt?: number;
  referenceState?: 'finished' | 'interrupted';
}
export type StoredCapture = CaptureV2 & { key: string };

const KIND = oneOf(['snapshot', 'window', 'next-reply', 'comparison'] as const), STATE = oneOf(['finished', 'interrupted'] as const);
const measurement = (key: string, value: unknown): number | null => {
  if (key === 'swapDeltaBytes') return Number.isSafeInteger(value) ? value as number : null;
  const n = finite(value);
  if (n === null || n < 0) return null;
  if (/Fraction$/.test(key)) return n <= 1 ? n : null;
  if (/(?:Ms|Tps)$/.test(key)) return n;
  return Number.isSafeInteger(n) ? n : null;
};
/** Rebuilds the allowlist: unknown keys, strings and out-of-unit numbers never survive a read or a write. */
export const sanitizeMeasurements = (value: unknown): Record<string, number> => {
  const source = obj(value) ?? {}, result: Record<string, number> = {};
  for (const key of CAPTURE_MEASUREMENTS) {
    const n = Object.hasOwn(source, key) ? measurement(key, source[key]) : null;
    if (n !== null) result[key] = n;
  }
  return result;
};
export const parseCapture = (value: unknown): CaptureV2 | null => {
  const item = obj(value), savedAt = at(item?.savedAt), kind = KIND(item?.kind), state = STATE(item?.state);
  if (!item || item.v !== 2 || !savedAt || !kind || !state || item.label !== 'server-wide' && item.label !== 'armed') return null;
  const sampledAt = at(item.sampledAt), referenceSampledAt = at(item.referenceSampledAt), referenceState = STATE(item.referenceState);
  const phase = oneOf(V1_PHASES)(item.phase);
  return { v: 2, savedAt, kind, runtime: runtimeKind(item.runtime), label: item.label, measurements: sanitizeMeasurements(item.measurements),
    ...obj(item.reference) ? { reference: sanitizeMeasurements(item.reference) } : {}, state,
    ...item.origin === 'v1' ? { origin: 'v1' as const } : {}, ...sampledAt ? { sampledAt } : {}, ...item.held === true ? { held: true as const } : {},
    ...phase ? { phase } : {}, ...referenceSampledAt ? { referenceSampledAt } : {}, ...referenceState ? { referenceState } : {} };
};
export const captureKey = (savedAt: number, suffix: string): string => `${KEYS.capturePrefix}${Math.floor(savedAt).toString(36)}.${suffix}`;
const newest = (a: CaptureV2, b: CaptureV2): number => b.savedAt - a.savedAt;
/** Reading at most this many keys bounds a namespace someone else filled with capture keys. */
const LIST_KEYS = 4 * CAPTURE_LIMIT;

export class CaptureStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: HostClient['storage'], private readonly suffix: () => string = rand4) {}
  /** Newest first: saved captures and the migrated 1.x ones (`origin: 'v1'`). */
  list(): Promise<StoredCapture[]> { return this.enqueue(() => this.read()); }
  /** One `set`, then the oldest saved capture beyond 12 is deleted; migrated ones are never pruned here. */
  save(capture: CaptureV2): Promise<string> {
    const clean = parseCapture({ ...capture, origin: undefined });
    if (!clean) return Promise.reject(new Error('Invalid capture'));
    return this.enqueue(async () => {
      const keys = new Set((await this.storage.keys()).filter(key => key.startsWith(KEYS.capturePrefix)));
      let key = captureKey(clean.savedAt, this.suffix());
      while (keys.has(key)) key = captureKey(clean.savedAt, rand4());
      await this.storage.set(key, clean as never);
      const saved = (await this.read()).filter(item => item.origin !== 'v1');
      for (const obsolete of saved.slice(CAPTURE_LIMIT)) await this.storage.delete(obsolete.key);
      return key;
    });
  }
  remove(key: string): Promise<void> {
    if (!key.startsWith(KEYS.capturePrefix)) return Promise.reject(new Error('Not a capture'));
    return this.enqueue(() => this.storage.delete(key));
  }
  private async read(): Promise<StoredCapture[]> {
    const keys = (await this.storage.keys()).filter(key => key.startsWith(KEYS.capturePrefix)).sort().reverse().slice(0, LIST_KEYS);
    const items = await Promise.all(keys.map(async key => { const item = parseCapture(await this.storage.get(key)); return item ? { ...item, key } : null; }));
    return items.filter((item): item is StoredCapture => item !== null).sort(newest);
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(work);
    this.queue = next;
    return next;
  }
}
export const captureCount = (items: readonly CaptureV2[]): { saved: number; migrated: number } =>
  ({ saved: items.filter(item => item.origin !== 'v1').length, migrated: items.filter(item => item.origin === 'v1').length });

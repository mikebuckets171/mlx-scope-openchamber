import type { HostClient, JsonValue } from '@openchamber/sdk';
import { hash32 } from '../../src/contract/hash.ts';
import { captureKey, parseCapture, type CaptureMeasurement, type CaptureV2 } from '../captures/store.ts';
import { measurementLabels, sanitizeObservation, type Observation } from '../saved.ts';
import { KEYS, LEDGER_SCHEMA, parseMeta, type LedgerMeta } from './ledger-schema.ts';

// Owner: ledger. observation.v1.* → capture.v2.* (plan §7): reuses sanitizeObservation (panel/saved.ts), GiB → bytes as
// ×2³⁰ (1.6 stored GiB), covers measurements and reference. v1 keys stay through 2.0.x.

export interface MigrationResult { migrated: number; skipped: number; at: number }
type V1Metric = keyof typeof measurementLabels;
const GIB = 2 ** 30;
const same = (n: number) => n, gib = (n: number) => Math.round(n * GIB), seconds = (n: number) => n * 1000, percent = (n: number) => n / 100;
/** Every 1.x measurement, its v2 key and unit conversion (1.6 stored GiB, %, s; v2 keeps bytes, fractions, ms). */
export const V1_MEASUREMENTS: Record<V1Metric, [CaptureMeasurement, (n: number) => number]> = {
  generation: ['decodeTps', same], recentOutput: ['recentOutputTps', same], prefillRemaining: ['prefillRemainingFraction', percent],
  processed: ['prefillProcessedTokens', same], total: ['prefillTotalTokens', same], stageEstimate: ['prefillEtaMs', seconds],
  active: ['activeRequests', same], queued: ['queuedRequests', same], splashDecode: ['splashDecodeTps', same],
  splashCompleted: ['splashCompletedRequests', same], splashFailed: ['splashFailedRequests', same],
  splashMetalCurrent: ['splashMetalBytes', gib], splashMetalPeak: ['splashMetalPeakBytes', gib],
  cpu: ['cpuFraction', percent], memory: ['memUsedBytes', gib], footprint: ['footprintBytes', gib], swap: ['swapUsedBytes', gib],
  observedGeneration: ['observedDecodeTps', same], generationSeconds: ['decodeMs', seconds], tokenIncrements: ['observedOutputTokens', same],
  duration: ['windowMs', seconds], meanCPU: ['meanCpuFraction', percent], meanMemory: ['meanMemUsedBytes', gib],
  peakMemory: ['peakMemUsedBytes', gib], cpuSamples: ['cpuSamples', same], memorySamples: ['memorySamples', same],
  processSamples: ['footprintSamples', same], requestCountChange: ['completedRequestsDelta', same], samples: ['samples', same],
  peakCPU: ['peakCpuFraction', percent], peakFootprint: ['peakFootprintBytes', gib],
};
const KIND = { snapshot: 'snapshot', capture: 'window', comparison: 'comparison' } as const;

/** 1.x kept `null` for "not reported"; v2 leaves the key out. */
const convert = (values: Observation['measurements']): Record<string, number> => {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(values) as Array<[V1Metric, number | null]>) {
    const rule = V1_MEASUREMENTS[key];
    if (rule && value !== null) result[rule[0]] = rule[1](value);
  }
  return result;
};
export const captureFromObservation = (value: unknown): CaptureV2 | null => {
  const item = sanitizeObservation(value);
  if (!item) return null;
  const splash = Object.keys(item.measurements).some(key => key.startsWith('splash'));
  // parseCapture re-applies the v2 allowlist and units, so a converted value outside its unit is dropped, never kept.
  return parseCapture({ v: 2, savedAt: item.savedAt, kind: KIND[item.kind], runtime: splash ? 'splash' : null, label: 'server-wide',
    measurements: convert(item.measurements), ...item.reference ? { reference: convert(item.reference) } : {},
    state: item.state === 'interrupted' ? 'interrupted' : 'finished', origin: 'v1', sampledAt: item.sampledAt,
    ...item.state === 'held' ? { held: true } : {}, ...item.kind === 'snapshot' ? { phase: item.phase } : {},
    ...item.referenceSampledAt ? { referenceSampledAt: item.referenceSampledAt } : {},
    ...item.referenceState ? { referenceState: item.referenceState } : {} });
};
/** Deterministic, so two leaders racing through a migration write the same keys instead of duplicates. */
export const migratedKey = (v1Key: string, savedAt: number): string => captureKey(savedAt, (hash32(v1Key) & 0xffff).toString(16).padStart(4, '0'));

/**
 * Leader only, once: copies every valid observation.v1.* into capture.v2.* and records meta.v2.migratedAt. Nothing is
 * written when there is nothing to migrate or it already ran; the v1 keys are left untouched (deleted in 2.1).
 */
export const migrateV1 = async (storage: HostClient['storage'], now: number): Promise<MigrationResult> => {
  const keys = await storage.keys(), meta = parseMeta(await storage.get(KEYS.meta));
  const legacy = keys.filter(key => key.startsWith(KEYS.legacyObservationPrefix)).sort();
  if (meta?.migratedAt || !legacy.length) return { migrated: 0, skipped: 0, at: now };
  const existing = new Set(keys);
  let migrated = 0, skipped = 0;
  for (const key of legacy) {
    const capture = captureFromObservation(await storage.get(key));
    if (!capture) { skipped += 1; continue; }
    const target = migratedKey(key, capture.savedAt);
    if (!existing.has(target)) await storage.set(target, capture as unknown as JsonValue);
    migrated += 1;
  }
  const next: LedgerMeta = { ...meta ?? { schema: LEDGER_SCHEMA, accounting: { bytes: 0, keys: 0 } }, schema: LEDGER_SCHEMA, migratedAt: now };
  await storage.set(KEYS.meta, next as unknown as JsonValue);
  return { migrated, skipped, at: now };
};

import { expect, test } from 'bun:test';
import { classAKeys } from '../../src/contract/guards.ts';
import { unitViolations } from '../../src/contract/units.ts';
import { CaptureStore, type CaptureV2 } from '../captures/store.ts';
import { measurementLabels } from '../saved.ts';
import { createFakeStorage } from '../testing/storage.ts';
import { KEYS } from './ledger-schema.ts';
import { captureFromObservation, migratedKey, migrateV1, V1_MEASUREMENTS } from './migrate-v1.ts';

const FIXTURES = new URL('../../tests/fixtures/storage/1.6.1/', import.meta.url);
const recorded = await Bun.file(new URL('observation-v1.json', FIXTURES)).json() as Record<string, unknown>;
const golden = await Bun.file(new URL('capture-v2.golden.json', FIXTURES)).json() as Record<string, CaptureV2>;
const NOW = 1_790_690_700_000;

test('golden: the records 1.6.1 wrote become capture.v2 with GiB ×2³⁰ → bytes, % → fractions and s → ms', () => {
  const migrated = Object.fromEntries(Object.entries(recorded).map(([key, value]) => {
    const capture = captureFromObservation(value)!;
    return [migratedKey(key, capture.savedAt), capture];
  }));
  expect(migrated).toEqual(golden);
  const [prefill, splash, comparison] = Object.values(migrated);
  // 1.6.1 stored 29.999999999999996 GiB for 32,212,254,720 bytes; the integer comes back.
  expect(prefill!.measurements.memUsedBytes).toBe(32_212_254_720);
  expect(splash!.measurements.splashMetalBytes).toBe(12_500_000_000);
  expect(comparison!.reference!.observedDecodeTps).toBe(22);
  for (const capture of Object.values(migrated)) {
    expect(unitViolations(capture)).toEqual([]);
    expect(classAKeys(capture)).toEqual([]);
    expect(JSON.stringify(capture)).not.toMatch(/Example|model/i);
  }
});

test('every 1.x measurement has a v2 key and unit rule, and no two share a key', () => {
  expect(Object.keys(V1_MEASUREMENTS).sort()).toEqual(Object.keys(measurementLabels).sort());
  const targets = Object.values(V1_MEASUREMENTS).map(([key]) => key);
  expect(new Set(targets).size).toBe(targets.length);
});

test('class B canary: model names, ids and text in a 1.x record never survive the migration', () => {
  const [key, record] = Object.entries(recorded)[0]!;
  const planted = { ...record as object, model: 'CANARY-model', modelID: 'CANARY/model', request_id: 'CANARY-req', message: 'CANARY text',
    measurements: { ...(record as { measurements: object }).measurements, cpu: 'CANARY', memory: -1, footprint: 1e400, bogus: 5 } };
  const capture = captureFromObservation(planted)!;
  expect(JSON.stringify(capture)).not.toContain('CANARY');
  expect(capture.measurements).not.toHaveProperty('cpuFraction');
  expect(capture.measurements).not.toHaveProperty('memUsedBytes');
  expect(capture.measurements).not.toHaveProperty('bogus');
  expect(key.startsWith(KEYS.legacyObservationPrefix)).toBe(true);
  expect(captureFromObservation({ kind: 'snapshot' })).toBeNull();
  expect(captureFromObservation(null)).toBeNull();
});

test('migrateV1 copies once, keeps the v1 keys, records migratedAt, and writes nothing without v1 data', async () => {
  const storage = createFakeStorage({ initial: { ...recorded, [`${KEYS.legacyObservationPrefix}0000000000000001.bad`]: { kind: 'nope' }, 'view.compact': true } });
  expect(await migrateV1(storage, NOW)).toEqual({ migrated: 3, skipped: 1, at: NOW });
  const dump = storage.dump();
  for (const key of Object.keys(recorded)) expect(dump[key]).toEqual(recorded[key]);
  for (const [key, value] of Object.entries(golden)) expect(dump[key]).toEqual(value);
  expect(dump[KEYS.meta]).toEqual({ schema: 2, migratedAt: NOW, accounting: { bytes: 0, keys: 0 } });
  const sets = storage.stats().sets;
  expect(await migrateV1(storage, NOW + 1)).toEqual({ migrated: 0, skipped: 0, at: NOW + 1 });
  expect(storage.stats().sets).toBe(sets);
  const empty = createFakeStorage({ initial: { 'view.compact': true } });
  await migrateV1(empty, NOW);
  expect(empty.stats().sets).toBe(0);
  // Migrated captures list as "Saved in 1.x" next to new ones and are never pruned by new saves.
  const items = await new CaptureStore(storage).list();
  expect(items.map(item => item.origin)).toEqual(['v1', 'v1', 'v1']);
});

test('two leaders racing through the migration write the same keys, not duplicates', async () => {
  const storage = createFakeStorage({ initial: recorded });
  await Promise.all([migrateV1(storage, NOW), migrateV1(storage, NOW)]);
  expect(Object.keys(storage.dump()).filter(key => key.startsWith(KEYS.capturePrefix)).sort()).toEqual(Object.keys(golden).sort());
});

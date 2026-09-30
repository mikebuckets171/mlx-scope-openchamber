import { expect, test } from 'bun:test';
import { unitViolations } from '../../src/contract/units.ts';
import { createFakeStorage } from '../testing/storage.ts';
import { CAPTURE_LIMIT, captureCount, CaptureStore, parseCapture, type CaptureV2 } from './store.ts';

const NOW = 1_790_690_700_000;
const capture = (savedAt: number, extra: Partial<CaptureV2> = {}): CaptureV2 => ({ v: 2, savedAt, kind: 'next-reply', runtime: 'lmstudio', label: 'armed',
  measurements: { decodeTps: 25.1, outputTokens: 1_204, ttftMs: 520 }, state: 'finished', ...extra });

test('a capture is rebuilt from the allowlist: no model names, strings, unknown keys or values outside their unit', () => {
  const clean = parseCapture({ ...capture(NOW), model: 'CANARY-model', runtime: 'CANARY-runtime', title: 'CANARY',
    measurements: { decodeTps: 25.1, cpuFraction: 45, memUsedBytes: 1.5, outputTokens: -3, swapDeltaBytes: -1_048_576, model: 'CANARY', ttftMs: 'fast' },
    reference: { decodeTps: 22 }, origin: 'v1', phase: 'CANARY' })!;
  expect(clean).toEqual({ v: 2, savedAt: NOW, kind: 'next-reply', runtime: null, label: 'armed', measurements: { decodeTps: 25.1, swapDeltaBytes: -1_048_576 },
    reference: { decodeTps: 22 }, state: 'finished', origin: 'v1' });
  expect(JSON.stringify(clean)).not.toContain('CANARY');
  expect(unitViolations(clean)).toEqual([]);
  for (const bad of [null, {}, { ...capture(NOW), v: 1 }, { ...capture(NOW), kind: 'other' }, { ...capture(NOW), label: 'This chat' }, { ...capture(0) }]) {
    expect(parseCapture(bad)).toBeNull();
  }
});

test('the store keeps the 12 newest saved captures, never prunes migrated ones, and lists newest first', async () => {
  const storage = createFakeStorage({ initial: { 'capture.v2.old.v1aa': { ...capture(NOW - 10_000_000), origin: 'v1', label: 'server-wide', kind: 'window' } } });
  const store = new CaptureStore(storage);
  for (let index = 0; index < CAPTURE_LIMIT + 3; index++) await store.save(capture(NOW + index * 1_000));
  const items = await store.list();
  expect(captureCount(items)).toEqual({ saved: CAPTURE_LIMIT, migrated: 1 });
  expect(items[0]!.savedAt).toBe(NOW + (CAPTURE_LIMIT + 2) * 1_000);
  expect(items.at(-1)!.origin).toBe('v1');
  expect(items.filter(item => item.origin !== 'v1').at(-1)!.savedAt).toBe(NOW + 3_000);
  // A save cannot pose as a migrated record.
  const key = await store.save({ ...capture(NOW + 99_000), origin: 'v1' });
  expect((await store.list()).find(item => item.key === key)!.origin).toBeUndefined();
  await store.remove(key);
  expect((await store.list()).some(item => item.key === key)).toBe(false);
  await expect(store.remove('pref.v2')).rejects.toThrow();
  await expect(store.save({ ...capture(NOW), kind: 'other' as never })).rejects.toThrow();
});

test('concurrent saves from one view both land; a colliding random suffix gets a new one', async () => {
  const storage = createFakeStorage(), store = new CaptureStore(storage, () => 'aaaa');
  const keys = await Promise.all([store.save(capture(NOW)), store.save(capture(NOW))]);
  expect(new Set(keys).size).toBe(2);
  expect(await store.list()).toHaveLength(2);
});

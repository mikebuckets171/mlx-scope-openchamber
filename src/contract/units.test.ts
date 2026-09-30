import { expect, test } from 'bun:test';
import { assertBodyLimit, bodyChars, classAKeys, label, MAX_BODY_CHARS, modelLabel } from './guards.ts';
import { parseSnapshotV2 } from './snapshot.ts';
import { fullSnapshot, fullTrend, fullUsage } from './testing/full.ts';
import { parseTrendV2 } from './trend.ts';
import { bytesToGB, gbToBytes, percentToFraction, secondsToMs, unitViolations } from './units.ts';
import { parseUsageV2 } from './usage.ts';

test('1.x decimal GB converts to the integer bytes it came from', () => {
  for (const bytes of [0, 1, 999, 12_500_000_000, 38_762_079_846, 51_539_607_552, 2 ** 52]) expect(gbToBytes(bytesToGB(bytes))).toBe(bytes);
  expect(gbToBytes(36.1 * 1024 ** 3 / 1e9)).toBe(38_762_079_846);
  expect([gbToBytes(-1), gbToBytes(Number.NaN), gbToBytes(Infinity), gbToBytes(null), gbToBytes(1e10)]).toEqual([null, null, null, null, null]);
  expect([secondsToMs(17.75), secondsToMs(-1), percentToFraction(82.3), percentToFraction(100.1)]).toEqual([17_750, null, 0.823, null]);
});

test('the unit lint names every field that breaks its suffix', () => {
  expect(unitViolations({ a: { ramBytes: 1.5, swapDeltaBytes: -4, gpuAllocMaxBytes: -1 }, promptTokens: 2.5, busyFraction: 1.2, cpuFraction: 0.5,
    elapsedMs: -1, decodeTps: Number.NaN, chipW: -2, sampledAt: 9e15, at: 1, list: [{ outputTokens: -1 }], label: 'text', serverNow: -5 })).toEqual([
    'a.ramBytes must be a safe integer byte count', 'a.gpuAllocMaxBytes must be a safe integer byte count', 'promptTokens must be an integer token count',
    'busyFraction must be within 0…1', 'elapsedMs must be finite and ≥ 0', 'decodeTps must be finite and ≥ 0', 'chipW must be finite and ≥ 0',
    'sampledAt must be an epoch millisecond', 'list[0].outputTokens must be an integer token count', 'serverNow must be an epoch millisecond']);
});

test('every /v2 route at maximum fill stays under the 256,000-character SDK limit', () => {
  const bodies = { snapshot: parseSnapshotV2(fullSnapshot()), trend: parseTrendV2(fullTrend()), usage: parseUsageV2(fullUsage()) };
  for (const [route, body] of Object.entries(bodies)) {
    expect(body, route).not.toBeNull();
    expect(unitViolations(body), route).toEqual([]);
    expect(bodyChars(body), route).toBeLessThan(MAX_BODY_CHARS);
    expect(() => assertBodyLimit(body), route).not.toThrow();
  }
  // Caps hold on input that is far over them.
  const snapshot = bodies.snapshot!;
  expect([snapshot.connection.choices.length, snapshot.runtime.residency.length, snapshot.runtime.slots.length, snapshot.runtime.catalog.length,
    snapshot.runtime.engines.length, snapshot.completions.items.length, snapshot.alerts.length, snapshot.alertLog.length]).toEqual([8, 12, 16, 12, 8, 64, 9, 20]);
  expect(bodies.trend!.gaps).toHaveLength(180);
  expect(bodies.usage!.models).toHaveLength(50);
});

test('the size helper rejects a body at the limit', () => {
  expect(bodyChars('x'.repeat(255_999))).toBe(255_999);
  expect(() => assertBodyLimit('x'.repeat(255_999))).not.toThrow();
  expect(() => assertBodyLimit('x'.repeat(256_000))).toThrow(RangeError);
  expect(() => assertBodyLimit({ text: 'x'.repeat(256_000) })).toThrow(RangeError);
});

test('labels drop control characters and model names drop their paths', () => {
  expect([label(' a\u0000b\u001f '), label('   '), label(4), label('x'.repeat(200))?.length]).toEqual(['ab', null, null, 120]);
  expect([modelLabel('/Users/someone/models/Example-4bit'), modelLabel('C:\\models\\example.gguf'), modelLabel('~/m/x'), modelLabel('file:/m/x'),
    modelLabel('publisher/Example-4bit'), modelLabel('/'), modelLabel('m'.repeat(300))?.length]).toEqual(['Example-4bit', 'example.gguf', 'x', 'x', 'publisher/Example-4bit', null, 256]);
});

test('the class A walker finds forbidden keys at any depth and ignores their look-alikes', () => {
  expect(classAKeys({ a: [{ b: { PID: 1 } }], host: { runtimeProcess: { port: 1 } }, promptTokens: 1, sessionTitle: 'x', model_path: '/m' }))
    .toEqual(['a[0].b.PID', 'sessionTitle', 'model_path']);
});

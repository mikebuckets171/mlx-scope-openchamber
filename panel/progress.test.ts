import { expect, test } from 'bun:test';
import { parseTelemetrySnapshot, normalizeOmlxTelemetry } from '../src/telemetry.ts';
import { prefillReading } from './progress.ts';

const raw = (flight: object) => normalizeOmlxTelemetry(null, { active_models: {
  models: [{ id: 'fixture', active_requests: 1, prefilling: [flight] }], total_active_requests: 1,
} })!;
const wire = (overrides: object) => {
  const value = parseTelemetrySnapshot({ available: true, phase: 'prefill', ...overrides });
  if (!value.available) throw Error('Fixture must be available');
  return value;
};
test('prefill uses processed / total; cache reuse is not subtracted a second time', () => {
  const reading = raw({ request_id: 'private', processed: 5824, total: 9100, prompt_tokens: 52100, cached_tokens: 43000, speed: 184 });
  expect(prefillReading(reading)).toMatchObject({ remaining: '36% remaining', completed: '64% complete', counts: { done: 5824, total: 9100, remaining: 3276 } });
  expect(JSON.stringify(reading)).not.toContain('private');
  expect(parseTelemetrySnapshot(reading)).toEqual(reading);
});
test('prefill never rounds incomplete work to zero remaining', () => {
  expect(prefillReading(wire({ prefillProgress: 0 }))?.remaining).toBe('100% remaining');
  expect(prefillReading(wire({ prefillProgress: 0.9999 }))).toMatchObject({ remaining: '<1% remaining', completed: '>99% complete' });
  expect(prefillReading(wire({ prefillProgress: 1 }))?.remaining).toBe('0% remaining');
});
test('malformed raw counters stay unavailable rather than clamping to completion', () => {
  for (const [processed, total] of [[0, 0], [12, 10], [-1, 10], [1, null], [null, 10], ['1', 10], [1.1, 10], [1, 10.1], [1, Infinity], [NaN, 10], [1, Number.MAX_SAFE_INTEGER + 1]]) {
    const result = raw({ processed, total });
    expect(result.prefillProgress).toBeNull();
    expect(prefillReading(result)?.remaining).toBe('Progress unavailable');
  }
});
test('wire fractions are bounded; validated counts override inconsistent fractions', () => {
  for (const prefillProgress of [-1, 1.01, Infinity, NaN, '0.5']) expect(wire({ prefillProgress }).prefillProgress).toBeNull();
  expect(wire({ prefillProgress: 1, prefillProcessedTokens: 4, prefillTotalTokens: 10 }).prefillProgress).toBe(0.4);
  expect(wire({ prefillProgress: 0.5, prefillProcessedTokens: 11, prefillTotalTokens: 10 }).prefillProgress).toBeNull();
  expect(prefillReading(wire({ prefillProgress: 0.5 }))?.counts).toBeNull();
});
test('old progress-only service responses remain readable without invented counts', () => {
  expect(prefillReading(wire({ prefillProgress: 0.64 }))).toMatchObject({ remaining: '36% remaining', counts: null });
});
test('stale progress is retained but speed is withheld; later phases remove progress', () => {
  const reading = raw({ processed: 64, total: 100, progress_stale: true, speed: 184 });
  expect(prefillReading(reading)).toMatchObject({ remaining: '36% remaining', stale: true });
  expect(reading.livePrefillTPS).toBeNull();
  expect(prefillReading(wire({ phase: 'decode', prefillProgress: 0.64 }))).toBeNull();
});


test('whole-token percentages do not lose a percent to floating-point representation', () => {
  for (let done = 0; done <= 100; done++) {
    const reading = raw({ processed: done, total: 100 });
    expect(prefillReading(reading)).toMatchObject({ remaining: `${100 - done}% remaining`, completed: `${done}% complete` });
  }
});

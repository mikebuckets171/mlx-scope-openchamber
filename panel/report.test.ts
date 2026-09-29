import { expect, test } from 'bun:test';
import { frameReading } from './present/reading.ts';
import { measurementReport } from './report.ts';
import { completionOf, fromV1 } from './testing/readings.ts';

test('clipboard report contains measurements, never raw messages, keys, model names or IDs', () => {
  const reading = fromV1({ available: true, phase: 'prefill', prefillProgress: 0.64, prefillProcessedTokens: 64, prefillTotalTokens: 100,
    modelID: 'secret-model', message: '/private/example secret-key', traceEpoch: 12345, sampledAt: 1000 });
  const report = measurementReport(reading, null, false, '1.0.0', 2000);
  expect(report).toContain('36% remaining'); expect(report).toContain('64 / 100');
  for (const sensitive of ['secret-model', '/private/example', 'secret-key', '12345', 'undefined', 'NaN']) expect(report).not.toContain(sensitive);
  expect(report.length).toBeLessThan(32000);
});
test('clipboard clearly labels frozen or unavailable observations', () => {
  const reading = frameReading('runtime_unreachable', 'private error', 1000);
  const report = measurementReport(reading, null, true, '1.0.0', 2000);
  expect(report).toContain('paused — held observations'); expect(report).toContain('runtime_unreachable');
  expect(report).not.toContain('private error');
});

test('a reconnecting view reports held data without saying the user paused it', () => {
  const reading = fromV1({ available: true, phase: 'prefill', prefillProgress: 0.5, prefillETASeconds: 10, sampledAt: 1 });
  const report = measurementReport(reading, null, 'refreshing', '1.0.0', 2);
  expect(report).toContain('State: refreshing — held observations');
  expect(report).not.toContain('State: paused');
  expect(report).not.toContain('Prefill stage estimate:');
});

test('Splash report labels server-wide scope and lists only measured values', () => {
  const reading = fromV1({ available: true, runtime: 'splash', phase: 'unknown',
    modelID: 'incoai/private-model', message: 'raw private path', sampledAt: 1000,
    serverStats: { ready: true, aggregateDecodeTokensPerSecond: 47.2, completedRequests: 17,
      failedRequests: 1, metalCurrentGB: 12.5, metalPeakGB: 13 },
  });
  const report = measurementReport(reading, null, false, '1.2.0', 2000);
  expect(report).toContain('Splash server decode (all requests): 47.2 tok/s');
  expect(report).toContain('Splash completed requests since start: 17');
  expect(report).toContain('Splash GPU memory (Metal) · now: 11.64 GiB');
  expect(report).not.toContain('not reported');
  expect(report).not.toContain('private-model');
  expect(report).not.toContain('raw private path');
});

test('Bionic report includes the last response’s exact figures', () => {
  const reading = fromV1({ available: true, runtime: 'lmstudio', phase: 'idle', modelID: 'local/qwen3.8-27b-splash-levels', sampledAt: 1000,
    activeRequests: 0, lastRequest: { model: 'local/qwen3.8-27b-splash-levels', tokensPerSecond: 38.6, ttftSeconds: 0.5,
      promptTokens: 18_400, cachedTokens: 11_260, outputTokens: 1092, finishedAt: 900 } });
  const report = measurementReport(reading, null, false, '1.4.0', 2000, completionOf(reading));
  expect(report).toContain('Last response speed (exact): 38.6 tok/s');
  expect(report).toContain('Last response first token: 0.5 seconds');
  expect(report).toContain('Last response cached tokens: 11260');
  expect(report).not.toContain('not reported');
  expect(report).not.toContain('qwen3.8');
});

test('host lines convert integer bytes to GiB at two decimals', () => {
  const reading = fromV1({ available: true, phase: 'idle', sampledAt: 1000,
    system: { platform: 'darwin', sampledAt: 1000, cpuPercent: 28.4, memoryUsedGB: 36.1 * 1024 ** 3 / 1e9, memoryTotalGB: 48 * 1024 ** 3 / 1e9,
      macOS: { swapUsedGB: 1.1 * 1024 ** 3 / 1e9, sampledAt: 500 } } });
  const report = measurementReport(reading, reading.host, false, '2.0.0', 2000);
  expect(report).toContain('CPU: 28.4%');
  expect(report).toContain('Non-free RAM: 36.1 GiB');
  expect(report).toContain('Native sample age: 1.5 seconds');
  expect(report).toContain('Swap used: 1.1 GiB');
});

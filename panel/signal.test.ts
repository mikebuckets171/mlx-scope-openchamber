import { expect, test } from 'bun:test';
import { SignalHistory, nextDelay, traceGeometry } from './signal.ts';
import { parseTelemetrySnapshot, unavailableTelemetry } from '../src/telemetry.ts';

const sample = (at: number, overrides: object = {}) => parseTelemetrySnapshot({
  available: true, phase: 'decode', modelID: 'fixture', liveDecodeTPS: 20,
  sampledAt: at, traceEpoch: 1, ...overrides,
});

test('trace retains 90 seconds at two samples per second', () => {
  const history = new SignalHistory();
  for (let at = 0; at <= 100_000; at += 500) history.observe(sample(at));
  expect(history.points.length).toBe(181);
  expect(history.points[0].at).toBe(10_000);
});

test('trace breaks at requests, phases, models, connection loss and elapsed gaps', () => {
  const history = new SignalHistory();
  history.observe(sample(1_000));
  history.observe(sample(1_500));
  history.observe(sample(2_000, { traceEpoch: 2 }));
  history.observe(sample(2_500, { modelID: 'other' }));
  history.observe(sample(3_000, { phase: 'idle' }));
  history.observe(sample(3_500));
  history.observe(unavailableTelemetry('runtime_unreachable', null, 4_000));
  history.observe(sample(4_500));
  history.observe(sample(10_000));
  expect(history.points.map((point) => point.segment)).toEqual([1, 1, 2, 3, 4, 5, 6]);
});

test('chart never stretches two samples across a fictitious 90 seconds', () => {
  const history = new SignalHistory();
  history.observe(sample(99_500)); history.observe(sample(100_000));
  const chart = traceGeometry(history.points, 100_000);
  expect(chart.paths[0]).toMatch(/^M592\.71,/);
  expect(chart.latest?.x).toBe(596);
  expect(chart.upper).toBe(50);
  history.prune(200_000);
  expect(history.points).toHaveLength(0);
});

test('polling is bounded, adaptive, and backs off failures', () => {
  const active = sample(0);
  expect(nextDelay(active.available ? active : null, 0)).toBe(500);
  expect(nextDelay(null, 0)).toBe(2_000);
  expect(nextDelay(null, 10)).toBe(15_000);
});


test('energy-saving history joins its scheduled samples but still breaks real gaps', () => {
  const history = new SignalHistory();
  history.observe(sample(1000), 3000); history.observe(sample(4300), 3000);
  history.observe(sample(7600), 3000); history.observe(sample(14000), 3000);
  expect(history.points.map(point => point.segment)).toEqual([1, 1, 1, 2]);
  expect(traceGeometry(history.points, 14000).paths[0]).toContain('L');
  history.break(); history.observe(sample(15000), 3000);
  expect(history.points.at(-1)?.segment).toBe(3);
});

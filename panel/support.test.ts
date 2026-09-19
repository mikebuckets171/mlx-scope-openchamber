import { expect, test } from 'bun:test';
import { nearestObservation } from './chart-inspector.ts';
import { serviceExplanation } from './connection-help.ts';
import type { SignalPoint } from './signal.ts';

test('chart inspection selects recorded samples, not interpolated speeds', () => {
  const points: SignalPoint[] = [{at: 1000, rate: 20, phase: 'decode', segment: 1}, {at: 8000, rate: 40, phase: 'decode', segment: 2}];
  expect(nearestObservation(points, 2500)).toBe(points[0]!);
  expect(nearestObservation(points, 6000)).toBe(points[1]!);
  expect(nearestObservation(points, -100)).toBe(points[0]!);
  expect(nearestObservation(points, 9000)).toBe(points[1]!);
  expect(nearestObservation([], 1)).toBeNull();
  expect(nearestObservation(points, NaN)).toBeNull();
});
test('service health is distinct from runtime availability', () => {
  expect(serviceExplanation('ready')).toContain('If readings are missing');
  expect(serviceExplanation('starting')).toContain('starting');
  expect(serviceExplanation('stopped')).toContain('stopped');
  expect(serviceExplanation('failed')).toContain('could not start');
});

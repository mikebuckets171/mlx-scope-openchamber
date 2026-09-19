import { expect, test } from 'bun:test';
import { ResourceHistory, toGiB } from './resources.ts';
import { parseSystemSnapshot } from '../src/system.ts';
const sample = (sampledAt: number, extra: object = {}) => parseSystemSnapshot({ platform: 'darwin', sampledAt, cpuPercent: 25, memoryUsedGB: 24, memoryTotalGB: 48, ...extra })!;

test('host trace deduplicates cached timestamps and uses fixed time and percentage axes', () => {
  const history = new ResourceHistory();
  history.observe(sample(98_000)); history.observe(sample(100_000)); history.observe(sample(100_000));
  expect(history.size).toBe(2);
  expect(history.paths('cpu', 100_000)).toBe('M291.42,44.00 L298.00,44.00');
  expect(history.paths('memory', 100_000)).toBe('M291.42,30.00 L298.00,30.00');
});

test('missing values, pause and large gaps break traces instead of drawing zeroes', () => {
  const history = new ResourceHistory();
  history.observe(sample(90_000));
  history.observe(sample(92_000, { cpuPercent: null }));
  history.observe(sample(94_000));
  history.break();
  history.observe(sample(96_000));
  history.observe(sample(104_000));
  expect(history.paths('cpu', 104_000).match(/M/g)).toHaveLength(4);
  expect(history.paths('cpu', 200_000)).toBe('');
});

test('host history is bounded and memory units round-trip correctly', () => {
  const history = new ResourceHistory();
  for (let at = 0; at < 100_000; at += 500) history.observe(sample(at));
  expect(history.size).toBe(100);
  expect(toGiB(48 * 1024 ** 3 / 1e9)).toBe(48);
});

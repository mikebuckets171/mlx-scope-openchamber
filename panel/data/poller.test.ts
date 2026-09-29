import { expect, test } from 'bun:test';
import { Poller, pollDelay } from './poller.ts';

test('coalesces refreshes and never schedules after pause/stop during a request', async () => {
  let resolve!: (delay: number) => void;
  let calls = 0;
  const poller = new Poller(() => { calls += 1; return new Promise((done) => { resolve = done; }); });
  poller.start();
  const first = poller.refresh();
  expect(poller.refresh()).toBe(first);
  poller.setPaused(true);
  await Promise.resolve();
  resolve(1);
  await first;
  await Bun.sleep(10);
  expect(calls).toBe(1);
  poller.setPaused(false);
  await Promise.resolve();
  expect(calls).toBe(2);
  const second = poller.refresh();
  poller.stop();
  resolve(1);
  await second;
  await Bun.sleep(10);
  expect(calls).toBe(2);
});


test('sync exceptions are contained and stopped pollers do not run', async () => {
  let calls = 0;
  const poller = new Poller(() => { calls++; throw Error('sync failure'); });
  await poller.refresh();
  expect(calls).toBe(0);
  poller.start();
  await poller.refresh();
  expect(calls).toBe(1);
  poller.stop();
});

test('a resumed in-flight request remains single flight', async () => {
  let resolve!: (delay: number) => void;
  let calls = 0;
  const poller = new Poller(() => { calls++; return new Promise((done) => { resolve = done; }); });
  poller.start();
  await Promise.resolve();
  poller.setPaused(true);
  poller.setPaused(false);
  const pending = poller.refresh();
  expect(calls).toBe(1);
  resolve(1000);
  await pending;
  poller.stop();
});

test('polling follows the service cadence, backs off failures, and keeps host readings useful', () => {
  const at = (failures: number, nextPollMs: number | null, host = false, efficient = false) => pollDelay({ failures, nextPollMs, host, efficient });
  expect(at(0, 500)).toBe(500);
  expect(at(0, null)).toBe(2_000);
  expect([1, 2, 3, 4, 5, 10].map(failures => at(failures, 500))).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000]);
  expect(at(10, 500, true)).toBe(2_000);
  expect(at(0, 500, false, true)).toBe(3_000);
  expect(at(10, 500, false, true)).toBe(15_000);
});

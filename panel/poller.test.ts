import { expect, test } from 'bun:test';
import { Poller } from './poller.ts';

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

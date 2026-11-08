import { expect, test } from 'bun:test';
import { parseSnapshotV2, type SnapshotV2 } from '../../src/contract/snapshot.ts';
import { MOCK_NOW, mockBody } from '../testing/mock-states.ts';
import { MIN_WAIT_MS, WaitWatch } from './waits.ts';

const at = (seconds: number, memory: number, concurrency = 0, oldestMs?: number, patch: (body: Record<string, any>) => void = () => {}): SnapshotV2 => {
  const now = MOCK_NOW + seconds * 1_000, body = structuredClone(mockBody('splash-decode', { now })) as Record<string, any>;
  body.runtime.server.admission = { waitingMemory: memory, waitingConcurrency: concurrency, ...oldestMs !== undefined ? { oldestWaitMs: oldestMs } : {} };
  body.capabilities['server.admission'] = { scope: 'server', basis: 'reported' };
  patch(body);
  return parseSnapshotV2(body)!;
};

test('one wait: dated by the engine\'s own clock, as long as the longest wait seen, kept when it ends', () => {
  const watch = new WaitWatch();
  expect(watch.observe(at(0, 0))).toBeNull();
  expect(watch.observe(at(10, 1, 0, 6_000))).toBeNull();
  expect(watch.observe(at(11, 1, 0, 7_000))).toBeNull();
  expect(watch.observe(at(29, 1, 0, 25_000))).toBeNull();
  expect(watch.observe(at(30, 0))).toEqual({ kind: 'memory', startedAt: MOCK_NOW + 4_000, waitMs: 25_000, rt: 'splash', model: expect.anything() });
  expect(watch.observe(at(31, 0))).toBeNull();
});

test('back-to-back waiters, concurrency waits, short waits, other connections and stale readings', () => {
  const watch = new WaitWatch();
  watch.observe(at(0, 1, 0, 20_000));
  // The oldest wait dropping means that request started and a newer one is now the oldest.
  expect(watch.observe(at(1, 1, 0, 2_000))).toMatchObject({ kind: 'memory', waitMs: 20_000 });
  expect(watch.observe(at(5, 0))).toMatchObject({ kind: 'memory', startedAt: MOCK_NOW - 1_000, waitMs: 2_000 });
  // A concurrency wait is kept as such; one that also waits for memory becomes a memory wait.
  watch.observe(at(10, 0, 1, 3_000));
  expect(watch.observe(at(14, 0))).toMatchObject({ kind: 'concurrency', waitMs: 3_000 });
  watch.observe(at(20, 0, 1, 2_000)); watch.observe(at(21, 1, 1, 3_000));
  expect(watch.observe(at(22, 0))).toMatchObject({ kind: 'memory' });
  // Shorter than one poll: not kept.
  watch.observe(at(30, 1, 0, MIN_WAIT_MS - 1));
  expect(watch.observe(at(31, 0))).toBeNull();
  // A reading without admission ends nothing; another connection drops the followed wait.
  watch.observe(at(40, 1, 0, 4_000));
  expect(watch.observe(at(41, 0, 0, undefined, body => { delete body.runtime.server.admission; delete body.capabilities['server.admission']; }))).toBeNull();
  expect(watch.observe(at(42, 1, 0, 6_000))).toBeNull();
  expect(watch.observe(at(43, 0, 0, undefined, body => { body.connection.id = 'other-splash'; }))).toBeNull();
  // A stale or recovering engine says nothing about waits.
  watch.observe(at(50, 1, 0, 3_000));
  expect(watch.observe(at(51, 0, 0, undefined, body => { body.status = { state: 'recovering', reason: 'recovering', params: {} }; }))).toBeNull();
  expect(watch.observe(at(52, 0))).toMatchObject({ waitMs: 3_000 });
});

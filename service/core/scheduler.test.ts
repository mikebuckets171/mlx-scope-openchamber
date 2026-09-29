import { expect, test } from 'bun:test';
import { DORMANT_AFTER_MS, FLOOR_MS, nextPollMs, Scheduler, SLOT_CAPACITY, type Outcome, type PollInput } from './scheduler.ts';

type Reading = { ok: boolean; active?: boolean; n: number };
const clock = () => { const state = { now: 1_000 }; return { state, now: () => state.now }; };
const outcome = (value: Reading): Outcome => ({ event: value.ok ? { kind: 'ready' } : { kind: 'failed', reason: 'runtime_unreachable' }, active: value.active ?? false });
const setup = (capacity = SLOT_CAPACITY) => {
  const time = clock(), scheduler = new Scheduler<{ label: string }, Reading>(time.now, capacity);
  let collections = 0, ok = true, active = false;
  const collect = async (): Promise<Reading> => ({ ok, active, n: ++collections });
  return { time, scheduler, collect, s: { get collections() { return collections; }, fail(value: boolean) { ok = !value; }, busy(value: boolean) { active = value; } } };
};

test('views share one in-flight collection and reuse a reading younger than the cadence', async () => {
  const { time, scheduler, collect, s } = setup();
  const slot = scheduler.claim('a', 'f', () => ({ label: 'a' }))!;
  const readings = await Promise.all(Array.from({ length: 8 }, () => scheduler.read(slot, 2_000, collect, outcome)));
  expect(readings.every(reading => reading.n === 1)).toBe(true);
  time.state.now += 1_999; await scheduler.read(slot, 2_000, collect, outcome);
  expect(s.collections).toBe(1);
  time.state.now += 1; expect((await scheduler.read(slot, 2_000, collect, outcome)).n).toBe(2);
});

test('no runtime is read more often than the 450 ms floor', async () => {
  const { time, scheduler, collect, s } = setup();
  const slot = scheduler.claim('a', 'f', () => ({ label: 'a' }))!;
  await scheduler.read(slot, 10, collect, outcome);
  time.state.now += FLOOR_MS - 1; await scheduler.read(slot, 10, collect, outcome);
  expect(s.collections).toBe(1);
  time.state.now += 1; await scheduler.read(slot, 10, collect, outcome);
  expect(s.collections).toBe(2);
});

test('failed collections back off min(8 s, 0.5 s · 2ⁿ) and a success clears it', async () => {
  const { time, scheduler, collect, s } = setup();
  const slot = scheduler.claim('a', 'f', () => ({ label: 'a' }))!;
  s.fail(true);
  // A view polling every 50 ms: collections happen only when the backoff has passed.
  const collectedAt: number[] = [];
  while (collectedAt.length < 7) {
    const before = s.collections;
    await scheduler.read(slot, 450, collect, outcome);
    if (s.collections > before) collectedAt.push(time.state.now);
    time.state.now += 50;
  }
  expect(collectedAt.slice(1).map((at, index) => at - collectedAt[index]!)).toEqual([1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
  expect(slot.state).toMatchObject({ kind: 'failing', failures: 7 });
  s.fail(false);
  time.state.now = collectedAt.at(-1)! + 8_000; await scheduler.read(slot, 450, collect, outcome);
  expect(slot.state.kind).toBe('ready');
  const healthy = s.collections;
  time.state.now += 450; await scheduler.read(slot, 450, collect, outcome);
  expect(s.collections).toBe(healthy + 1);
});

test('each slot remembers when it last saw work', async () => {
  const { time, scheduler, collect, s } = setup();
  const slot = scheduler.claim('a', 'f', () => ({ label: 'a' }))!;
  expect(slot.activeAt).toBe(1_000);
  s.busy(true); time.state.now = 5_000; await scheduler.read(slot, 450, collect, outcome);
  expect(slot.activeAt).toBe(5_000);
  s.busy(false); time.state.now = 9_000; await scheduler.read(slot, 450, collect, outcome);
  expect(slot.activeAt).toBe(5_000);
});

test('a new fingerprint replaces its slot with a new generation, but never while a read is in flight', async () => {
  const { scheduler } = setup();
  const first = scheduler.claim('a', 'f1', () => ({ label: 'first' }))!;
  expect(scheduler.claim('a', 'f1', () => ({ label: 'unused' }))).toBe(first);
  let release!: (value: Reading) => void;
  const pending = scheduler.read(first, 450, () => new Promise<Reading>(resolve => { release = resolve; }), outcome);
  expect(scheduler.claim('a', 'f2', () => ({ label: 'second' }))).toBeNull();
  release({ ok: true, n: 1 }); await pending;
  const second = scheduler.claim('a', 'f2', () => ({ label: 'second' }))!;
  expect([second.context.label, second.generation > first.generation, second.marker !== first.marker]).toEqual(['second', true, true]);
  expect(second.marker).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('at most 8 slots: the oldest idle slot is evicted, and a table of in-flight reads refuses a ninth', async () => {
  const { scheduler } = setup();
  const releases: Array<() => void> = [];
  const slots = Array.from({ length: SLOT_CAPACITY }, (_, index) => scheduler.claim(`k${index}`, 'f', () => ({ label: `k${index}` }))!);
  const pending = slots.map(slot => scheduler.read(slot, 450, () => new Promise<Reading>(resolve => { releases.push(() => resolve({ ok: true, n: 0 })); }), outcome));
  expect(scheduler.claim('k8', 'f', () => ({ label: 'k8' }))).toBeNull();
  releases.forEach(release => release()); await Promise.all(pending);
  expect(scheduler.claim('k8', 'f', () => ({ label: 'k8' }))).not.toBeNull();
  // k0 was the oldest; claiming it again creates a new slot rather than finding the old one.
  const again = scheduler.claim('k0', 'f', () => ({ label: 'k0 again' }))!;
  expect(again.context.label).toBe('k0 again');
  expect(scheduler.claim('k2', 'f', () => ({ label: 'unused' }))!.context.label).toBe('k2');
});

const poll = (input: Partial<PollInput>) => nextPollMs({ active: false, idleMs: 0, failures: 0, hostLive: true, yielded: false, ...input });
test('frames poll per plan §4.3: 500 ms / 2 s for panel and page, 1 s / 3 s / 10 s for status', () => {
  expect([poll({ active: true }), poll({}), poll({ surface: 'page', active: true }), poll({ surface: 'panel', idleMs: DORMANT_AFTER_MS })]).toEqual([500, 2_000, 500, 2_000]);
  expect([poll({ surface: 'status', active: true }), poll({ surface: 'status' }), poll({ surface: 'status', idleMs: DORMANT_AFTER_MS - 1 }),
    poll({ surface: 'status', idleMs: DORMANT_AFTER_MS }), poll({ surface: 'background' })]).toEqual([1_000, 3_000, 3_000, 10_000, 3_000]);
});

test('a failing runtime backs off, but host readings keep the idle cadence', () => {
  expect([1, 2, 3, 4, 9].map(failures => poll({ failures, hostLive: false }))).toEqual([1_000, 2_000, 4_000, 8_000, 8_000]);
  expect([1, 2, 3, 4].map(failures => poll({ failures }))).toEqual([1_000, 2_000, 2_000, 2_000]);
  expect([1, 2, 3].map(failures => poll({ surface: 'status', failures }))).toEqual([1_000, 2_000, 3_000]);
});

test('a frame below a visible higher-priority leader polls at most every 10 s', () => {
  expect([poll({ yielded: true, active: true }), poll({ surface: 'status', yielded: true, idleMs: DORMANT_AFTER_MS }), poll({ yielded: true, failures: 9, hostLive: false })])
    .toEqual([10_000, 10_000, 10_000]);
});

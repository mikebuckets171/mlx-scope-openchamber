import { expect, test } from 'bun:test';
import { ActivityTrack, STREAM_GAP_MS } from './coverage.ts';
import { body, T0, type BodyOptions } from './testing.ts';

// Readings every 500 ms from 0 to 10 s, with `active` from the table (ms → count).
const track = (active: (ms: number) => number | null = () => 1, every = 500, until = 10_000, options: Partial<BodyOptions> = {}) => {
  const activity = new ActivityTrack();
  for (let ms = 0; ms <= until; ms += every) activity.observe(body({ at: T0 + ms, active: active(ms), ...options }), T0 + ms);
  return activity;
};

test('an unbroken stretch covers any span inside it; the stretch must begin at or before the span', () => {
  const activity = track();
  expect(activity.covered(T0, T0 + 10_000)).toBe(true);
  expect(activity.covered(T0 + 1_250, T0 + 8_100)).toBe(true);
  expect(activity.covered(T0 - 1, T0 + 5_000)).toBe(false);
  expect(activity.covered(T0 + 5_000, T0 + 10_001)).toBe(false);
  expect(activity.latest()).toBe(T0 + 10_000);
});

test('a gap longer than 2.5× the cadence is a segment break; the frame’s own slower cadence raises the bar', () => {
  const activity = new ActivityTrack();
  for (const ms of [0, 500, 1_000, 2_300, 2_800]) activity.observe(body({ at: T0 + ms, active: 1 }), T0 + ms);
  expect(activity.covered(T0, T0 + 1_000)).toBe(true);
  expect(activity.covered(T0, T0 + 2_800)).toBe(false);      // 1.3 s > 2.5 × 500 ms
  expect(activity.covered(T0 + 2_300, T0 + 2_800)).toBe(true);
  const slow = new ActivityTrack();
  for (const ms of [0, 3_000, 6_000]) slow.observe(body({ at: T0 + ms, active: 1 }), T0 + ms, 3_000);   // energy saving
  expect(slow.covered(T0, T0 + 6_000)).toBe(true);
});

test('a failed poll, an unavailable runtime, a hide, or another connection or instance breaks the stretch', () => {
  const cases: Array<(activity: ActivityTrack) => void> = [
    activity => activity.observe(null, T0 + 1_100),
    activity => activity.observe(body({ at: T0 + 1_100, state: 'failing' }), T0 + 1_100),
    activity => activity.break(T0 + 1_100),
    activity => activity.observe(body({ at: T0 + 1_100, connection: 'other' }), T0 + 1_100),
    activity => activity.observe(body({ at: T0 + 1_100, instance: '0a1b2c3d' }), T0 + 1_100),
    activity => activity.observe(body({ at: T0 + 1_100, generation: 2 }), T0 + 1_100),
  ];
  for (const interrupt of cases) {
    const activity = new ActivityTrack();
    for (const ms of [0, 500, 1_000]) activity.observe(body({ at: T0 + ms, active: 1 }), T0 + ms);
    interrupt(activity);
    for (const ms of [1_500, 2_000]) activity.observe(body({ at: T0 + ms, active: 1 }), T0 + ms);
    expect(activity.covered(T0, T0 + 2_000)).toBe(false);
    expect(activity.covered(T0 + 1_500, T0 + 2_000)).toBe(true);
  }
});

test('cached readings are one sample, and a reading older than the newest is ignored', () => {
  const activity = new ActivityTrack();
  activity.observe(body({ at: T0, active: 1 }), T0);
  activity.observe(body({ at: T0, active: 1 }), T0 + 400);     // the scheduler's cache: same sampledAt
  activity.observe(body({ at: T0 - 200, active: 2 }), T0 + 450);
  expect(activity.activeMax(T0 - 1_000, T0 + 1_000)).toBe(1);
  activity.observe(null, T0 + 600);
  activity.observe(body({ at: T0 + 550, active: 1 }), T0 + 700);   // older than the break: dropped
  expect(activity.latest()).toBe(T0 + 600);
});

test('a healthy event stream covers gaps up to its idle-stop', () => {
  const stream = new ActivityTrack();
  for (const ms of [0, 30_000, 30_000 + STREAM_GAP_MS]) stream.observe(body({ at: T0 + ms, active: 1, stream: true }), T0 + ms);
  expect(stream.covered(T0, T0 + 30_000 + STREAM_GAP_MS)).toBe(true);
  stream.observe(body({ at: T0 + 30_001 + 2 * STREAM_GAP_MS, active: 1, stream: true }), T0);
  expect(stream.covered(T0, T0 + 30_001 + 2 * STREAM_GAP_MS)).toBe(false);
  const polled = new ActivityTrack();
  for (const ms of [0, 30_000]) polled.observe(body({ at: T0 + ms, active: 1 }), T0 + ms);
  expect(polled.covered(T0, T0 + 30_000)).toBe(false);
});

test('activeMax reads only usable readings in the span; one that cannot count makes it unknown', () => {
  const activity = track(ms => ms === 4_000 ? 2 : 1);
  expect(activity.activeMax(T0, T0 + 3_900)).toBe(1);
  expect(activity.activeMax(T0 + 3_000, T0 + 5_000)).toBe(2);
  expect(activity.activeMax(T0 + 20_000, T0 + 30_000)).toBe(0);
  expect(track(ms => ms === 4_000 ? null : 1).activeMax(T0, T0 + 10_000)).toBeNull();
});

test('idleBefore finds the last idle reading before a request that reported no start', () => {
  const activity = track(ms => ms < 2_000 || ms > 7_000 ? 0 : 1);
  expect(activity.idleBefore(T0 + 7_200)).toBe(T0 + 1_500);
  expect(activity.idleBefore(T0 + 1_000)).toBe(T0 + 500);
  expect(track(() => 1).idleBefore(T0 + 5_000)).toBeNull();
  expect(track(ms => ms === 1_000 ? null : 1).idleBefore(T0 + 5_000)).toBeNull();
});

test('memory stays bounded', () => {
  const activity = track(() => 1, 100, 1_000_000);
  expect(activity.covered(T0, T0 + 1_000)).toBe(false);        // the oldest readings are gone
  expect(activity.covered(T0 + 999_000, T0 + 1_000_000)).toBe(true);
});

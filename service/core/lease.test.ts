import { expect, test } from 'bun:test';
import { Lease, LEASE_FRAMES, LEASE_TTL_MS } from './lease.ts';

test('page > panel > status, with an epoch per handover', () => {
  const lease = new Lease();
  expect(lease.observe('0000000a', 'status', 0)).toEqual({ leader: true, epoch: 1, ttlMs: LEASE_TTL_MS, leaderSurface: 'status', yielded: false });
  expect(lease.observe('0000000b', 'panel', 100)).toMatchObject({ leader: true, epoch: 2, leaderSurface: 'panel' });
  expect(lease.observe('0000000a', 'status', 200)).toMatchObject({ leader: false, epoch: 2, leaderSurface: 'panel', yielded: true });
  expect(lease.observe('0000000c', 'page', 300)).toMatchObject({ leader: true, epoch: 3, leaderSurface: 'page' });
  expect(lease.observe('0000000b', 'panel', 400)).toMatchObject({ leader: false, yielded: true });
});

test('the leader keeps the lease against an equal surface', () => {
  const lease = new Lease();
  lease.observe('0000000a', 'panel', 0);
  expect(lease.observe('0000000b', 'panel', 10)).toMatchObject({ leader: false, epoch: 1, yielded: false });
  expect(lease.observe('0000000a', 'panel', 20)).toMatchObject({ leader: true, epoch: 1 });
});

test('a leader that stops polling for the TTL hands over to the next visible frame', () => {
  const lease = new Lease();
  lease.observe('0000000c', 'page', 0);
  lease.observe('0000000a', 'status', 1_000);
  lease.observe('0000000b', 'panel', 2_000);
  expect(lease.observe('0000000a', 'status', LEASE_TTL_MS - 1)).toMatchObject({ leader: false, leaderSurface: 'page' });
  // The page expired; the panel, seen within its TTL, outranks the status frame.
  expect(lease.observe('0000000a', 'status', LEASE_TTL_MS)).toMatchObject({ leader: false, epoch: 2, leaderSurface: 'panel', yielded: true });
  expect(lease.observe('0000000a', 'status', 2_000 + LEASE_TTL_MS)).toMatchObject({ leader: true, epoch: 3, leaderSurface: 'status' });
  // Nobody polls: the lease is empty, and the epoch waits for the next leader.
  expect(lease.observe(undefined, undefined, 60_000)).toEqual({ leader: false, epoch: 3, ttlMs: LEASE_TTL_MS, leaderSurface: null, yielded: false });
  expect(lease.observe('0000000b', 'panel', 60_001)).toMatchObject({ leader: true, epoch: 4 });
});

test('background frames and frameless requests never lead', () => {
  const lease = new Lease();
  expect(lease.observe('0000000a', 'background', 0)).toMatchObject({ leader: false, leaderSurface: null, yielded: false });
  expect(lease.observe(undefined, 'page', 0)).toMatchObject({ leader: false, leaderSurface: null });
  expect(lease.observe('0000000b', undefined, 0)).toMatchObject({ leader: false, leaderSurface: null });
  lease.observe('0000000c', 'panel', 5_000);
  // A frameless status request cannot lead, but still backs off below a visible panel.
  expect(lease.observe(undefined, 'status', 5_001)).toMatchObject({ leader: false, leaderSurface: 'panel', yielded: true });
  // Entries from a clock ahead of the current one are dropped rather than held forever.
  expect(lease.observe('0000000d', 'status', 1_000)).toMatchObject({ leader: true, leaderSurface: 'status' });
});

test('the frame table is bounded and never evicts the leader', () => {
  const lease = new Lease();
  lease.observe('0000000f', 'page', 0);
  for (let index = 0; index < LEASE_FRAMES * 3; index += 1) lease.observe(index.toString(16).padStart(8, '0'), 'status', 1 + index);
  expect(lease.observe('0000000f', 'page', 100)).toMatchObject({ leader: true, epoch: 1 });
  expect((lease as unknown as { frames: Map<string, unknown> }).frames.size).toBeLessThanOrEqual(LEASE_FRAMES);
});

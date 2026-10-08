import { expect, test } from 'bun:test';
import type { ChatMeasurement } from '../../src/contract/chat.ts';
import { unread } from '../server.ts';
import { composeSnapshot, snapshotPollMs, type ComposeInput } from './compose.ts';

const NOW = 1_790_690_700_000;
const chat: ChatMeasurement = { scope: 'chat', basis: 'estimated-characters', timingBasis: 'delivery-window', phase: 'generating',
  tokensPerSecond: 24, observedAtMs: NOW, expiresAtMs: NOW + 5_000,
  observation: { startedAtMs: NOW - 3_000, endedAtMs: NOW }, freshness: 'live' };
const input = (): ComposeInput => {
  const reading = unread(NOW); reading.status = { state: 'ready', reason: null, params: {} }; reading.runtime.phase = 'idle'; reading.meta.idleMs = 600_000;
  return { reading, host: null, completions: { instance: '01234567', cursor: 0, reset: false, items: [] },
    alerts: { alerts: [], alertLog: [] }, service: { version: '3.0.0-test', instance: '01234567' }, serverNow: NOW,
    lease: { leader: true, epoch: 1, ttlMs: 12_000, leaderSurface: 'status', yielded: false }, marksHead: 0, query: { surface: 'status' } };
};

test('a live chat brings an otherwise dormant engine to the active presentation cadence', () => {
  const value = input();
  expect(snapshotPollMs(value)).toBe(10_000);
  for (const phase of ['waiting', 'generating', 'reasoning', 'tool'] as const) {
    const live = { ...value, chat: { ...chat, phase, tokensPerSecond: phase === 'generating' || phase === 'reasoning' ? chat.tokensPerSecond : undefined } };
    expect(snapshotPollMs(live), phase).toBe(1_000);
    expect(snapshotPollMs({ ...live, query: { surface: 'panel' } })).toBe(500);
  }
});

test('a busy selected chat starts active cadence before its first companion observation without bypassing yield or failure backoff', () => {
  const value = input(), starting: ComposeInput = { ...value, chat: null, query: { surface: 'status', chatBusy: true } };
  expect(snapshotPollMs(starting)).toBe(1_000);
  expect(snapshotPollMs({ ...starting, query: { surface: 'panel', chatBusy: true } })).toBe(500);
  expect(snapshotPollMs({ ...starting, query: { surface: 'page', chatBusy: true } })).toBe(500);
  expect(snapshotPollMs({ ...starting, lease: { ...value.lease, leader: false, leaderSurface: 'page', yielded: true } })).toBe(10_000);
  const failed = { ...starting, reading: { ...value.reading, meta: { ...value.reading.meta, failures: 3 } } };
  expect(snapshotPollMs(failed)).toBe(snapshotPollMs({ ...failed, query: { surface: 'status' } }));
  const body = composeSnapshot(starting);
  expect(body.nextPollMs).toBe(1_000); expect(body.chat).toBeUndefined(); expect(body.runtime.phase).toBe('idle');
  expect(snapshotPollMs(value)).toBe(10_000);
});

test('completed or cancelled chat readings do not accelerate an idle engine; lower-priority frames still yield', () => {
  const value = input();
  expect(snapshotPollMs({ ...value, chat: { ...chat, phase: 'cancelled', tokensPerSecond: undefined } })).toBe(10_000);
  const complete: ChatMeasurement = { ...chat, phase: 'complete', freshness: 'last', timingBasis: 'completed-step', basis: 'reported-output' };
  expect(snapshotPollMs({ ...value, chat: complete })).toBe(10_000);
  expect(snapshotPollMs({ ...value, chat, lease: { ...value.lease, leader: false, leaderSurface: 'page', yielded: true } })).toBe(10_000);
});

test('snapshot composition preserves the independent chat basis without fabricating engine rates', () => {
  const value = input(), snapshot = composeSnapshot({ ...value, chat });
  expect(snapshot.chat).toEqual(chat);
  expect(snapshot.runtime.phase).toBe('idle'); expect(snapshot.runtime.server.rates).toBeUndefined();
  expect(snapshot.capabilities['server.rates']).toBeUndefined(); expect(snapshot.nextPollMs).toBe(1_000);
  expect(composeSnapshot(value).chat).toBeUndefined();
});

import { expect, test } from 'bun:test';
import type { ChatMeasurement } from '../../src/contract/chat.ts';
import { parseSnapshotV2 } from '../../src/contract/snapshot.ts';
import { mockBody, MOCK_STATES } from '../../panel/testing/mock-states.ts';
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

test('completed or cancelled chat readings do not accelerate an idle engine', () => {
  const value = input();
  expect(snapshotPollMs({ ...value, chat: { ...chat, phase: 'cancelled', tokensPerSecond: undefined } })).toBe(10_000);
  const complete: ChatMeasurement = { ...chat, phase: 'complete', freshness: 'last', timingBasis: 'completed-step', basis: 'reported-output' };
  expect(snapshotPollMs({ ...value, chat: complete })).toBe(10_000);
});

test('validated live chat observations keep visible followers current while another page holds the lease', () => {
  const value = input(), lease = { ...value.lease, leader: false, leaderSurface: 'page' as const, yielded: true };
  for (const phase of ['waiting', 'generating', 'reasoning', 'tool'] as const) {
    const observed = { ...chat, phase, tokensPerSecond: phase === 'generating' || phase === 'reasoning' ? chat.tokensPerSecond : undefined };
    for (const [surface, cadence] of [['status', 1_000], ['panel', 500], ['page', 500]] as const) {
      const current = { ...value, lease, chat: observed, query: { surface } };
      expect(snapshotPollMs(current), `${surface}: ${phase}`).toBe(cadence);
      const snapshot = composeSnapshot(current);
      expect(snapshot.lease).toMatchObject({ leader: false, leaderSurface: 'page' });
      expect(snapshot.chat).toEqual(observed);
      expect(snapshot.nextPollMs).toBe(cadence);
    }
  }
});

test('absence, expiry, future timestamps, invalid measurements and background frames never bypass presentation yield', () => {
  const value = input(), lease = { ...value.lease, leader: false, leaderSurface: 'page' as const, yielded: true };
  for (const observed of [null, { ...chat, expiresAtMs: NOW }, { ...chat, observedAtMs: NOW + 1 },
    { ...chat, observation: { startedAtMs: NOW - 1_000, endedAtMs: NOW } },
    { ...chat, phase: 'cancelled' as const, tokensPerSecond: undefined },
    { ...chat, phase: 'complete' as const, freshness: 'last' as const, timingBasis: 'completed-step' as const, basis: 'reported-output' as const }]) {
    expect(snapshotPollMs({ ...value, lease, chat: observed })).toBe(10_000);
  }
  expect(snapshotPollMs({ ...value, lease, chat, serverNow: chat.expiresAtMs })).toBe(10_000);
  expect(snapshotPollMs({ ...value, lease, chat, query: { surface: 'background' } })).toBe(10_000);
});

test('live chat presentation keeps runtime failure backoff intact', () => {
  const value = input(), lease = { ...value.lease, leader: false, leaderSurface: 'page' as const, yielded: true };
  for (const surface of ['status', 'panel', 'page'] as const) {
    const current = { ...value, lease, chat, query: { surface }, reading: { ...value.reading, meta: { ...value.reading.meta, failures: 4 } } };
    expect(snapshotPollMs(current)).toBe(8_000);
  }
});

test('snapshot composition preserves the independent chat basis without fabricating engine rates', () => {
  const value = input(), snapshot = composeSnapshot({ ...value, chat });
  expect(snapshot.chat).toEqual(chat);
  expect(snapshot.runtime.phase).toBe('idle'); expect(snapshot.runtime.server.rates).toBeUndefined();
  expect(snapshot.capabilities['server.rates']).toBeUndefined(); expect(snapshot.nextPollMs).toBe(1_000);
  expect(composeSnapshot(value).chat).toBeUndefined();
});

/** Freeze and collect every input object: parsing must rebuild nested facts, arrays and capability entries too. */
const freezeGraph = (value: unknown, objects = new Set<object>()): Set<object> => {
  if (value && typeof value === 'object' && !objects.has(value)) {
    objects.add(value);
    for (const child of Object.values(value)) freezeGraph(child, objects);
    Object.freeze(value);
  }
  return objects;
};

test('composition preserves every fixture wire body while rebuilding frozen inputs without shared objects', () => {
  for (const state of MOCK_STATES) {
    const wire = parseSnapshotV2(mockBody(state, { now: NOW }))!;
    const reading = unread(NOW), sampledAt = wire.runtime.sampledAt ?? NOW;
    const value: ComposeInput = {
      ...input(), reading: { ...reading, at: sampledAt, status: wire.status, runtime: wire.runtime,
        capabilities: wire.capabilities, meta: { ...reading.meta, connection: wire.connection } },
      host: wire.host, completions: wire.completions, alerts: { alerts: wire.alerts, alertLog: wire.alertLog },
      service: wire.service, serverNow: wire.serverNow, lease: { ...wire.lease, yielded: false },
      marksHead: wire.marksHead, nextPollMs: wire.nextPollMs, chat: wire.chat,
    };
    const before = JSON.stringify(value), inputs = freezeGraph(value), actual = composeSnapshot(value);
    // The old JSON normalization path produces this same detached, capability-gated wire shape.
    const expected = parseSnapshotV2(JSON.parse(JSON.stringify({ ...wire, runtime: { ...wire.runtime, sampledAt } })));
    expect(expected, state).not.toBeNull();
    expect(actual, state).toEqual(expected!);
    const outputs = freezeGraph(actual);
    expect([...outputs].some(object => inputs.has(object)), state).toBe(false);
    expect(JSON.stringify(value), state).toBe(before);
  }
});

test('composition sanitizes optional non-JSON values without mutating the reading and rejects forbidden keys', () => {
  const value = input();
  value.reading.runtime.request = { model: null, decodeTps: NaN, prefillTps: Infinity, outputTokens: undefined, ttftMs: -Infinity };
  value.reading.runtime.memory = { processBytes: undefined, modelBytes: NaN, metalBytes: Infinity };
  value.reading.capabilities = { 'request.decodeRate': { scope: 'request', basis: 'reported' },
    'request.prefillRate': { scope: 'request', basis: 'reported' }, 'request.ttft': { scope: 'request', basis: 'reported' } };
  const expected = composeSnapshot(JSON.parse(JSON.stringify(value)) as ComposeInput);
  freezeGraph(value);
  expect(composeSnapshot(value)).toEqual(expected);
  expect(value.reading.runtime.request.decodeTps).toBeNaN();
  expect(value.reading.runtime.memory.metalBytes).toBe(Infinity);
  for (const forbidden of ['private value', undefined, NaN]) {
    const invalid = input();
    Object.assign(invalid.reading.runtime.memory, { secret: forbidden });
    expect(() => composeSnapshot(invalid)).toThrow('The reading could not form a v2 snapshot.');
  }
});

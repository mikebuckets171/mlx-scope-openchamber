import { expect, test } from 'bun:test';
import { parseSnapshotV2, type SnapshotV2 } from '../../src/contract/snapshot.ts';
import { engineMarkup } from '../render/views/engine.ts';
import { MOCK_NOW, mockBody } from '../testing/mock-states.ts';
import { presentEngine } from './engine.ts';
import type { ScopeInput } from './scope.ts';

const GiB = 2 ** 30;
const chat = (patch: Record<string, unknown> = {}) => ({ scope: 'chat', basis: 'estimated-characters', timingBasis: 'delivery-window',
  phase: 'generating', tokensPerSecond: 47.6, observedAtMs: MOCK_NOW, expiresAtMs: MOCK_NOW + 5_000,
  observation: { startedAtMs: MOCK_NOW - 3_000, endedAtMs: MOCK_NOW }, freshness: 'live', ...patch });
/** A Splash 1.6 snapshot shaped like the live read of Nov 7 evening. */
const body = (patch: (raw: Record<string, any>) => void = () => {}): SnapshotV2 => {
  const raw = structuredClone(mockBody('splash-decode', { now: MOCK_NOW })) as Record<string, any>;
  raw.runtime.memory.room = { limitBytes: 40_802_189_312, headroomBytes: 3_251_042_736, hostSpareBytes: 3_027_517_440, hostSpareReserveBytes: 3_607_772_525,
    hostHeadroomBytes: 0, deniedReservations: 152, experts: { total: 24_576, resident: 12_889 },
    accounts: [{ name: 'fixed', currentBytes: 8_763_769_664, capBytes: 8_763_769_664 }, { name: 'kv', currentBytes: 4_238_868_480, capBytes: 4_238_868_480 },
      { name: 'states', currentBytes: 395_247_616, capBytes: 395_247_616 }, { name: 'experts', currentBytes: 24_153_260_816, capBytes: 24_153_260_816 },
      { name: 'hot_kv', currentBytes: 0, capBytes: 408_944_640 }] };
  raw.runtime.server.batches = { single: 19_786, multi: 0 };
  raw.runtime.server.speculative = { draftedTokens: 52_169, acceptedTokens: 27_861, acceptanceFraction: 0.534053, windowMs: 600_000 };
  raw.host.apps = { sampledAt: MOCK_NOW - 4_000, items: [{ name: 'Exampleapps', bytes: 2_418_016_256 }, { name: 'opencode', bytes: 1_504_706_560 }] };
  for (const [key, scope, basis] of [['server.memory.room', 'server', 'reported'], ['server.batches', 'server', 'reported'], ['server.speculative', 'server', 'derived'],
    ['host.apps', 'host', 'reported']] as const) raw.capabilities[key] = { scope, basis };
  patch(raw);
  return parseSnapshotV2(raw)!;
};
const input = (snapshot: SnapshotV2 | null, extra: Partial<ScopeInput> = {}): ScopeInput => ({ now: MOCK_NOW, version: '5.5.0', snapshot, fresh: true,
  frame: null, paused: false, attribution: { kind: 'inferred' }, chatRuntime: null, last: null, samples: [], turnStartAt: null, ...extra });

test('the budget is drawn from Splash\'s own accounts, experts first, with the room left as free', () => {
  const view = presentEngine(input(body()))!;
  expect(view.budget).toMatchObject({ used: '35.0 GiB', limit: '38.0 GiB', free: '3.0 GiB' });
  expect(view.budget!.segments.map(segment => [segment.label, (segment.bytes / GiB).toFixed(1)])).toEqual([
    ['Experts', '22.5'], ['Fixed runtime', '8.2'], ['KV cache', '3.9'], ['States', '0.4'], ['Free', '3.0']]);
  expect(view.budget!.segments.reduce((sum, segment) => sum + segment.fraction, 0)).toBeCloseTo(1, 6);
  expect(view.tiles).toEqual([
    { key: 'experts', label: 'Experts in memory', value: '12,889 of 24,576', detail: '52% of the model’s experts', fraction: 12_889 / 24_576 },
    { key: 'batches', label: 'Decode batches with two or more chats', value: '0 of 19,786', detail: '0% since the engine started' },
    { key: 'draft', label: 'Draft tokens kept', value: '53%', detail: '27,861 of 52,169 · last 10 min' }]);
});

test('the gate says whether another chat could start, and the apps holding the memory follow it', () => {
  const view = presentEngine(input(body()))!;
  expect(view.gate).toEqual({ open: false, text: 'Closed', detail: '0.5 GiB short of the 3.4 GiB it keeps spare',
    denied: 'It has refused 152 memory requests since it started.' });
  expect(view.apps!.rows.map(row => [row.name, row.size])).toEqual([['Exampleapps', '2.3 GiB'], ['opencode', '1.4 GiB']]);
  expect(view.apps!.rows[1]!.fraction).toBeCloseTo(1_504_706_560 / 2_418_016_256, 6);
  const markup = engineMarkup(view).markup;
  for (const text of ['Room for another chat', 'Closed', 'Holding the most memory', 'Exampleapps', 'Experts in memory', '12,889 of 24,576', 'Splash · from server'])
    expect(markup).toContain(text);
  expect(markup).not.toMatch(/4242|4243/);
});

test('lanes: this chat by its own phase, every other request the engine counts as an anonymous lane, nothing guessed', () => {
  const two = (patch: (raw: Record<string, any>) => void) => presentEngine(input(body(raw => { raw.chat = chat(); patch(raw); }), { chatActivity: 'busy', chatIsLocal: true }))!.lanes;
  // This chat generating while another request waits for memory.
  expect(two(raw => { raw.runtime.server.active = 1; raw.runtime.server.queued = 1;
    raw.runtime.server.admission = { waitingMemory: 1, waitingConcurrency: 0, oldestWaitMs: 18_400 }; raw.capabilities['server.admission'] = { scope: 'server', basis: 'reported' }; }))
    .toEqual({ summary: '1 working · 1 waiting', rows: [
      { key: 'mine', who: 'This chat', mine: true, phase: 'Generating · 47.6 tok/s', tone: 'active' },
      { key: 'held-0', who: 'Another chat', mine: false, phase: 'Waiting for memory · 18 s', tone: 'waiting' }] });
  // This chat is the one held; the other request runs.
  expect(two(raw => { raw.chat = chat({ phase: 'waiting', tokensPerSecond: undefined }); raw.runtime.server.active = 1; raw.runtime.server.queued = 1;
    raw.runtime.server.admission = { waitingMemory: 1, waitingConcurrency: 0, oldestWaitMs: 9_000 }; raw.capabilities['server.admission'] = { scope: 'server', basis: 'reported' }; }).rows)
    .toEqual([{ key: 'mine', who: 'This chat', mine: true, phase: 'Waiting for memory · 9 s', tone: 'waiting' },
      { key: 'active-0', who: 'Another chat', mine: false, phase: 'Generating', tone: 'active' }]);
  // A cloud chat is never one of the engine's lanes.
  const cloud = presentEngine(input(body(raw => { raw.chat = chat(); raw.runtime.server.active = 1; }), { chatActivity: 'busy', chatIsLocal: false }))!.lanes;
  expect(cloud.rows).toEqual([{ key: 'active-0', who: 'Another chat', mine: false, phase: 'Generating', tone: 'active' }]);
  // Idle.
  expect(presentEngine(input(body(raw => { raw.runtime.server.active = 0; raw.runtime.server.queued = 0; raw.runtime.phase = 'idle'; })))!.lanes)
    .toEqual({ summary: 'Idle', rows: [] });
});

test('without Splash\'s memory report the room says why instead of drawing zeros', () => {
  const plain = parseSnapshotV2(mockBody('splash-decode', { now: MOCK_NOW }))!;
  expect(presentEngine(input(plain))!.empty).toBe('Waiting for Splash’s memory report. The Engine room needs Splash 1.6 or later.');
  const omlx = parseSnapshotV2(mockBody('decode', { now: MOCK_NOW }))!;
  expect(presentEngine(input(omlx))!.empty).toMatch(/^The Engine room reads Splash’s memory report; .+ doesn’t send one\.$/);
  expect(presentEngine(input(null))).toBeNull();
  expect(engineMarkup(null).markup).toContain('Waiting for the first reading.');
  // A stale body says so.
  expect(presentEngine(input(body(), { fresh: false }))!.stamp).toBe('Splash · last reading');
});

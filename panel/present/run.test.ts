import { expect, test } from 'bun:test';
import { parseSnapshotV2 } from '../../src/contract/snapshot.ts';
import { reply, turn } from '../testing/rows.ts';
import { MOCK_NOW, MOCK_STATES, mockBody } from '../testing/mock-states.ts';
import { compareRuns, comparableRuns, presentCurrentRun, presentRecordedRun } from './run.ts';
import { SERVER_WIDE, type ScopeInput } from './scope.ts';

const input = (state = 'decode', extra: Partial<ScopeInput> = {}): ScopeInput => ({ now: MOCK_NOW, version: 'fixture',
  snapshot: parseSnapshotV2(mockBody(state))!, fresh: true, paused: false, frame: null, attribution: SERVER_WIDE,
  chatRuntime: null, last: null, next: { kind: 'idle' }, samples: [], turnStartAt: null, chatIsLocal: true, ...extra });

test('recorded detail shows stored facts, partial basis and co-factors without inventing a timeline', () => {
  const view = presentRecordedRun(reply({ at: MOCK_NOW, basis: 'last-observed', decodeTps: 20, output: 100, ttftMs: 200,
    cofactors: 1 | 2 | 4 | 8 }), ['Synthetic model'], MOCK_NOW);
  expect(view.facts.find(fact => fact.label === 'First token')).toBeUndefined();
  expect(view.facts.find(fact => fact.label === 'Observed output')).toMatchObject({ value: '100 tokens', basis: 'last-observed' });
  expect(view.notes.join(' ')).toContain('completion and final counts were not confirmed');
  expect(view.notes.join(' ')).toContain('memory pressure, swap growth, thermal pressure');
  expect(view.notes.join(' ')).toContain('do not establish the cause');
  expect(view.notes.join(' ')).toContain('per-reply comparisons are unavailable');
  expect(view.facts.some(fact => /duration|queue/i.test(fact.label))).toBe(false);
});

test('a turn remainder is explicitly outside observed engine intervals, not exact tool time', () => {
  const view = presentRecordedRun(turn(MOCK_NOW - 5000, MOCK_NOW, { waitMs: 2000 }), [], MOCK_NOW);
  expect(view.facts.find(fact => fact.label === 'Time outside engine intervals')?.value).toBe('2.0 s');
  expect(view.notes.join(' ')).toContain('not exact tool execution time');
});

test('recorded turns never assign a basis to first-token time that was stored without one', () => {
  for (const firstTtftMs of [null, 0, 200]) {
    const view = presentRecordedRun(turn(MOCK_NOW - 5000, MOCK_NOW, { firstTtftMs }), [], MOCK_NOW);
    expect(view.facts.some(fact => fact.label === 'First token')).toBe(false);
    expect(view.notes.includes('First-token time withheld: its measurement basis was not stored.')).toBe(firstTtftMs !== null);
  }
  const replyView = presentRecordedRun(reply({ at: MOCK_NOW, ttftMs: 200, basis: 'reported' }), [], MOCK_NOW);
  expect(replyView.facts.find(fact => fact.label === 'First token')).toMatchObject({ basis: 'reported' });
});

test('comparison qualifies each metric by model, runtime, basis and its own size bucket', () => {
  const a = reply({ at: MOCK_NOW, decodeTps: 30, ttftMs: 200, prefillTps: 300, output: 1000, energyJ: 10 });
  const b = reply({ at: MOCK_NOW - 1000, decodeTps: 20, ttftMs: 400, prefillTps: 150, output: 1000, energyJ: 20 });
  expect(compareRuns(a, b).map(metric => metric.change)).toEqual(['+50%', '+100%', '−50%', '+100%']);
  const differentContext = [...b] as typeof b; differentContext[4] = 0;
  expect(compareRuns(a, differentContext).map(metric => metric.label)).toEqual(['Prefill speed', 'First token']);
  for (const patch of [{ modelRef: 1 }, { rt: 'lmstudio' as const }, { basis: 'estimate' as const },
    { basis: 'derived' as const }, { cofactors: 8 }, { cofactors: 16 }, { modelRef: null }]) {
    expect(compareRuns(a, reply({ at: MOCK_NOW - 1000, decodeTps: 20, ...patch }))).toEqual([]);
  }
  expect(compareRuns(a, a)).toEqual([]);
});

test('reference choices stay bounded and exclude unsupported comparisons', () => {
  const a = reply({ at: MOCK_NOW, decodeTps: 30 });
  const rows = Array.from({ length: 40 }, (_, i) => reply({ at: MOCK_NOW - (i + 1) * 1000, decodeTps: 20 }));
  const candidates = comparableRuns(a, [a, ...rows, reply({ at: MOCK_NOW, decodeTps: 20, basis: 'estimate' })]);
  expect(candidates).toHaveLength(24);
  expect(candidates[0]).toBe(rows[0]);
});

test('current detail reuses Now truth gates across states and never leaks local engine facts into a cloud chat', () => {
  for (const state of MOCK_STATES) {
    const view = presentCurrentRun(input(state));
    expect(view.facts.length + view.notes.length).toBeGreaterThan(0);
    expect(JSON.stringify(view)).not.toContain('NaN');
    const cloud = presentCurrentRun(input(state, { chatIsLocal: false, sessionModel: 'Cloud fixture' }));
    expect(cloud.facts.some(fact => fact.scope === 'Engine')).toBe(false);
    expect(cloud.identity).not.toContain('Example-');
  }
  for (const extra of [{ fresh: false }, { paused: true }]) {
    expect(presentCurrentRun(input('decode', extra)).facts.some(fact => fact.scope === 'Engine')).toBe(false);
  }
});

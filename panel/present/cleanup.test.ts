import { expect, test } from 'bun:test';
import { parseSnapshotV2 } from '../../src/contract/snapshot.ts';
import { MOCK_NOW, mockBody } from '../testing/mock-states.ts';
import { presentLive } from './live.ts';
import { presentStatusSection } from './status.ts';
import { fromSnapshot } from './reading.ts';
import type { ScopeInput } from './scope.ts';
import { statusHeight, statusMarkup } from '../render/views/status.ts';

const fixture = (patch: (body: any) => void = () => {}): ScopeInput => {
  const body = structuredClone(mockBody('decode'));
  patch(body);
  const snapshot = parseSnapshotV2(body)!;
  expect(snapshot).not.toBeNull();
  return { now: MOCK_NOW, version: '2.1.1', snapshot, fresh: true, frame: null, paused: false,
    attribution: { kind: 'inferred' }, chatRuntime: null, last: null, next: { kind: 'idle' }, samples: [], turnStartAt: null };
};
const status = (input: ScopeInput, extra = {}) => presentStatusSection({ now: input.now, reading: fromSnapshot(input.snapshot!), snapshot: input.snapshot,
  fresh: true, attribution: input.attribution, turn: null, vsUsual: null, sparkline: null,
  chatIsLocal: true, expanded: false, tipDismissed: true, last: input.last, ...extra });

test('first-token provenance is independent of token-count capability and omitted when unsupported', () => {
  const input = fixture(body => {
    body.capabilities['request.ttft'] = { scope: 'request', basis: 'observed' };
    body.runtime.request.ttftMs = 420;
    delete body.capabilities['request.tokens'];
    body.runtime.request.promptTokens = null;
    body.runtime.request.cachedTokens = null;
    body.runtime.request.outputTokens = null;
  });
  expect(presentLive(input).hero?.firstToken).toEqual({ text: 'First token', strong: '0.42 s', basis: 'observed' });
  expect(status(input).glance?.metrics).toContainEqual({ label: 'First token', value: '0.42 s', basis: 'measured' });
  expect(presentLive(fixture()).hero?.firstToken).toBeNull();
});

test('current and last-reply timings never substitute for one another', () => {
  const input = fixture();
  const completion = structuredClone(input.snapshot!.completions.items.at(-1)!);
  completion.ttftMs = 840; completion.basis = 'reported';
  input.last = { completion, label: { kind: 'inferred' }, vsUsual: null, flag: null };
  expect(presentLive(input).hero?.firstToken).toBeNull();
  expect(presentLive(input).hero?.reply?.values).toContainEqual({ text: 'First token', strong: '0.84 s', basis: 'reported' });
  expect(status(input).glance?.metrics?.some(row => row.label === 'First token')).toBe(false);
  input.snapshot!.runtime.phase = 'idle'; input.snapshot!.runtime.request = null;
  const idle = status(input);
  expect(idle.glance?.line1.word).toBe('Last reply');
  expect(idle.glance?.line1.since).toBeTruthy();
  expect(idle.glance?.metrics).toContainEqual({ label: 'First token', value: '0.84 s', basis: null });
  expect(statusMarkup(idle).markup).not.toContain('Chart starts');
});

test('a prior response is never combined with a different model context limit', () => {
  const input = fixture();
  const completion = structuredClone(input.snapshot!.completions.items.at(-1)!);
  completion.model = 'another-model';
  input.last = { completion, label: { kind: 'server-wide', reason: 'model-differs' }, vsUsual: null, flag: null };
  expect(status(input, { expanded: true }).rows.map(row => row.label)).not.toContain('Context used');
});

test('a withheld Next reply result stays server-wide without a chat turn summary', () => {
  const input = fixture();
  const completion = structuredClone(input.snapshot!.completions.items.at(-1)!);
  completion.verdict = { attr: 'withheld', reason: 'overlap', at: input.now };
  input.next = { kind: 'result', startedAt: input.now - 20_000, endedAt: input.now - 1_000,
    steps: [completion], attributed: false, summary: null };
  const withheld = presentLive(input).hero!.reply!;
  expect(withheld.chip).toMatchObject({ attr: 'server', text: 'All server activity · several requests at once' });
  expect(withheld.split).toEqual([]);
  expect(withheld.tip?.paras.join(' ')).toContain('no turn summary');
  expect(withheld.values.some(value => value.unit === 'tok/s')).toBe(true);

  completion.verdict = { attr: 'armed', at: input.now };
  input.next.attributed = true;
  const armed = presentLive(input).hero!.reply!;
  expect(armed.chip).toMatchObject({ attr: 'armed', text: 'Next reply' });
  expect(armed.split.some(value => value.text === 'Turn')).toBe(true);

  input.next.attributed = false;
  input.next.steps = [];
  expect(presentLive(input).hero!.reply!.chip).toMatchObject({ attr: 'server', text: 'All server activity · not recorded' });
});

test('supported glance metrics and warnings stay within the status section height budget', () => {
  const input = fixture(body => { body.capabilities['request.ttft'] = { scope: 'request', basis: 'reported' }; body.runtime.request.ttftMs = 420; });
  input.snapshot!.alerts = parseSnapshotV2(mockBody('pressure'))!.alerts;
  input.attribution = { kind: 'server-wide', reason: 'overlap' };
  for (const tipDismissed of [true, false]) {
    const view = status(input, { tipDismissed });
    expect(statusHeight(view)).toBeLessThanOrEqual(200);
    expect(view.glance?.metrics?.map(row => row.label)).toEqual(['First token', 'Context used']);
    expect(view.glance?.line2).toMatchObject({ kind: 'spark', reason: 'several requests at once' });
    expect(view.glance?.alert?.severity).toBe('warning');
    expect(view.glance?.notice).toBeNull();
    const toggles = statusMarkup(view).markup.match(/id="ws-toggle"/g) ?? [];
    expect(toggles.length).toBeLessThanOrEqual(1);
  }
  const pressured = structuredClone(mockBody('pressure'));
  input.snapshot = parseSnapshotV2(pressured)!;
  const completion = input.snapshot.completions.items.at(-1)!;
  input.last = { completion, label: { kind: 'inferred' }, vsUsual: null, flag: null };
  const expanded = status(input, { expanded: true });
  expect(expanded.turn?.sub).toBeTruthy();
  expect(expanded.turn?.alert?.text).toContain('memory pressure');
  expect(statusMarkup(expanded).markup).toContain('ws-alert-row');
  expect(statusHeight(expanded)).toBeLessThanOrEqual(200);
});

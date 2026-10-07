import { expect, test } from 'bun:test';
import { parseSnapshotV2 } from '../../src/contract/snapshot.ts';
import { sessionMarkup } from '../render/views/session.ts';
import { esc } from '../render/html.ts';
import { MOCK_NOW, MOCK_STATES, mockBody } from '../testing/mock-states.ts';
import { fromSnapshot } from './reading.ts';
import { presentSessionSection } from './session.ts';
import { SERVER_WIDE } from './scope.ts';
import type { StatusSectionInput } from './status.ts';

const inputOf = (state: string, extra: Partial<StatusSectionInput> = {}, patch: (body: Record<string, any>) => void = () => {}): StatusSectionInput => {
  const body = structuredClone(mockBody(state)); patch(body);
  const snapshot = parseSnapshotV2(body)!;
  const completion = snapshot.completions.items.at(-1);
  return { now: MOCK_NOW, reading: fromSnapshot(snapshot), snapshot, attribution: SERVER_WIDE,
    turn: null, vsUsual: null, sparkline: null, chatIsLocal: true, expanded: true, tipDismissed: false,
    firstRun: true, firstRunDismissed: false, fresh: true,
    last: completion ? { completion, label: SERVER_WIDE } : null, ...extra };
};

test('Session leads with current performance despite a remembered expanded preference and older reply', () => {
  const input = inputOf('decode'), view = presentSessionSection(input), markup = sessionMarkup(view).markup;
  expect(view).toMatchObject({ mode: 'summary', phase: 'Generating', value: { text: '26.4', unit: 'tok/s', basis: 'reported' },
    scope: { text: 'All server activity', attr: 'server' }, age: null });
  expect(markup).toContain('Open MLX Scope');
  expect(markup).not.toMatch(/status-toggle|ts-rows|ws-spark|ws-key-stats|class="chip|Recording reply history|Replace Turn stats/);
  expect(markup).not.toContain('Last reply');
});

test.each(['processing', 'queued', 'decode'] as const)('current %s without speed uses current attribution instead of an older inferred reply', phase => {
  const input = inputOf('decode', { attribution: { kind: 'server-wide', reason: 'overlap' } }, body => {
    body.runtime.phase = phase; body.runtime.request.decodeTps = null;
  });
  input.last = { completion: input.last!.completion, label: { kind: 'inferred' } };
  const view = presentSessionSection(input);
  expect(view.value).toBeNull();
  expect(view.age).toBeNull();
  expect(view.scope).toEqual({ text: 'All server activity', detail: 'several requests at once', attr: 'server' });
  expect(view.phase).not.toBe('Last reply');
  expect(sessionMarkup(view).markup).not.toContain('Likely this chat');
});

test('an idle reply without measured speed keeps current idle state and warning visible', () => {
  const input = inputOf('pressure', {}, body => {
    body.runtime.phase = 'idle'; body.runtime.request = null; body.runtime.server.active = 0;
    body.completions.items = [{ seq: 57, finishedAt: MOCK_NOW - 120_000, startedAt: MOCK_NOW - 125_000,
      model: 'Example-27B-4bit', basis: 'reported', overlapped: false, host: {} }];
  });
  const view = presentSessionSection(input), markup = sessionMarkup(view).markup;
  expect(view).toMatchObject({ phase: 'Idle', value: null, age: null,
    alert: { label: 'Memory pressure', value: 'Warning', severity: 'warning' } });
  expect(markup).toContain('Memory pressure');
  expect(markup).not.toMatch(/Last reply|no turn summary|class="chip|ws-dot|ws-severity/);
  expect(markup).toContain('>All server activity</span>');
});

test('an idle instrument does not promote the measured last reply into a current speed', () => {
  const view = presentSessionSection(inputOf('idle'));
  expect(view.phase).toBe('Idle');
  expect(view.value).toBeNull();
  expect(view.age).toBeNull();
  expect(view.speeds.speeds.every(speed => speed.value === null)).toBe(true);
  expect(sessionMarkup(view).markup).not.toContain('tok/s');
});

test('critical memory pressure retains semantic severity in the compact summary', () => {
  const view = presentSessionSection(inputOf('pressure-critical'));
  expect(view.alert).toMatchObject({ label: 'Memory pressure', value: 'Critical', severity: 'critical' });
  const markup = sessionMarkup(view).markup;
  expect(markup).toContain('data-severity="critical">Critical');
  expect(view.height).toBeLessThanOrEqual(200);
});

test('the alert summary counts additional warnings even when their old chips are omitted', () => {
  const view = presentSessionSection(inputOf('pressure', {}, body => {
    body.alerts = [{ id: 'pressure-warning', severity: 'warning', since: MOCK_NOW - 1_000, params: { level: 2 }, badge: true },
      { id: 'thermal', severity: 'warning', since: MOCK_NOW - 2_000, params: { level: 2 }, badge: true }];
    body.host.thermal = { ...body.host.thermal, level: 2 };
  }));
  expect(view.alert).toMatchObject({ label: 'Memory pressure', severity: 'warning', value: 'Warning', more: 1 });
  expect(sessionMarkup(view).markup).toContain('+1 more');
});

test('an active next-reply measurement remains labelled and cancellable in Session', () => {
  const armed = presentSessionSection(inputOf('idle', { next: { kind: 'armed', at: MOCK_NOW - 12_000 } }));
  expect(armed).toMatchObject({ phase: 'Idle', age: null, cancelMeasurement: true, scope: { text: 'Next reply', attr: 'armed' } });
  expect(armed.note).toMatch(/^Waiting for your next reply/);
  expect(sessionMarkup(armed).markup).toContain('data-action="next-cancel">Cancel measurement');
  const measuring = presentSessionSection(inputOf('decode', { next: { kind: 'measuring', startedAt: MOCK_NOW - 9_000, steps: [] } }));
  expect(measuring).toMatchObject({ phase: 'Generating', age: null, cancelMeasurement: true,
    value: { text: '26.4' }, scope: { text: 'Next reply', attr: 'armed' }, note: 'Measuring next reply · 9.0 s' });
});

test('retained readings never appear as live speed and freshness can recover', () => {
  const input = inputOf('decode'), retained = presentSessionSection({ ...input, fresh: false });
  expect(retained).toMatchObject({ phase: 'Waiting for update', value: null, age: null, tone: 'warning' });
  expect(sessionMarkup(retained).markup).not.toContain('tok/s');
  expect(presentSessionSection({ ...input, fresh: true }).value?.text).toBe('26.4');
});

test('prefill and generation keep distinct current readings and attribution', () => {
  const view = presentSessionSection(inputOf('prefill', { attribution: { kind: 'inferred' } }));
  expect(view.phase).toBe('Reading prompt');
  expect(view.speeds.speeds[0]).toMatchObject({ label: 'Prefill speed', value: '185', basis: 'reported' });
  expect(view.speeds.speeds[1]).toMatchObject({ label: 'Generation speed', value: null, detail: 'No text being generated' });
  expect(view.scope?.text).toBe('Likely this chat');
  expect(presentSessionSection(inputOf('prefill')).speeds.speeds[0].value).toBe('185');
});

test('Splash current rates are independently derived and server-wide', () => {
  const view = presentSessionSection(inputOf('splash-mixed'));
  expect(view).toMatchObject({ phase: 'Reading and generating', scope: { text: 'All server activity', detail: 'all requests', attr: 'server' } });
  expect(view.speeds.speeds).toMatchObject([{ value: '612', detail: 'Calculated · last 3.2 s' }, { value: '43.8', detail: 'Calculated · last 4.0 s' }]);
  expect(sessionMarkup(view).markup).not.toContain('47.2');
  expect(presentSessionSection(inputOf('splash-stale')).value).toBeNull();
  const collecting = presentSessionSection(inputOf('splash-prefill-waiting'));
  expect(collecting.speeds.speeds[0]).toMatchObject({ value: null, detail: 'Measuring…' });
  expect(sessionMarkup(collecting).markup).not.toContain('fresh output');
});

test('Energy saving explains an absent active recent speed without hiding a valid reading', () => {
  const waiting = presentSessionSection(inputOf('splash-prefill-waiting', { efficient: true }));
  expect(waiting.note).toBe('Turn off Energy saving to see speeds');
  expect(sessionMarkup(waiting).markup).toContain('Energy saving is on');
  expect(presentSessionSection(inputOf('splash-prefill', { efficient: true })).note).toBeNull();
});

test('a cloud chat shows a single neutral row without local readings or a details action', () => {
  const view = presentSessionSection(inputOf('pressure', { chatIsLocal: false }));
  expect(view).toMatchObject({ mode: 'non-local', height: 24, phase: 'This chat is not using a local model',
    tone: 'normal', value: null, model: null, scope: null, alert: null });
  expect(sessionMarkup(view).markup).not.toMatch(/Open MLX Scope|Memory pressure|tok\/s/);
});

test('the Session summary preserves and escapes the full model name while using a short visible name', () => {
  const hostile = 'example-org/a-long-model-name-27B-4bit<image>"\'&';
  const view = presentSessionSection(inputOf('decode', {}, body => { body.runtime.request.model = hostile; }));
  expect(view.modelTitle).toBe(hostile);
  expect(view.model).not.toBeNull();
  const markup = sessionMarkup(view).markup;
  expect(markup).toContain(`title="${esc(hostile)}"`);
  expect(markup).not.toContain('<image>');
});

test('every fixture renders a bounded Session summary without raw placeholders or nested statistics', () => {
  for (const state of MOCK_STATES) {
    const view = presentSessionSection(inputOf(state)), markup = sessionMarkup(view).markup;
    expect(view.height, state).toBeLessThanOrEqual(200);
    expect(view.height, state).toBeGreaterThanOrEqual(24);
    expect(markup, state).not.toMatch(/undefined|NaN|\[object|status-toggle|ts-rows|ws-spark|ws-key-stats|class="chip/);
  }
});

test.each(['recovering', 'degraded'] as const)('a retained prefill phase does not replace %s status', state => {
  const input = inputOf('splash-prefill', {}, body => { body.status.state = state; body.status.reason = state === 'recovering' ? 'recovering' : 'status_stale'; });
  const view = presentSessionSection(input);
  expect(view.phase).not.toBe('Reading prompt');
  expect(view.speeds.speeds.every(speed => speed.value === null)).toBe(true);
});

test('prefill progress uses actual supported counts and never rounds unfinished work to100%', () => {
  const input = inputOf('prefill');
  expect(presentSessionSection(input).progress.text).toBe('64%');
  input.snapshot!.runtime.request!.prefillFraction = .999;
  expect(presentSessionSection(input).progress.text).toBe('>99%');
  input.snapshot!.runtime.request!.prefillFraction = 1;
  expect(presentSessionSection(input).progress.text).toBe('100%');
  expect(presentSessionSection({ ...input, fresh: false }).progress.text).toBe('Updating…');
  expect(presentSessionSection(inputOf('splash-prefill')).progress.text).toBe('Unavailable');
});

test('Splash shows reported whole-prompt counts separately from its independently measured speed', () => {
  const view = presentSessionSection(inputOf('splash-progress'));
  expect(view.progress).toMatchObject({ text: '64%', detail: 'Prompt read · 3840 of 6000 tokens', basis: 'reported' });
  expect(view.speeds.speeds[0]).toMatchObject({ value: '612', basis: 'derived' });
  expect(presentSessionSection(inputOf('splash-progress-held')).progress.text).toBe('64% (last seen)');
  expect(presentSessionSection(inputOf('splash-progress', { paused: true })).progress.text).toBe('Paused');
  const unsupported = inputOf('splash-progress'); delete unsupported.snapshot!.capabilities['request.prefillProgress'];
  expect(presentSessionSection(unsupported).progress.text).toBe('Unavailable');
});

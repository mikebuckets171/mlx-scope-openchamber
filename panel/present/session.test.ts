import { expect, test } from 'bun:test';
import { parseSnapshotV2 } from '../../src/contract/snapshot.ts';
import { sessionMarkup } from '../render/views/session.ts';
import { liveMarkup } from '../render/views/live.ts';
import { esc } from '../render/html.ts';
import { MOCK_NOW, MOCK_STATES, mockBody } from '../testing/mock-states.ts';
import { fromSnapshot } from './reading.ts';
import { presentSessionSection } from './session.ts';
import { presentLive } from './live.ts';
import { SERVER_WIDE } from './scope.ts';
import type { StatusSectionInput } from './status.ts';
import type { ChatMeasurement } from '../../src/contract/chat.ts';

const inputOf = (state: string, extra: Partial<StatusSectionInput> = {}, patch: (body: Record<string, any>) => void = () => {}): StatusSectionInput => {
  const body = structuredClone(mockBody(state)); patch(body);
  const snapshot = parseSnapshotV2(body)!;
  const completion = snapshot.completions.items.at(-1);
  return { now: MOCK_NOW, reading: fromSnapshot(snapshot), snapshot, attribution: SERVER_WIDE,
    turn: null, vsUsual: null, sparkline: null, chatIsLocal: true, expanded: true, tipDismissed: false,
    firstRun: true, firstRunDismissed: false, fresh: true,
    last: completion ? { completion, label: SERVER_WIDE } : null, ...extra };
};

test('a retained completed chat average remains labeled and never supplies a live reading', () => {
  const lastChat: ChatMeasurement = { scope: 'chat', phase: 'complete', freshness: 'last', basis: 'reported-output',
    timingBasis: 'completed-step', tokensPerSecond: 35, observedAtMs: MOCK_NOW - 60_000, expiresAtMs: MOCK_NOW - 45_000,
    observation: { startedAtMs: MOCK_NOW - 62_000, endedAtMs: MOCK_NOW - 60_000 } };
  const input = inputOf('idle', { lastChat, chatActivity: 'idle', chatIsLocal: true, last: null });
  expect(presentSessionSection(input)).toMatchObject({ phase: 'Complete', measurement: { label: 'Last chat · avg.', live: false,
    text: '35.0', result: { label: 'Last chat result', durationMs: 2_000, timing: 'step' } } });
  for (const extra of [{ chatActivity: 'busy' as const }, { paused: true }, { fresh: false }, { measurementScope: 'engine' as const }]) {
    expect(presentSessionSection({ ...input, ...extra }).measurement?.label).not.toBe('Last chat · avg.');
  }
  expect(presentSessionSection({ ...input, lastChat: { ...lastChat, freshness: 'live' } }).measurement).toBeNull();
  const current = { ...lastChat, observedAtMs: MOCK_NOW, expiresAtMs: MOCK_NOW + 15_000 };
  const busy = { ...input, chatActivity: 'busy' as const, snapshot: { ...input.snapshot!, chat: current } };
  expect(presentSessionSection(busy)).toMatchObject({ phase: 'Waiting', measurement: null });
});

test('native completed facts belong to the exact last average and omit unknown duration', () => {
  const input = inputOf('idle', { chatActivity: 'idle' });
  input.last = { label: SERVER_WIDE, completion: { seq: 42, finishedAt: MOCK_NOW - 1_000, startedAt: MOCK_NOW - 4_000,
    model: 'fixture', basis: 'reported', decodeTps: 30, outputTokens: 90, ttftMs: 120, overlapped: false, host: {} } };
  expect(presentSessionSection(input).measurement?.result).toEqual({ label: 'Last engine result', timing: 'request',
    outputTokens: 90, ttftMs: 120, durationMs: 3_000 });
  input.last.completion.startedAt = null;
  expect(presentSessionSection(input).measurement?.result).not.toHaveProperty('durationMs');
});

test('a stored native verdict labels this chat only inside its currently selected window', () => {
  const input = inputOf('idle', { chatActivity: 'idle', window: { tag: '00000000',
    startedAt: MOCK_NOW - 5_000, endedAt: MOCK_NOW, outcome: 'completed' } });
  input.last = { label: { kind: 'inferred' }, completion: { seq: 42, finishedAt: MOCK_NOW - 1_000, startedAt: MOCK_NOW - 4_000,
    model: 'fixture', basis: 'reported', decodeTps: 30, outputTokens: 90, overlapped: false, host: {} } };
  expect(presentSessionSection(input).measurement?.label).toBe('Last chat · matched · avg.');
  for (const window of [null, { ...input.window!, startedAt: MOCK_NOW - 500 },
    { ...input.window!, endedAt: MOCK_NOW - 2_000 }, { ...input.window!, startedAt: null }]) {
    expect(presentSessionSection({ ...input, window }).measurement?.label).toBe('Last engine · avg.');
  }
  expect(presentSessionSection({ ...input, window: { ...input.window!, startedAt: null, joinedAt: MOCK_NOW - 5_000 } }).measurement?.label)
    .toBe('Last chat · matched · avg.');
  input.last.completion.startedAt = null;
  expect(presentSessionSection(input).measurement?.label).toBe('Last engine · avg.');
});

test('Session leads with current performance despite a remembered expanded preference and older reply', () => {
  const input = inputOf('decode'), view = presentSessionSection(input), markup = sessionMarkup(view).markup;
  expect(view).toMatchObject({ phase: 'Generating', measurement: { text: '26.4', unit: 'tok/s', basis: 'reported' },
    measurementScope: 'chat' });
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
  expect(view.measurement).toBeNull();
  expect(view.support).toBeNull();
  expect(view.measurementScope).toBe('chat');
  expect(view.phase).not.toBe('Last reply');
  expect(sessionMarkup(view).markup).not.toContain('Chat · matched · prompt');
});

test('an idle reply without measured speed keeps current idle state and warning visible', () => {
  const input = inputOf('pressure', {}, body => {
    body.runtime.phase = 'idle'; body.runtime.request = null; body.runtime.server.active = 0;
    body.completions.items = [{ seq: 57, finishedAt: MOCK_NOW - 120_000, startedAt: MOCK_NOW - 125_000,
      model: 'Example-27B-4bit', basis: 'reported', overlapped: false, host: {} }];
  });
  const view = presentSessionSection(input), markup = sessionMarkup(view).markup;
  expect(view).toMatchObject({ phase: 'Idle', measurement: null,
    alert: { label: 'Memory pressure · warning', value: '', severity: 'warning' } });
  expect(markup).toContain('Memory pressure');
  expect(markup).not.toMatch(/Last reply|no turn summary|class="chip|ws-dot|ws-severity/);
  expect(markup).not.toContain('ws-measurement');
});

test('an idle instrument does not promote the measured last reply into a current speed', () => {
  const view = presentSessionSection(inputOf('idle'));
  expect(view.phase).toBe('Idle');
  expect(view.measurement).toBeNull();
  expect(view.support).toBeNull();
  expect(view.speeds.speeds.every(speed => speed.value === null)).toBe(true);
  expect(sessionMarkup(view).markup).not.toContain('tok/s');
});

test('critical memory pressure retains semantic severity in the compact summary', () => {
  const view = presentSessionSection(inputOf('pressure-critical'));
  expect(view.alert).toMatchObject({ label: 'Memory pressure · critical', value: '', severity: 'critical' });
  const markup = sessionMarkup(view).markup;
  expect(markup).toContain('data-severity="critical"');
});

test('the sidebar shows only the priority warning and keeps secondary alerts in full details', () => {
  const view = presentSessionSection(inputOf('pressure', {}, body => {
    body.alerts = [{ id: 'pressure-warning', severity: 'warning', since: MOCK_NOW - 1_000, params: { level: 2 }, badge: true },
      { id: 'thermal', severity: 'warning', since: MOCK_NOW - 2_000, params: { level: 2 }, badge: true }];
    body.host.thermal = { ...body.host.thermal, level: 2 };
  }));
  expect(view.alert).toMatchObject({ label: 'Memory pressure · warning', severity: 'warning', value: '', more: 0 });
  expect(sessionMarkup(view).markup).not.toMatch(/\+1 more|Heat:/);
});

test('an active next-reply measurement remains labelled and cancellable in Session', () => {
  const armed = presentSessionSection(inputOf('idle', { next: { kind: 'armed', at: MOCK_NOW - 12_000 } }));
  expect(armed).toMatchObject({ phase: 'Idle', cancelMeasurement: true });
  expect(armed.note).toMatch(/^Next reply armed/);
  expect(sessionMarkup(armed).markup).toContain('data-action="next-cancel">Cancel');
  const measuring = presentSessionSection(inputOf('decode', { next: { kind: 'measuring', startedAt: MOCK_NOW - 9_000, steps: [] } }));
  expect(measuring).toMatchObject({ phase: 'Generating', cancelMeasurement: true,
    measurement: { text: '26.4' }, note: 'Recording reply · 9.0 s' });
});

test('retained readings never appear as live speed and freshness can recover', () => {
  const input = inputOf('decode'), retained = presentSessionSection({ ...input, fresh: false });
  expect(retained).toMatchObject({ phase: 'Waiting for update', measurement: null, tone: 'warning' });
  expect(sessionMarkup(retained).markup).not.toContain('tok/s');
  expect(presentSessionSection({ ...input, fresh: true }).measurement?.text).toBe('26.4');
});

test('prefill and generation keep distinct current readings and attribution', () => {
  const view = presentSessionSection(inputOf('prefill', { attribution: { kind: 'inferred' } }));
  expect(view.phase).toBe('Reading prompt');
  expect(view.speeds.speeds[0]).toMatchObject({ label: 'Prefill speed', value: '185', basis: 'reported' });
  expect(view.speeds.speeds[1]).toMatchObject({ label: 'Generation speed', value: null, detail: 'No text being generated' });
  expect(view.measurement?.label).toBe('Chat · matched · prompt');
  expect(presentSessionSection(inputOf('prefill')).speeds.speeds[0].value).toBe('185');
});

test('Splash current rates are independently derived and server-wide', () => {
  const view = presentSessionSection(inputOf('splash-mixed'));
  expect(view).toMatchObject({ phase: 'Reading and generating', measurement: { label: 'Engine' } });
  expect(view.speeds.speeds).toMatchObject([{ value: '612', detail: 'Calculated · last 3.2 s' }, { value: '43.8', detail: 'Calculated · last 4.0 s' }]);
  expect(sessionMarkup(view).markup).not.toContain('47.2');
  expect(presentSessionSection(inputOf('splash-stale')).measurement).toBeNull();
  const collecting = presentSessionSection(inputOf('splash-prefill-waiting'));
  expect(collecting.speeds.speeds[0]).toMatchObject({ value: null, detail: 'Measuring…' });
  expect(sessionMarkup(collecting).markup).not.toContain('fresh output');
});

test('Energy saving explains an absent active recent speed without hiding a valid reading', () => {
  const waiting = presentSessionSection(inputOf('splash-prefill-waiting', { efficient: true }));
  expect(waiting.note).toBe('Energy saving is on');
  expect(sessionMarkup(waiting).markup).toContain('Energy saving is on');
  expect(presentSessionSection(inputOf('splash-prefill', { efficient: true })).note).toBeNull();
});

test('a cloud chat stays quiet without borrowing engine measurements or local warnings', () => {
  const view = presentSessionSection(inputOf('pressure', { chatIsLocal: false }));
  expect(view).toMatchObject({ phase: 'Ready', note: null,
    tone: 'normal', measurement: null, alert: null, cancelMeasurement: false });
  expect(sessionMarkup(view).markup).not.toMatch(/Memory pressure|tok\/s|ws-model/);
  expect(sessionMarkup(view).markup).toContain('Open MLX Scope');
});

test('Session does not repeat the host model in its visible instrument', () => {
  const hostile = 'example-org/a-long-model-name-27B-4bit<image>"\'&';
  const view = presentSessionSection(inputOf('decode', {}, body => { body.runtime.request.model = hostile; }));
  const markup = sessionMarkup(view).markup;
  expect(markup).not.toContain(esc(hostile));
  expect(markup).not.toContain('class="ws-model"');
  expect(markup).not.toContain('<image>');
});

test('every fixture renders a bounded Session summary without raw placeholders or nested statistics', () => {
  for (const state of MOCK_STATES) {
    const view = presentSessionSection(inputOf(state)), markup = sessionMarkup(view).markup;
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
  expect(presentSessionSection(input).progress?.text).toBe('64%');
  input.snapshot!.runtime.request!.prefillFraction = .999;
  expect(presentSessionSection(input).progress?.text).toBe('>99%');
  input.snapshot!.runtime.request!.prefillFraction = 1;
  expect(presentSessionSection(input).progress?.text).toBe('100%');
  expect(presentSessionSection({ ...input, fresh: false }).progress).toBeNull();
  expect(presentSessionSection(inputOf('splash-prefill')).progress).toBeNull();
});

test('Splash shows reported whole-prompt counts separately from its independently measured speed', () => {
  const view = presentSessionSection(inputOf('splash-progress'));
  expect(view.progress).toMatchObject({ text: '64%', detail: 'Prompt read · 3840 of 6000 tokens', basis: 'reported' });
  expect(view.speeds.speeds[0]).toMatchObject({ value: '612', basis: 'derived' });
  expect(presentSessionSection(inputOf('splash-progress-held')).measurement).toMatchObject({
    text: '64%', label: 'Engine · prompt · last seen', live: false,
  });
  expect(presentSessionSection(inputOf('splash-progress', { paused: true })).progress).toBeNull();
  const unsupported = inputOf('splash-progress'); delete unsupported.snapshot!.capabilities['request.prefillProgress'];
  expect(presentSessionSection(unsupported).progress).toBeNull();
});

const chatSample = (patch: Record<string, unknown> = {}) => ({ scope: 'chat', basis: 'estimated-characters', timingBasis: 'delivery-window',
  phase: 'generating', tokensPerSecond: 19.2, observedAtMs: MOCK_NOW, expiresAtMs: MOCK_NOW + 5_000,
  observation: { startedAtMs: MOCK_NOW - 3_000, endedAtMs: MOCK_NOW }, freshness: 'live', ...patch });

test('activity changes retain Session structure while withholding absent readings', () => {
  const views = ['generating', 'reasoning', 'tool', 'waiting', 'complete', 'cancelled'].map(phase =>
    presentSessionSection(inputOf('decode', {}, body => {
      body.chat = chatSample({ phase, tokensPerSecond: ['generating', 'reasoning'].includes(phase) ? 19.2 : undefined });
    })));
  for (const view of views) {
    const markup = sessionMarkup(view).markup;
    expect(markup).toContain('<div class="ws-activity">');
    expect(markup).not.toContain('>—<');
    expect(markup.includes('ws-measurement'), view.phase).toBe(view.measurement !== null);
  }
  const stale = presentSessionSection(inputOf('decode', { fresh: false }));
  expect(stale.measurement).toBeNull();
});

test('measurement preference chooses matched runtime, chat estimate, and explicit engine fallback in that order', () => {
  const input = inputOf('decode', { attribution: { kind: 'inferred' } }, body => { body.chat = chatSample(); });
  expect(presentSessionSection(input).measurement).toMatchObject({ label: 'Chat · matched', text: '26.4', basis: 'reported' });
  input.attribution = { kind: 'server-wide', reason: 'overlap' };
  expect(presentSessionSection(input).measurement).toMatchObject({ label: 'Chat · est.', text: '19.2', basis: 'estimate' });
  expect(presentSessionSection({ ...input, measurementScope: 'engine' }).measurement).toMatchObject({ label: 'Engine', text: '26.4', basis: 'reported' });
  input.snapshot!.chat = null;
  expect(presentSessionSection(input).measurement).toMatchObject({ label: 'Engine', text: '26.4' });
});

test('reasoning delivery stays explicitly estimated after calibration and cannot borrow another request’s prefill', () => {
  const input = inputOf('prefill', {}, body => { body.chat = chatSample({ phase: 'reasoning', basis: 'calibrated-characters', calibrationSteps: 3 }); });
  const view = presentSessionSection(input);
  expect(view.phase).toBe('Reasoning');
  expect(view.progress).toBeNull();
  expect(view.measurement).toMatchObject({ label: 'Chat · est.', text: '19.2', basis: 'estimate' });
  expect(view.measurement!.detail).toContain('calibrated');
  expect(sessionMarkup(view).markup).toContain('Chat · est.');
});

test.each(['generating', 'reasoning'])('a newer %s event cannot relabel a matched runtime prefill rate as output speed', phase => {
  const input = inputOf('prefill', { attribution: { kind: 'inferred' } }, body => { body.chat = chatSample({ phase }); });
  expect(presentSessionSection(input).measurement).toMatchObject({ label: 'Chat · est.', text: '19.2' });
  delete input.snapshot!.chat!.tokensPerSecond;
  expect(presentSessionSection(input).measurement).toBeNull();
  input.snapshot!.runtime.phase = 'decode'; input.snapshot!.runtime.request!.decodeTps = 27.4;
  expect(presentSessionSection(input).measurement).toMatchObject({ label: 'Chat · matched', text: '27.4' });
});

test.each([['tool', 'Using tools'], ['waiting', 'Waiting'], ['cancelled', 'Stopped']] as const)('%s clears speed and never resurrects a previous request', (phase, label) => {
  const input = inputOf('decode', {}, body => { body.chat = chatSample({ phase, tokensPerSecond: undefined }); });
  const view = presentSessionSection(input);
  expect(view.phase).toBe(label);
  expect(view.measurement).toBeNull();
  expect(sessionMarkup(view).markup).not.toContain('tok/s');
});

test('a completed chat average is explicitly last, with a separate timing explanation; short replies stay empty', () => {
  const input = inputOf('decode', {}, body => { body.chat = chatSample({ phase: 'complete', basis: 'reported-output', timingBasis: 'completed-step', freshness: 'last' }); });
  const view = presentSessionSection(input);
  expect(view.measurement).toMatchObject({ label: 'Last chat · avg.', live: false, text: '19.2', basis: 'derived' });
  expect(view.measurement!.detail).toContain('step duration');
  expect(sessionMarkup(view).markup).toContain('data-live="false"');
  delete input.snapshot!.chat!.tokensPerSecond;
  expect(presentSessionSection(input).measurement).toBeNull();
});

test('expired, future and stale chat estimates cannot appear live', () => {
  const input = inputOf('decode', {}, body => { body.chat = chatSample(); });
  expect(presentSessionSection({ ...input, now: MOCK_NOW + 5_001 }).measurement?.label).toBe('Engine');
  expect(presentSessionSection({ ...input, now: MOCK_NOW - 1 }).measurement?.label).toBe('Engine');
  expect(presentSessionSection({ ...input, fresh: false }).measurement).toBeNull();
  expect(presentSessionSection({ ...input, paused: true }).measurement).toBeNull();
});

test('finished engine readings are marked last and disappear after a model change or cancellation', () => {
  const input = inputOf('decode');
  input.snapshot!.runtime.phase = 'idle'; input.snapshot!.runtime.request = null;
  input.last!.completion.decodeTps = 24; input.last!.completion.basis = 'reported';
  const view = presentSessionSection(input);
  expect(view.measurement).toMatchObject({ label: 'Last engine · avg.', text: '24.0', live: false });
  expect(presentSessionSection({ ...input, sessionModel: 'local/different-model' }).measurement).toBeNull();
  expect(presentSessionSection({ ...input, window: { tag: 'a', startedAt: MOCK_NOW - 100, endedAt: MOCK_NOW, outcome: 'failure' } }).measurement).toBeNull();
});

test('Whole engine remains usable while the selected chat is cloud; the default remains quiet', () => {
  const input = inputOf('decode', { chatIsLocal: false });
  expect(presentSessionSection(input).measurement).toBeNull();
  const view = presentSessionSection({ ...input, measurementScope: 'engine' });
  expect(view.measurementScope).toBe('engine');
  expect(view.measurement?.label).toBe('Engine');
});

test('Whole engine keeps its completed result independent of another chat model, activity, or cancellation', () => {
  const input = inputOf('decode', { measurementScope: 'engine', sessionModel: 'cloud/another-model', chatActivity: 'busy',
    window: { tag: 'a', startedAt: MOCK_NOW - 100, endedAt: MOCK_NOW, outcome: 'failure' } });
  input.snapshot!.runtime.phase = 'idle'; input.snapshot!.runtime.request = null;
  input.last!.completion.decodeTps = 24; input.last!.completion.basis = 'reported';
  expect(presentSessionSection(input)).toMatchObject({ phase: 'Idle', measurement: { label: 'Last engine · avg.', text: '24.0', live: false } });
});

test('the native scope menu is accessible and empty measurement lanes are omitted', () => {
  const view = presentSessionSection(inputOf('decode')), markup = sessionMarkup(view).markup;
  expect(markup).toContain('aria-label="Measurement scope"');
  expect(markup).toContain('<option value="chat" selected>This chat</option>');
  expect(markup.match(/class="ws-line/g)).toHaveLength(3);
  expect(markup).toContain(view.support!.text);
  expect(markup).not.toMatch(/Prefill speed|Prompt progress|Generation speed|>—</);
  expect(sessionMarkup(presentSessionSection(inputOf('decode', { measurementScope: 'engine' }))).markup).toContain('<option value="engine" selected>Whole engine</option>');
});

test('waiting for chat output preserves supported prompt progress while the engine reads', () => {
  const input = inputOf('splash-progress', {}, body => { body.chat = chatSample({ phase: 'waiting', tokensPerSecond: undefined }); });
  expect(presentSessionSection(input)).toMatchObject({ phase: 'Reading prompt', measurement: { kind: 'progress', text: '64%' } });
});

test('cloud delivery is labelled Cloud · est. and never becomes an engine reading, even beside a native rate', () => {
  const input = inputOf('pressure', { chatIsLocal: false }, body => { body.chat = chatSample(); });
  const view = presentSessionSection(input);
  expect(view).toMatchObject({ phase: 'Generating', alert: null, note: null,
    measurement: { label: 'Cloud · est.', text: '19.2', basis: 'estimate', live: true } });
  expect(view.measurement!.detail).toContain('provider buffering');
  expect(view.speeds.speeds).toEqual([]);
  expect(sessionMarkup(view).markup).not.toMatch(/Engine|Memory pressure|Chat · est\./);
  expect(presentSessionSection({ ...input, now: MOCK_NOW + 5_001 }).measurement).toBeNull();
  expect(presentSessionSection({ ...input, now: MOCK_NOW - 1 }).measurement).toBeNull();
  expect(presentSessionSection({ ...input, fresh: false })).toMatchObject({ phase: 'Waiting for update', measurement: null });
  expect(presentSessionSection({ ...input, paused: true })).toMatchObject({ phase: 'Paused', measurement: null });
  // A local chat's estimate keeps its own label.
  expect(presentSessionSection(inputOf('idle', { chatIsLocal: true }, body => { body.chat = chatSample(); })).measurement?.label).toBe('Chat · est.');
});

test.each([['reasoning', 'Reasoning'], ['tool', 'Using tools'], ['waiting', 'Waiting'], ['cancelled', 'Stopped']] as const)(
  'cloud %s is explicit and never borrows the local engine speed', (phase, label) => {
    const input = inputOf('decode', { chatIsLocal: false }, body => { body.chat = chatSample({ phase, tokensPerSecond: phase === 'reasoning' ? 19.2 : undefined }); });
    expect(presentSessionSection(input)).toMatchObject({ phase: label });
    expect(presentSessionSection(input).measurement?.label ?? null).toBe(phase === 'reasoning' ? 'Cloud · est.' : null);
  });

test('cloud completed average stays labelled last and cloud, and does not claim native timing', () => {
  const input = inputOf('decode', { chatIsLocal: false }, body => { body.chat = chatSample({ phase: 'complete', basis: 'reported-output', timingBasis: 'completed-step', freshness: 'last' }); });
  const view = presentSessionSection(input);
  expect(view.measurement).toMatchObject({ label: 'Last cloud · avg.', live: false, basis: 'derived', result: { label: 'Last cloud result', timing: 'step' } });
  expect(view.measurement!.detail).toContain('cloud engine');
  expect(presentSessionSection({ ...input, window: { tag: 'a', startedAt: MOCK_NOW - 100, endedAt: MOCK_NOW, outcome: 'failure' } })).toMatchObject({ phase: 'Stopped', measurement: null });
});

test('cloud full view excludes local diagnostics, charts, older replies and captures', () => {
  const input = inputOf('pressure', { chatIsLocal: false }, body => { body.chat = chatSample(); });
  const view = presentLive({ ...input, last: null, version: '3.0.0', fresh: true, paused: false, frame: null,
    chatRuntime: null, next: { kind: 'idle' }, samples: [], turnStartAt: null });
  expect(view.callouts).toEqual([]);
  expect(view.tiles).toEqual([]);
  expect(view.mac).toBeNull();
  expect(view.hero).toMatchObject({ chatOnly: true, body: null, reply: null, engineTrend: null,
    instrument: { measurement: { label: 'Cloud · est.' } } });
});

test('Session supports the reading with one fresh fact whose engine scope stays explicit', () => {
  const input = inputOf('decode', {}, body => {
    body.runtime.request.ttftMs = 1200;
    body.capabilities['request.ttft'] = { basis: 'reported', scope: 'request' };
  }), view = presentSessionSection(input);
  expect(view.support?.text).toMatch(/^Engine · First token /);
  expect(presentSessionSection({ ...input, fresh: false }).support).toBeNull();
  expect(presentSessionSection({ ...input, paused: true }).support).toBeNull();
  expect(presentSessionSection({ ...input, chatIsLocal: false }).support).toBeNull();
  expect(presentSessionSection(inputOf('pressure')).support).toBeNull();
  const prefill = inputOf('prefill');
  expect(presentSessionSection(prefill).support?.text).toContain('tokens');
  const next = inputOf('prefill', {}, body => { body.chat = chatSample(); });
  expect(presentSessionSection(next).support).toBeNull();
  const fallback = inputOf('decode', {}, body => { delete body.runtime.request.ttftMs; });
  expect(presentSessionSection(fallback).support?.text).toContain('tokens out');
  const estimate = inputOf('decode', { attribution: { kind: 'inferred' } }, body => {
    body.chat = chatSample(); body.runtime.request.decodeTps = null;
  });
  expect(presentSessionSection(estimate).measurement?.label).toBe('Chat · est.');
  expect(presentSessionSection(estimate).support?.text).toMatch(/^Engine · /);
});

test('never dark: a prompt without reported progress holds the reply’s elapsed time, never a simulated percent', () => {
  const window = { tag: 't', startedAt: MOCK_NOW - 12_400, endedAt: null, outcome: null } as const;
  const waiting = inputOf('splash-prefill-waiting', { window, chatActivity: 'busy' });
  expect(presentSessionSection(waiting)).toMatchObject({ phase: 'Reading prompt',
    measurement: { kind: 'elapsed', text: '12\u00a0s', unit: null, label: 'This reply · elapsed', basis: 'observed', live: true } });
  const markup = sessionMarkup(presentSessionSection(waiting)).markup;
  expect(markup).toContain('id="elapsed"'); expect(markup).not.toMatch(/id="rate"|id="prefill-percent"|%/);
  // A turn joined mid-way has no known start: the phase stays, nothing is invented.
  expect(presentSessionSection({ ...waiting, window: { ...window, startedAt: null, joinedAt: MOCK_NOW - 3_000 } }).measurement).toBeNull();
  expect(presentSessionSection({ ...waiting, window: null }).measurement).toBeNull();
  expect(presentSessionSection({ ...waiting, measurementScope: 'engine' }).measurement).toBeNull();
  expect(presentSessionSection({ ...waiting, fresh: false }).measurement).toBeNull();
  expect(presentSessionSection({ ...waiting, paused: true }).measurement).toBeNull();
  expect(presentSessionSection({ ...waiting, now: MOCK_NOW + 60_000 }).measurement?.text).toBe('1\u00a0m\u00a012\u00a0s');
  // A measured rate, when the window has one, outranks elapsed time.
  expect(presentSessionSection(inputOf('splash-prefill', { window, chatActivity: 'busy' })).measurement).toMatchObject({ kind: 'speed', label: 'Engine' });
});

test('never dark: the engine’s own request clock is preferred, and reported progress still wins', () => {
  const window = { tag: 't', startedAt: MOCK_NOW - 30_000, endedAt: null, outcome: null } as const;
  const noProgress = inputOf('prefill', { window, chatActivity: 'busy', attribution: { kind: 'inferred' } }, body => {
    delete body.runtime.request.prefillFraction; delete body.runtime.request.prefillProcessedTokens; delete body.runtime.request.prefillTotalTokens;
    delete body.runtime.request.prefillTps; delete body.runtime.request.prefillEtaMs;
  });
  const view = presentSessionSection(noProgress), elapsed = noProgress.snapshot!.runtime.request!.elapsedMs!;
  expect(view.measurement).toMatchObject({ kind: 'elapsed', label: 'Chat · matched · prompt · elapsed', live: true,
    text: `${Math.floor(elapsed / 1_000)}\u00a0s` });
  expect(presentSessionSection(inputOf('prefill', { window, chatActivity: 'busy' })).measurement).toMatchObject({ kind: 'progress', text: '64%' });
  // The hero's elapsed time is not repeated as a tile.
  const live = presentLive({ ...noProgress, last: noProgress.last ? { ...noProgress.last, vsUsual: null, flag: null } : null, fresh: true, paused: false, version: '3.2.0', frame: null, chatRuntime: null, next: { kind: 'idle' }, samples: [], turnStartAt: null });
  expect(liveMarkup(live, new Set()).markup.split('id="measurement-details"')[0]).not.toContain('>Elapsed</span>');
});

test('never dark: a cloud reply waiting for its first output shows elapsed time, then its estimate', () => {
  const window = { tag: 't', startedAt: MOCK_NOW - 4_000, endedAt: null, outcome: null } as const;
  const input = inputOf('pressure', { chatIsLocal: false, window, chatActivity: 'busy' }, body => { body.chat = chatSample({ phase: 'waiting', tokensPerSecond: undefined }); });
  expect(presentSessionSection(input)).toMatchObject({ phase: 'Waiting', held: null,
    measurement: { kind: 'elapsed', text: '4\u00a0s', label: 'This reply · elapsed' } });
  input.snapshot!.chat = chatSample() as never;
  expect(presentSessionSection(input).measurement).toMatchObject({ kind: 'speed', label: 'Cloud · est.' });
  // After tools or between steps the phase itself is the truth.
  input.snapshot!.chat = chatSample({ phase: 'tool', tokensPerSecond: undefined }) as never;
  expect(presentSessionSection(input).measurement).toBeNull();
});

test('the previous completed average is held, dimmed and labelled, below a live local reading only', () => {
  // Scope's own last-observed request reading is not a completed average and is never held.
  expect(presentSessionSection(inputOf('decode')).held).toBeNull();
  const input = inputOf('decode', {}, body => { body.completions.items.at(-1).basis = 'reported'; }), view = presentSessionSection(input);
  expect(view.measurement).toMatchObject({ live: true, kind: 'speed' });
  expect(view.held).toMatchObject({ text: 'Last engine reply · 24.9 tok/s · 1 min ago' });
  expect(liveMarkup(presentLive({ ...input, last: input.last ? { ...input.last, vsUsual: null, flag: null } : null, fresh: true, paused: false, version: '3.2.0', frame: null, chatRuntime: null, next: { kind: 'idle' }, samples: [], turnStartAt: null }), new Set()).markup)
    .toContain('class="instrument-held" data-held="true"');
  for (const extra of [{ chatIsLocal: false }, { paused: true }, { fresh: false }, { window: { tag: 'a', startedAt: MOCK_NOW - 100, endedAt: MOCK_NOW, outcome: 'failure' as const } }])
    expect(presentSessionSection({ ...input, ...extra }).held, JSON.stringify(extra)).toBeNull();
  // A finished result is itself the held value: nothing is doubled.
  expect(presentSessionSection(inputOf('idle')).held).toBeNull();
  // Another model's reply is never held for this chat.
  expect(presentSessionSection({ ...input, sessionModel: 'other-model' }).held).toBeNull();
});

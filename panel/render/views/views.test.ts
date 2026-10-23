import { expect, test } from 'bun:test';
import { parseSnapshotV2 } from '../../../src/contract/snapshot.ts';
import { presentLive } from '../../present/live.ts';
import { SERVER_WIDE, type ScopeInput } from '../../present/scope.ts';
import { presentServer } from '../../present/server.ts';
import { presentSessionSection } from '../../present/session.ts';
import { fromSnapshot } from '../../present/reading.ts';
import { MOCK_NOW, MOCK_STATES, mockBody } from '../../testing/mock-states.ts';
import { esc, html } from '../html.ts';
import { frameCardMarkup, shellMarkup } from '../shell.ts';
import { liveMarkup } from './live.ts';
import { serverMarkup } from './server.ts';
import { sessionMarkup } from './session.ts';

const snapshotOf = (state: string, patch: (body: Record<string, any>) => void = () => {}) => {
  const body = JSON.parse(JSON.stringify(mockBody(state))); patch(body);
  return parseSnapshotV2(body)!;
};
const inputOf = (state: string, patch?: (body: Record<string, any>) => void, extra: Partial<ScopeInput> = {}): ScopeInput => {
  const snapshot = snapshotOf(state, patch), last = snapshot.completions.items.at(-1) ?? null;
  return { now: MOCK_NOW, version: '2.0.0', snapshot, fresh: true, frame: null, paused: false, attribution: { kind: 'inferred' }, chatRuntime: null,
    last: last ? { completion: last, label: { kind: 'inferred' }, vsUsual: null, flag: null } : null, samples: [], turnStartAt: null, ...extra };
};

test('every value is escaped: a hostile model name renders as text in every view', () => {
  const hostile = '<img src=x onerror=alert(1)>"\'&';
  const input = inputOf('decode', body => { body.runtime.request.model = hostile; body.runtime.residency[0].model = hostile; });
  const markup = [liveMarkup(presentLive(input), new Set()).markup, serverMarkup(presentServer(input.snapshot, MOCK_NOW), new Set()).markup].join('');
  expect(markup).not.toContain('<img');
  expect(markup).toContain(esc(hostile));
  expect(html`<b>${'<i>'}</b>${[html`<u>${'&'}</u>`]}${null}${false}${0}`.markup).toBe('<b>&lt;i&gt;</b><u>&amp;</u>0');
});

test('ⓘ disclosures are 24 px buttons with aria-expanded and aria-controls, their text in flow and hidden until opened', () => {
  const input = inputOf('decode'), closed = liveMarkup(presentLive(input), new Set()).markup;
  const buttons = [...closed.matchAll(/<button class="info"[^>]*aria-controls="([^"]+)"[^>]*>/g)];
  expect(buttons.length).toBeGreaterThanOrEqual(4);
  for (const [button, id] of buttons) {
    expect(button).toContain('aria-expanded="false"');
    expect(button).toMatch(/aria-label="About [^"]+"/);
    expect(closed).toMatch(new RegExp(`<div class="pop" id="${id}" role="note" hidden>`));
  }
  const open = liveMarkup(presentLive(input), new Set(['pop-live-attr'])).markup;
  expect(open).toContain('aria-expanded="true" aria-controls="pop-live-attr"');
  expect(open).toMatch(/<div class="pop" id="pop-live-attr" role="note"><strong>This chat<\/strong>/);
});

test('every mock state renders every view without a raw placeholder', () => {
  for (const state of MOCK_STATES) {
    const input = inputOf(state), session = presentSessionSection({ now: MOCK_NOW, reading: fromSnapshot(input.snapshot!), snapshot: input.snapshot,
      attribution: SERVER_WIDE, chatIsLocal: true, fresh: true });
    const markup = [liveMarkup(presentLive(input), new Set()), serverMarkup(presentServer(input.snapshot, MOCK_NOW), new Set()),
      sessionMarkup(session, null, false, true), sessionMarkup(session, null, true, true)].map(item => item.markup).join('');
    expect(markup, state).not.toMatch(/undefined|NaN|\[object|VRAM/);
  }
});

test('the full page fills its readout at rest and folds only the parts that hold nothing true', () => {
  // A local engine at rest shows the same labelled record the glance does: overall average plus what it holds.
  const rest = inputOf('idle', body => {
    body.runtime.server.averages = { decodeTps: 35.73, prefillTps: 284.2 };
    body.capabilities['server.averages'] = { scope: 'server', basis: 'reported' };
    body.runtime.memory = { metalBytes: 25_663_782_912 };
    body.capabilities['server.memory.metal'] = { scope: 'server', basis: 'reported' };
    delete body.capabilities['server.memory.model'];
    body.runtime.server.histograms = { ttftMs: { p50: 410, p95: 900, n: 64, window: 'native-last-4096' } };
    body.capabilities['server.latency'] = { scope: 'server', basis: 'derived' };
  }, { chatActivity: 'idle', last: null, measurementScope: 'engine' });
  const filled = liveMarkup(presentLive(rest), new Set()).markup;
  expect(filled).toContain('Engine · overall average');
  expect(filled).toContain('23.9 GiB');
  expect(filled).toMatch(/class="instrument-measure" data-quiet="false"/);
  expect(filled).toMatch(/class="instrument-evidence" data-quiet="false"/);
  // No model loaded: neither part holds anything true, so both fold to their line instead of a blank block.
  const unloaded = liveMarkup(presentLive(inputOf('model-unloaded')), new Set()).markup;
  expect(unloaded).toMatch(/class="instrument-measure" data-quiet="true"/);
  expect(unloaded).toMatch(/class="instrument-evidence" data-quiet="true"/);
  // A cloud chat at rest borrows nothing local; the readout folds under its phase line.
  const cloud = liveMarkup(presentLive(inputOf('idle', undefined, { chatIsLocal: false, chatActivity: 'idle', last: null, measurementScope: 'chat' })), new Set()).markup;
  expect(cloud).toMatch(/class="instrument-measure" data-quiet="true"/);
  expect(cloud).toMatch(/class="instrument-evidence" data-quiet="true"/);
  // A live reading never folds its measure, even without evidence tiles.
  const live = liveMarkup(presentLive(inputOf('decode')), new Set()).markup;
  expect(live).toMatch(/class="instrument-measure" data-quiet="false"/);
});

test('one column of truth: no workspace tabs; History and Server are secondary views with Back', () => {
  const shell = shellMarkup().markup;
  expect(shell).not.toMatch(/role="tab"|role="tablist"|role="tabpanel"/);
  // The column holds This chat and its engine, then the state-driven Media block, then the foot actions.
  expect(shell.indexOf('id="view-live"')).toBeLessThan(shell.indexOf('id="view-media"'));
  expect(shell.indexOf('id="view-media"')).toBeLessThan(shell.indexOf('id="column-foot"'));
  expect(shell).toMatch(/<section class="column-block" id="view-media" aria-label="Media" hidden>/);
  expect(shell).toContain('data-action="open-history">History</button>');
  // Server rows live inside the measurement disclosure; History is the only secondary view.
  expect(shell).not.toContain('open-server');
  expect(shell).not.toContain('panel-server');
  expect(shell).toContain('aria-labelledby="history-title"');
  expect(shell).toContain('data-action="back-live"');
  expect(shell).not.toMatch(/captures|Captures|back-history/);
});

test('runtime diagnostics fold into the server line without displacing its measurements', () => {
  const view = presentServer(snapshotOf('decode'), MOCK_NOW), closed = serverMarkup(view, new Set()).markup;
  expect(closed).toContain('class="server-head title-row"');
  expect(closed).toContain('data-key="server-memory"');
  expect(closed.indexOf('class="server-head"')).toBeLessThan(closed.indexOf('data-key="server-memory"'));
  expect(closed).toContain('per-request speed');
  expect(closed).toMatch(new RegExp('<div class="pop" id="pop-server-runtime" role="note" hidden>'));
  expect(serverMarkup(view, new Set(['pop-server-runtime'])).markup).toContain('aria-expanded="true"');
});

test('full Live retains the readout structure through freshness changes and shows no empty trend', () => {
  for (const state of ['decode', 'prefill', 'idle']) {
    const input = inputOf(state), markup = liveMarkup(presentLive(input), new Set()).markup;
    expect(markup, state).toContain('class="instrument-readout"');
    expect(markup, state).toContain('<div id="engine-trend" hidden></div>');
    expect(markup, state).not.toContain('id="signal"');
  }
  const stale = liveMarkup(presentLive(inputOf('decode', undefined, { fresh: false })), new Set()).markup;
  expect(stale).toContain('class="instrument-readout"');
  expect(stale).toContain('<div id="engine-trend" hidden></div>');
  expect(stale).not.toContain('id="rate"');
});

test('Engine trend retains compatible history during tools without admitting chat estimates or mixed rate bases', () => {
  const input = inputOf('splash-decode', body => {
    body.chat = { scope: 'chat', basis: 'estimated-characters', timingBasis: 'delivery-window', phase: 'tool',
      observedAtMs: MOCK_NOW, expiresAtMs: MOCK_NOW + 5_000,
      observation: { startedAtMs: MOCK_NOW - 3_000, endedAtMs: MOCK_NOW }, freshness: 'live' };
  }, { samples: [{ at: MOCK_NOW - 2_000, rate: 30, phase: 'decode', segment: 1, basis: 'derived' },
    { at: MOCK_NOW - 1_000, rate: 32, phase: 'decode', segment: 1, basis: 'derived' },
    { at: MOCK_NOW - 500, rate: 999, phase: 'decode', segment: 2 }] });
  const view = presentLive(input), markup = liveMarkup(view, new Set(['engine-trend'])).markup;
  expect(view.hero?.instrument).toMatchObject({ phase: 'Using tools', measurement: null });
  expect(view.hero?.engineTrend?.chart).toMatchObject({ points: 2, ceiling: '35 tok/s' });
  expect(markup).toContain('id="engine-trend"');
  expect(markup).toContain('<span>Engine trend</span>');
  expect(markup.indexOf('id="engine-trend"')).toBeLessThan(markup.indexOf('id="measurement-details"'));
  expect(markup).toContain('id="signal"');
  expect(markup).not.toContain('id="rate"');
  expect(markup).not.toContain('999');
  const unsupported = inputOf('ollama');
  delete unsupported.snapshot!.capabilities['request.decodeRate'];
  delete unsupported.snapshot!.capabilities['server.rates'];
  expect(presentLive(unsupported).hero?.engineTrend).toBeNull();
});

test('available Engine facts are visible before deeper details and absent output is never invented', () => {
  const markup = liveMarkup(presentLive(inputOf('decode', body => {
    body.runtime.request.ttftMs = 850;
    body.capabilities['request.ttft'] = { scope: 'request', basis: 'observed' };
  })), new Set()).markup;
  expect(markup).toContain('id="engine-facts" data-count="3"');
  expect(markup).toContain('class="engine-facts-heading">Engine</span>');
  expect(markup).toContain('>Output</span>');
  expect(markup).toContain('>Elapsed</span>');
  expect(markup).toContain('>First token</span>');
  expect(markup).toContain('<strong data-basis="observed">0.85 s</strong>');
  expect(markup).toContain('<span class="basis">measured</span>');
  expect(markup.indexOf('id="engine-facts"')).toBeLessThan(markup.indexOf('id="measurement-details"'));
  const stopped = liveMarkup(presentLive(inputOf('decode', body => {
    body.chat = { scope: 'chat', basis: 'estimated-characters', timingBasis: 'delivery-window', phase: 'tool', observedAtMs: MOCK_NOW,
      expiresAtMs: MOCK_NOW + 5_000, observation: { startedAtMs: MOCK_NOW - 3_000, endedAtMs: MOCK_NOW }, freshness: 'live' };
  })), new Set()).markup;
  expect(stopped).not.toContain('id="engine-facts"');
  expect(stopped).not.toContain('id="first-token"');
});

test('needs approval lists every exec path as code; needs restart gives the two S11 steps', () => {
  const approval = frameCardMarkup('approval').markup, restart = frameCardMarkup('restart').markup;
  expect(approval).toContain('<code>/usr/sbin/ioreg</code>');
  expect(approval).toContain('<code>~/.cache/lm-studio/bin/lms</code>');
  expect(approval).not.toMatch(/sessions|chat titles/i);
  expect(restart).toContain('<li>Pause it, then resume it.</li>');
});


test('completed native facts belong to the exact selected last average', () => {
  for (const measurementScope of ['chat', 'engine'] as const) {
    const input = inputOf('idle', body => {
      const c = body.completions.items.at(-1); c.basis = 'reported'; c.ttftMs = 850;
    }, { measurementScope });
    input.window = { tag: '00000000', startedAt: input.last!.completion.startedAt, endedAt: input.last!.completion.finishedAt, outcome: 'completed' };
    const view = presentLive(input);
    const markup = liveMarkup(view, new Set()).markup, visible = markup.split('id="measurement-details"')[0]!;
    expect(visible).toContain('id="completed-facts" data-count="3"');
    expect(visible).toContain(measurementScope === 'engine' ? 'Last reply · Engine' : 'Last reply');
    expect(visible).toContain('>Output</span><strong data-basis="reported">1,104</strong>');
    expect(visible).toContain('>Duration</span><strong data-basis="derived">48 s</strong>');
    expect(visible).toContain('>First token</span><strong data-basis="reported">0.85 s</strong>');
    expect(visible).toContain('data-live="false"');
    expect(visible).toContain('<time>Finished 1 min ago</time>');
  }
  const derived = liveMarkup(presentLive(inputOf('idle', body => { body.completions.items.at(-1).basis = 'derived'; })), new Set()).markup;
  expect(derived.split('id="measurement-details"')[0]).toContain('>Output</span><strong data-basis="reported">1,104</strong>');
  const view = presentLive(inputOf('idle', body => {
    const c = body.completions.items.at(-1); c.basis = 'reported'; c.startedAt = null;
    delete c.outputTokens; delete c.ttftMs;
  }));
  expect(liveMarkup(view, new Set()).markup.split('id="measurement-details"')[0]).not.toContain('id="completed-facts"');
});

test('completed chat facts never borrow output or first-token timing from an engine reply', () => {
  for (const chatIsLocal of [true, false]) {
    const view = presentLive(inputOf('decode', body => {
      body.runtime.request.ttftMs = 850;
      body.capabilities['request.ttft'] = { scope: 'request', basis: 'reported' };
      body.chat = { scope: 'chat', basis: 'reported-output', timingBasis: 'completed-step', phase: 'complete',
        tokensPerSecond: 7.2, observedAtMs: MOCK_NOW, expiresAtMs: MOCK_NOW + 5_000,
        observation: { startedAtMs: MOCK_NOW - 3_000, endedAtMs: MOCK_NOW }, freshness: 'last' };
    }, { chatIsLocal }));
    const markup = liveMarkup(view, new Set()).markup, visible = markup.split('id="measurement-details"')[0]!;
    expect(visible).toContain('id="completed-facts" data-count="1"');
    expect(visible).toContain(chatIsLocal ? 'Last reply' : 'Last reply');
    expect(visible).toContain('<time>Finished just now</time>');
    expect(visible).toContain('>Step duration</span><strong data-basis="derived">3.0 s</strong>');
    expect(visible).not.toContain('>Output</span>');
    expect(visible).not.toContain('>First token</span>');
    expect(visible).not.toContain('id="engine-facts"');
    if (!chatIsLocal) expect(markup).not.toContain('id="measurement-details"');
  }
});


test('This Mac sits beside the instrument with its readings, and warns only where macOS reports pressure', () => {
  const view = presentLive(inputOf('decode'));
  expect(view.mac).not.toBeNull();
  const markup = liveMarkup(view, new Set()).markup;
  expect(markup).toContain('<aside class="next-live-context" aria-label="This Mac">');
  expect(markup).toContain('class="machine-line"');
  expect(markup).toContain(esc(view.mac!.title));
  expect(markup).not.toContain('data-level="warning"');
  expect(liveMarkup(presentLive(inputOf('pressure')), new Set()).markup).toContain('data-level="warning"');
});

import { expect, test } from 'bun:test';
import { parseSnapshotV2, type SnapshotV2 } from '../../src/contract/snapshot.ts';
import { liveChart } from '../render/chart.ts';
import { liveMarkup } from '../render/views/live.ts';
import { statusHeight, statusMarkup } from '../render/views/status.ts';
import { serverMarkup } from '../render/views/server.ts';
import { SignalHistory } from '../signal.ts';
import { MOCK_NOW, mockBody } from '../testing/mock-states.ts';
import { heroKind, presentLive } from './live.ts';
import { presentServer } from './server.ts';
import { fromSnapshot } from './reading.ts';
import { liveSplashRate, type ScopeInput } from './scope.ts';
import { presentStatusSection, type StatusSectionInput } from './status.ts';

const snapshot = (patch: (body: SnapshotV2) => void = () => {}, at = MOCK_NOW): SnapshotV2 => {
  const body = parseSnapshotV2(mockBody('splash-decode', { now: at }))!;
  patch(body);
  return body;
};
const scope = (body: SnapshotV2, extra: Partial<ScopeInput> = {}): ScopeInput => ({
  now: MOCK_NOW, version: '2.0.1', snapshot: body, fresh: true, frame: null, paused: false,
  attribution: { kind: 'inferred' }, chatRuntime: 'Splish', last: null, next: { kind: 'idle' }, samples: [], turnStartAt: null, ...extra,
});
const status = (body: SnapshotV2, extra: Partial<StatusSectionInput> = {}) => presentStatusSection({
  now: MOCK_NOW, reading: fromSnapshot(body), snapshot: body, fresh: true, attribution: { kind: 'inferred' }, turn: null, vsUsual: null,
  sparkline: null, chatIsLocal: true, expanded: false, tipDismissed: true, ...extra,
});

test('Splash live throughput leads with derived server-wide speed, never the lifetime average or a chat label', () => {
  for (const active of [1, 3]) {
    const input = scope(snapshot(body => { body.runtime.server.active = active; body.runtime.phase = active === 1 ? 'decode' : 'processing'; }));
    const view = presentLive(input), hero = view.hero!;
    expect(heroKind(input)).toBe('server-decode');
    expect(hero.body).toMatchObject({ kind: 'decode' });
    expect(hero.instrument.measurement).toMatchObject({ text: '43.8', basis: 'derived', label: 'Engine' });
    expect(hero.attr?.chip.text).toBe('All server activity · all requests');
    expect(hero.context).toBeNull();
    expect(view.tiles.map(tile => tile.label)).toEqual(['Active requests', 'Metal allocations', 'Median first token']);
    expect(view.tiles[0]?.value).toBe(String(active));
    if (hero.body?.kind === 'decode') {
      expect(hero.body.tip.paras.join(' ')).toContain('time Splash spent generating');
      expect(hero.body.tip.paras.join(' ')).toContain('how quickly tokens reach your chat');
      expect(hero.body.tip.paras.join(' ')).toContain('Unused draft tokens are excluded');
    }
    const markup = liveMarkup(view, new Set()).markup;
    expect(markup).toContain('data-stage="generation" data-active="true" data-basis="derived"');
    expect(markup).toContain('speed-source basis');
    expect(markup).toContain('Calculated · last 4.0 s');
    expect(markup).toContain('last 4.0 s');
    expect(markup).not.toContain('Request average');
    expect(markup).not.toContain('Likely this chat');
  }
});

test('Session and Compact keep live server throughput visible with derived basis and honest attribution', () => {
  const view = status(snapshot(), { attribution: { kind: 'armed' }, next: { kind: 'measuring', startedAt: MOCK_NOW - 3_000, steps: [] } as StatusSectionInput['next'] });
  expect(view.glance?.line1).toMatchObject({ word: 'Recent generation speed', rate: '43.8', rateBasis: 'derived', chip: { text: 'All server activity' } });
  expect(view.glance?.line2).toMatchObject({ kind: 'spark', spark: null, reason: 'last 4.0 s · all requests' });
  expect(view.height).toBe(56);
  expect(statusHeight(view)).toBe(80);
  for (const compact of [false, true]) {
    const markup = statusMarkup(view, compact).markup;
    expect(markup).toContain('class="ws-rate" data-basis="derived">43.8');
    expect(markup).toContain('<small class="basis">calculated</small>');
    expect(markup).toContain('id="ws-why">last 4.0 s · all requests</span>');
    expect(markup).not.toMatch(/inferred|Next reply/);
  }
});

test('warmup, missing counters, idle, stale and unavailable Splash readings never promote old speed to live', () => {
  const mutations: Array<(body: SnapshotV2) => void> = [
    body => { delete body.runtime.server.rates; },
    body => { delete body.capabilities['server.rates']; },
    body => { body.runtime.server.rates!.decodeTps = 0; },
    body => { body.runtime.server.rates!.decodeTps = NaN; },
    body => { body.runtime.server.rates!.windowMs = 0; },
    body => { body.runtime.server.rates!.windowMs = 1_999; },
    body => { body.runtime.server.rates!.windowMs = 5_001; },
    body => { body.runtime.server.active = 0; },
    body => { body.runtime.server.active = null; },
    body => { body.runtime.phase = 'idle'; },
    body => { body.runtime.phase = 'prefill'; },
    body => { body.runtime.phase = 'queued'; },
    body => { body.status.state = 'recovering'; body.status.reason = 'recovering'; },
    body => { body.status.state = 'degraded'; body.status.reason = 'status_stale'; },
    body => { body.status.state = 'failing'; body.status.reason = 'runtime_unreachable'; },
    body => { body.status.reason = 'not_admitting'; },
  ];
  for (const patch of mutations) {
    const body = snapshot(patch), history = new SignalHistory();
    expect(body.runtime.server.averages?.decodeTps).toBe(47.2);
    expect(liveSplashRate(body)).toBeNull();
    expect(heroKind(scope(body))).not.toBe('server-decode');
    expect(status(body).glance?.line1.rate ?? null).toBeNull();
    history.observe(fromSnapshot(body));
    expect(history.points).toEqual([]);
  }
  const warming = snapshot(body => { delete body.runtime.server.rates; });
  expect(presentLive(scope(warming)).hero?.body).toMatchObject({ kind: 'word', unit: 'Waiting for update' });
  expect(presentLive(scope(snapshot(), { fresh: false })).hero?.body ?? null).toBeNull();
  expect(presentLive(scope(snapshot(), { paused: true })).hero?.body).toMatchObject({ kind: 'paused' });
  expect(status(snapshot(), { fresh: false }).glance?.line1.rate).toBeNull();
  expect(status(snapshot(), { paused: true }).glance?.line1.rate).toBeNull();
});

test('other server rates remain completion-based readings, while oMLX keeps its reported request average', () => {
  for (const runtime of ['llama-server', 'lmstudio', 'omlx'] as const) {
    const body = snapshot(body => { body.connection.runtime = runtime; });
    expect(liveSplashRate(body)).toBeNull();
    expect(heroKind(scope(body))).toBe('processing');
    expect(status(body).glance?.line1.rate).toBeNull();
    const history = new SignalHistory(); history.observe(fromSnapshot(body));
    expect(history.points).toEqual([]);
  }
  const body = parseSnapshotV2(mockBody('decode'))!;
  expect(presentLive(scope(body)).hero?.instrument.measurement).toMatchObject({ text: '26.4', basis: 'reported' });
});

test('server signal histories break on gaps and resets, cannot mix with request averages, and never imply chat timing', () => {
  const history = new SignalHistory();
  history.observe(fromSnapshot(snapshot(undefined, MOCK_NOW - 5_000)));
  history.observe(fromSnapshot(snapshot(body => { body.runtime.phase = 'processing'; }, MOCK_NOW - 4_000)));
  history.observe(fromSnapshot(snapshot(body => { delete body.runtime.server.rates; }, MOCK_NOW - 3_000)));
  history.observe(fromSnapshot(snapshot(undefined, MOCK_NOW - 2_000)));
  history.observe(fromSnapshot(snapshot(body => { body.connection.generation++; }, MOCK_NOW - 1_000)));
  expect(history.points.map(point => [point.basis, point.phase, point.segment])).toEqual([
    ['derived', 'decode', 1], ['derived', 'decode', 1], ['derived', 'decode', 2], ['derived', 'decode', 3],
  ]);
  expect(liveChart(history.points, MOCK_NOW, null)).toBeNull();
  history.points.push({ at: MOCK_NOW - 500, rate: 999, phase: 'decode', segment: 4 });
  const chart = liveChart(history.points, MOCK_NOW, MOCK_NOW - 4_000, 'server')!;
  expect(chart.points).toBe(4);
  expect(chart.title).toBe('Recent generation speed · all server activity · calculated');
  expect(chart.ceiling).toBe('50 tok/s');
  expect(chart.line.match(/M/g)).toHaveLength(3);
  expect(chart.mark).toBeNull();
  expect(chart.label).not.toMatch(/999|request average/);
  expect(liveChart([history.points[0]!], MOCK_NOW, null, 'server')).toBeNull();
});

test('Splash Server details distinguish recent decoding from lifetime averages and suppress held recent rates', () => {
  const body = snapshot(), view = presentServer(body, MOCK_NOW), markup = serverMarkup(view, new Set()).markup;
  expect(markup).toContain('Recent speeds');
  expect(markup).toContain('All server activity · last 4.0 s');
  expect(markup).toContain('Overall average');
  expect(markup).toContain('47.2 tok/s');
  expect(markup).toContain('43.8 tok/s');
  expect(presentServer(body, MOCK_NOW, [], false).cards.map(card => card.key)).not.toContain('rates');
  body.runtime.phase = 'prefill';
  expect(presentServer(body, MOCK_NOW).cards.map(card => card.key)).not.toContain('rates');
  body.runtime.phase = 'decode'; body.status.state = 'recovering';
  expect(presentServer(body, MOCK_NOW).cards.map(card => card.key)).not.toContain('rates');
});

test('Splash displays the actual observed interval and keeps prompt processing separate', () => {
  const body = snapshot(body => { body.runtime.server.rates!.windowMs = 2_350; });
  expect(presentLive(scope(body)).hero?.instrument.measurement?.detail).toContain('last 2.4 s');
  expect(status(body).glance?.line2).toMatchObject({ reason: 'last 2.4 s · all requests' });
  body.runtime.phase = 'prefill'; delete body.runtime.server.rates;
  expect(presentLive(scope(body)).hero?.body).toMatchObject({ kind: 'word', unit: 'Reading prompt · waiting for update' });
  expect(status(body).glance?.line1.word).toBe('Reading prompt');
});

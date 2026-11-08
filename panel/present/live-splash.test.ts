import { expect, test } from 'bun:test';
import { parseSnapshotV2, type SnapshotV2 } from '../../src/contract/snapshot.ts';
import { liveChart } from '../render/chart.ts';
import { liveMarkup } from '../render/views/live.ts';
import { sessionMarkup } from '../render/views/session.ts';
import { serverMarkup } from '../render/views/server.ts';
import { SignalHistory } from '../signal.ts';
import { MOCK_NOW, mockBody } from '../testing/mock-states.ts';
import { heroKind, presentLive } from './live.ts';
import { presentServer } from './server.ts';
import { fromSnapshot } from './reading.ts';
import { liveSplashRate, type ScopeInput } from './scope.ts';
import { presentSessionSection, type SessionSectionInput, type SessionSectionView } from './session.ts';

const snapshot = (patch: (body: SnapshotV2) => void = () => {}, at = MOCK_NOW): SnapshotV2 => {
  const body = parseSnapshotV2(mockBody('splash-decode', { now: at }))!;
  patch(body);
  return body;
};
const scope = (body: SnapshotV2, extra: Partial<ScopeInput> = {}): ScopeInput => ({
  now: MOCK_NOW, version: '2.0.1', snapshot: body, fresh: true, frame: null, paused: false,
  attribution: { kind: 'inferred' }, chatRuntime: 'Splish', last: null, samples: [], turnStartAt: null, ...extra,
});
const session = (body: SnapshotV2, extra: Partial<SessionSectionInput> = {}) => presentSessionSection({
  now: MOCK_NOW, reading: fromSnapshot(body), snapshot: body, fresh: true, attribution: { kind: 'inferred' }, chatIsLocal: true, ...extra,
});
/** The Session section's live speed, or null when it shows none. */
const liveRate = (view: SessionSectionView): string | null => view.measurement?.live && view.measurement.kind === 'speed' ? view.measurement.text : null;

test('Splash live throughput leads with derived server-wide speed, never the lifetime average or a chat label', () => {
  for (const active of [1, 3]) {
    const input = scope(snapshot(body => { body.runtime.server.active = active; body.runtime.phase = active === 1 ? 'decode' : 'processing'; }));
    const view = presentLive(input), hero = view.hero!;
    expect(heroKind(input)).toBe('server-decode');
    expect(hero.body).toMatchObject({ kind: 'decode' });
    expect(hero.instrument.measurement).toMatchObject({ text: '43.8', basis: 'derived', label: 'Engine' });
    expect(hero.attr?.chip).toMatchObject({ text: 'Engine', reason: 'all requests' });
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
    expect(markup).not.toMatch(/data-attr="inferred"|instrument-source" data-crossfade="This chat"/);
  }
});

test('Session and Compact keep live server throughput visible with derived basis and honest attribution', () => {
  const view = session(snapshot());
  expect(view.measurement).toMatchObject({ text: '43.8', basis: 'derived', live: true, kind: 'speed' });
  expect(view.measurement!.label.startsWith('Engine')).toBe(true);
  expect(view.measurement!.detail).toContain('last 4.0 s');
  for (const compact of [false, true]) {
    const markup = sessionMarkup(view, null, compact, true).markup;
    expect(markup).toContain('data-basis="derived"');
    expect(markup).toContain('43.8');
    expect(markup).toContain('<span class="ws-label" data-crossfade>Engine');
    expect(markup).not.toMatch(/class="ws-label"[^>]*>This chat|Next reply/);
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
    expect(liveRate(session(body))).toBeNull();
    history.observe(fromSnapshot(body));
    expect(history.points).toEqual([]);
  }
  const warming = snapshot(body => { delete body.runtime.server.rates; });
  expect(presentLive(scope(warming)).hero?.body).toMatchObject({ kind: 'word', unit: 'Waiting for update' });
  expect(presentLive(scope(snapshot(), { fresh: false })).hero?.body ?? null).toBeNull();
  expect(presentLive(scope(snapshot(), { paused: true })).hero?.body).toMatchObject({ kind: 'paused' });
  expect(liveRate(session(snapshot(), { fresh: false }))).toBeNull();
  expect(liveRate(session(snapshot(), { paused: true }))).toBeNull();
});

test('other server rates remain completion-based readings, while oMLX keeps its reported request average', () => {
  for (const runtime of ['llama-server', 'lmstudio', 'omlx'] as const) {
    const body = snapshot(body => { body.connection.runtime = runtime; });
    expect(liveSplashRate(body)).toBeNull();
    expect(heroKind(scope(body))).toBe('processing');
    expect(liveRate(session(body))).toBeNull();
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
  expect(session(body).measurement?.detail).toContain('last 2.4 s');
  body.runtime.phase = 'prefill'; delete body.runtime.server.rates;
  expect(presentLive(scope(body)).hero?.body).toMatchObject({ kind: 'word', unit: 'Reading prompt · waiting for update' });
  expect(session(body).phase).toBe('Reading prompt');
});

test('5.5: Splash memory room and draft acceptance appear among the engine readings, in Splash\'s own words', () => {
  const body = snapshot(s => {
    s.runtime.memory.room = { limitBytes: 40_802_189_312, headroomBytes: 3_221_225_472, claimsBytes: 4_724_464_025,
      kvActiveBytes: 6_570_000_000, kvAllocatedBytes: 7_080_000_000, spilledRequests: 2 };
    s.runtime.server.admission = { waitingMemory: 1, waitingConcurrency: 0, oldestWaitMs: 18_400 };
    s.runtime.server.speculative = { draftedTokens: 4_000, acceptedTokens: 2_840, acceptanceFraction: 0.71, windowMs: 600_000 };
    s.capabilities['server.memory.room'] = { scope: 'server', basis: 'reported' };
    s.capabilities['server.admission'] = { scope: 'server', basis: 'reported' };
    s.capabilities['server.speculative'] = { scope: 'server', basis: 'derived' };
  });
  const cards = presentServer(body, MOCK_NOW).cards, room = cards.find(card => card.key === 'room'), spec = cards.find(card => card.key === 'spec');
  expect(room).toMatchObject({ title: 'Memory room', right: 'Splash · from server' });
  const text = JSON.stringify(room);
  for (const fact of ['Free in its budget', '3.0 GiB', 'of 38.0 GiB', 'KV cache in use', '6.1 GiB', 'Waiting for memory', '1 request', '4.4 GiB asked for', 'Moved to the SSD', '2 requests'])
    expect(text).toContain(fact);
  expect(room!.tip!.paras.join(' ')).toContain('Not macOS memory');
  expect(room!.blocks).toContainEqual({ kind: 'meter', fraction: expect.closeTo(0.921, 3) });
  expect(spec).toMatchObject({ title: 'Draft token reuse', right: 'last 10 min' });
  expect(spec!.tip!.paras.join(' ')).toContain('Across all Splash requests');
  expect(JSON.stringify(spec)).toContain('71%');
  // Nothing reported, nothing drawn.
  expect(presentServer(snapshot(), MOCK_NOW).cards.map(card => card.key)).not.toContain('room');
  expect(serverMarkup(presentServer(body, MOCK_NOW), new Set()).markup).toContain('Memory room');
});

test('5.5 Memory thief: the room says whether another chat could start, and the apps holding the most memory follow it', () => {
  const body = snapshot(s => {
    s.runtime.memory.room = { limitBytes: 40_802_189_312, headroomBytes: 3_251_042_736, hostSpareBytes: 3_027_517_440, hostSpareReserveBytes: 3_607_772_525,
      hostHeadroomBytes: 0, deniedReservations: 152 };
    s.capabilities['server.memory.room'] = { scope: 'server', basis: 'reported' };
    s.host!.apps = { sampledAt: MOCK_NOW - 5_000, sinceAt: MOCK_NOW - 600_000, items: [{ name: 'Exampleapps', bytes: 2_418_016_256, grewBytes: 1_073_741_824 },
      { name: 'opencode', bytes: 1_413_480_448 }] };
    s.capabilities['host.apps'] = { scope: 'host', basis: 'reported' };
  });
  const cards = presentServer(body, MOCK_NOW).cards, room = cards.find(card => card.key === 'room')!, apps = cards.find(card => card.key === 'apps')!;
  expect(JSON.stringify(room)).toContain('Room for another chat');
  expect(JSON.stringify(room)).toContain('Closed');
  expect(JSON.stringify(room)).toContain('0.5 GiB short of the 3.4 GiB it keeps spare');
  expect(cards.findIndex(card => card.key === 'apps')).toBe(cards.findIndex(card => card.key === 'room') + 1);
  expect(apps).toMatchObject({ title: 'Holding the most memory' });
  expect(JSON.stringify(apps)).toContain('Exampleapps');
  expect(JSON.stringify(apps)).toMatch(/\+1\.0 GiB since /);
  expect(apps.tip!.paras.join(' ')).toContain('Names stay on this Mac');
  // Open: the room above the reserve; no apps capability, no apps line.
  const open = snapshot(s => {
    s.runtime.memory.room = { hostSpareBytes: 5_000_000_000, hostSpareReserveBytes: 3_607_772_525, hostHeadroomBytes: 1_392_227_475 };
    s.capabilities['server.memory.room'] = { scope: 'server', basis: 'reported' };
  });
  expect(JSON.stringify(presentServer(open, MOCK_NOW).cards.find(card => card.key === 'room'))).toContain('1.3 GiB above the 3.4 GiB it keeps spare');
  expect(presentServer(open, MOCK_NOW).cards.map(card => card.key)).not.toContain('apps');
});

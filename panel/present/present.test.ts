import { expect, test } from 'bun:test';
import { parseSnapshotV2, type SnapshotV2 } from '../../src/contract/snapshot.ts';
import type { TrendV2 } from '../../src/contract/trend.ts';
import type { AttributionLabel } from '../attribution/join.ts';
import type { TurnSummary } from '../attribution/turn.ts';
import { liveChart } from '../render/chart.ts';
import type { SignalPoint } from '../signal.ts';
import { MOCK_NOW, MOCK_STATES, mockBody } from '../testing/mock-states.ts';
import { APPROVAL, RESTART, TIP } from './copy.ts';
import { ago, delta, dur, kt, mmss, pct, size, tps } from './format.ts';
import { frameCard, presentHeader } from './header.ts';
import { heroKind, presentLive } from './live.ts';
import { frameReading, fromSnapshot } from './reading.ts';
import { SERVER_WIDE, type ScopeInput } from './scope.ts';
import { presentServer } from './server.ts';

// 2.0 presenters on the approved G2 mock's v2 states (docs/design/2.0-mock-fixtures.json): the strings the mock shows,
// the basis rule, the left-out rule and the honesty wording, pinned next to the presenters.
const snapshotOf = (state: string, now = MOCK_NOW): SnapshotV2 => parseSnapshotV2(JSON.parse(JSON.stringify(mockBody(state, { now }))))!;
const inputOf = (state: string, extra: Partial<ScopeInput> = {}): ScopeInput => {
  const snapshot = snapshotOf(state), last = snapshot.completions.items.at(-1) ?? null;
  return { now: MOCK_NOW, version: '2.0.0', snapshot, fresh: true, frame: null, paused: false, attribution: { kind: 'inferred' }, chatRuntime: null,
    last: last ? { completion: last, label: last.verdict?.attr === 'inferred' ? { kind: 'inferred' } : SERVER_WIDE, vsUsual: null, flag: null } : null,
    samples: [], turnStartAt: null, ...extra };
};
const everything = (value: unknown): string => JSON.stringify(value);

test('every mock state parses, and no view anywhere says VRAM or invents a zero for a missing reading', () => {
  expect(MOCK_STATES.length).toBeGreaterThan(30);
  for (const state of MOCK_STATES) {
    const input = inputOf(state), text = everything([presentLive(input), presentServer(input.snapshot, MOCK_NOW), presentHeader(input)]);
    expect(text, state).not.toMatch(/VRAM|NaN|undefined|Infinity/);
  }
});

test('format: the mock\'s numbers', () => {
  expect([tps(26.4), tps(598.2), tps(1_204.4), kt(612), kt(52_700), kt(131_072), kt(1_310_000), pct(0.83), delta(-0.175), delta(0.02), delta(0)])
    .toEqual(['26.4', '598', '1,204', '612', '52.7K', '131K', '1.31M', '83%', '−17%', '+2%', '±0%']);
  expect([dur(520), dur(3_800), dur(38_000), dur(112_000), dur(300_000), size(17.1 * 2 ** 30), ago(MOCK_NOW - 60_000, MOCK_NOW), mmss(108_000)])
    .toEqual(['0.52 s', '3.8 s', '38 s', '1 m 52 s', '5 min', '17.1 GiB', '1 min ago', '1:48']);
});

test('decode: one hero speed with its basis ⓘ, context used, the request tiles, and This Mac with the short labels', () => {
  const view = presentLive(inputOf('decode')), hero = view.hero!;
  expect(heroKind(inputOf('decode'))).toBe('decode');
  expect(hero.title).toBe('Example-27B-4bit');
  expect(hero.body).toMatchObject({ kind: 'decode' });
  expect(hero.instrument.measurement).toMatchObject({ text: '26.4', basis: 'reported' });
  expect(hero.engineTrend?.chart).toBeNull();
  expect(hero.attr?.chip).toEqual({ text: 'Likely this chat', attr: 'inferred' });
  expect(hero.attr?.tip.paras.join(' ')).toContain('Alternating requests from another chat can’t be ruled out.');
  expect(hero.context?.used).toBe('52.7K of 131K tokens');
  expect(hero.reply?.values.map(v => [v.strong, v.unit, v.basis])).toEqual([['24.9', 'tok/s', 'last-observed'], ['1,104', 'out', 'reported']]);
  expect(view.tiles.map(tile => [tile.label, tile.value, tile.detail])).toEqual([['Output', '612', 'tokens so far'], ['Elapsed', '38 s', 'since it started'],
    ['Input reused', '83%', '43.0K cached'], ['Requests', '1', 'Queue clear']]);
  const mac = view.mac!;
  expect(mac.title).toBe('This Mac');
  expect(mac.line.map(item => `${item.label} ${item.value}`)).toEqual(['CPU 31%', 'Memory allocated 36.1 / 48 GiB', 'Swap 1.1 GiB']);
  expect(mac.rows.map(row => `${row.label}: ${row.value.text} (${row.level})`)).toEqual(['Memory pressure: Normal (normal)', 'Heat status: Normal (normal)']);
  expect(mac.details.map(row => row.label)).toEqual(['GPU busy', 'GPU memory', 'oMLX model memory / GPU memory limit',
    'oMLX process memory (:8000)', 'Chip power', 'Tokens per joule · this request']);
  expect(mac.details.find(row => row.key === 'power')?.value).toEqual({ text: '38.4 W', basis: 'estimate' });
  // The concise ⓘ still names the driver, shared memory, and whole-chip power scope.
  expect(mac.tip.paras.join(' ')).toContain('GPU readings come from macOS and do not trigger warnings. GPU memory includes reserves and other apps, not just the model.');
  expect(mac.tip.paras.join(' ')).toContain('macmon estimates power used by all parts of the chip across all apps, not power at the wall.');
  expect(view.callouts).toEqual([]);
});

test('the live chart appears only after 2 readings and never draws across a gap', () => {
  const point = (at: number, rate: number, segment: number): SignalPoint => ({ at, rate, phase: 'decode', segment });
  expect(liveChart([point(MOCK_NOW - 500, 26, 1)], MOCK_NOW, null)).toBeNull();
  const chart = liveChart([point(MOCK_NOW - 20_000, 25, 1), point(MOCK_NOW - 19_500, 26, 1), point(MOCK_NOW - 1_000, 26.4, 2), point(MOCK_NOW - 500, 26.2, 2)], MOCK_NOW, MOCK_NOW - 38_000)!;
  expect(chart.ceiling).toBe('30 tok/s');
  expect(chart.line.match(/M/g)).toHaveLength(2);
  expect(chart.mark).not.toBeNull();
  expect(chart.label).toMatch(/^Generation speed · average for this request, last 20 s: 25\.0 to 26\.4 tokens per second, now 26\.2$/);
});

test('attribution chips: inferred and armed say so; server-wide always names its reason', () => {
  const chip = (attribution: AttributionLabel) => presentLive(inputOf('decode', { attribution })).hero!.attr!.chip;
  expect(chip({ kind: 'armed' })).toEqual({ text: 'Next reply', attr: 'armed', outline: true });
  expect(chip({ kind: 'server-wide', reason: 'model-differs' }).text).toBe('All server activity · different chat model');
  expect(presentLive(inputOf('decode', { attribution: { kind: 'server-wide', reason: 'other-provider' }, chatRuntime: 'Splash' })).hero!.attr!.chip.text)
    .toBe('All server activity · this chat uses Splash');
  // Readings server-wide by nature carry their own reason, whatever the join says.
  expect(presentLive(inputOf('llama')).hero!.attr!.chip.text).toBe('All server activity · several requests at once');
  expect(presentLive(inputOf('ollama')).hero!.attr!.chip.text).toBe('All server activity · request count unavailable');
  expect(presentLive(inputOf('admin-unauthorized')).hero!.attr!.chip.text).toBe('All server activity · all requests');
});

test('prefill: progress, counts and the server\'s own estimate lead; three tiles while nothing is output', () => {
  const view = presentLive(inputOf('prefill'));
  expect(view.hero!.body).toMatchObject({ kind: 'prefill', counts: '5,824 of 9,100 new tokens read', eta: '18 s' });
  expect(view.hero!.instrument.measurement).toMatchObject({ text: '64%', kind: 'progress' });
  expect(view.hero!.speeds.speeds[0]?.value).toBe('185');
  expect(view.tiles.map(tile => tile.label)).toEqual(['Elapsed', 'Input reused', 'Requests']);
  const stalled = presentLive(inputOf('prefill-stall'));
  expect(stalled.hero!.body).toMatchObject({ kind: 'prefill', eta: null });
  expect(stalled.callouts[0]).toMatchObject({ severity: 'warning', title: 'Prefill progress stopped moving' });
});

test('status messages own the view: one callout, the rest behind "N more", runtime-lost not repeated while failing', () => {
  const offline = presentLive(inputOf('offline'));
  expect(offline.callouts).toHaveLength(1);
  expect(offline.callouts[0]).toMatchObject({ severity: 'critical', title: 'oMLX stopped responding', action: { kind: 'connection', label: 'Connection…' } });
  expect(offline.callouts[0]!.detail).toBe('Start oMLX on :8000. Scope retries automatically.');
  expect(offline.hero).toMatchObject({ title: 'Local oMLX', body: null, attr: null });
  expect(offline.hero!.reply?.values[0]?.strong).toBe('24.9');
  const pressure = presentLive(inputOf('pressure'));
  expect(pressure.callouts.map(c => [c.severity, c.title])).toEqual([['warning', 'macOS memory pressure: warning'], ['info', 'Swap grew 1.3 GiB in 4 min']]);
  expect(presentLive(inputOf('pressure-critical')).callouts[0]).toMatchObject({ severity: 'critical', title: 'macOS memory pressure: critical' });
  expect(presentLive(inputOf('runtime-changed')).callouts[0]).toMatchObject({ title: 'Looks like Splash now', action: { kind: 'switch', label: 'Switch to Splash' } });
  expect(presentLive(inputOf('splash-recovering')).callouts[0]).toMatchObject({ severity: 'warning', title: 'Splash is recovering' });
  expect(presentLive(inputOf('thermal')).callouts[0]?.title).toBe('Heat: heavy');
  expect(presentLive(inputOf('model-unloaded')).callouts[0]?.title).toBe('Example-27B-4bit was unloaded');
  expect(presentLive(inputOf('memory-guard')).callouts[0]?.detail).toContain('Reported by oMLX · new requests wait until enough memory is available');
});

test('paused, stale and frame states never show a live rate', () => {
  const paused = presentLive(inputOf('decode', { paused: true }));
  expect(paused.hero).toMatchObject({ title: 'Example-27B-4bit', body: { kind: 'paused' }, reply: null });
  expect([paused.tiles, paused.mac]).toEqual([[], null]);
  const stale = presentLive(inputOf('decode', { fresh: false }), [{ key: 'stale', severity: 'warning', title: 'No fresh readings', detail: '', since: '', action: null }]);
  expect(stale.hero?.body ?? null).toBeNull();
  expect(stale.tiles).toEqual([]);
  expect(stale.mac?.stale).toBe(true);
  expect(presentHeader(inputOf('decode', { fresh: false })).phase).toBe('Refreshing');
  expect(presentHeader(inputOf('decode', { fresh: false, stale: true })).phase).toBe('Reconnecting');
});

test('needs approval and version skew replace every view with the S11 copy, and never mention a sessions grant', () => {
  const approval = inputOf('decode', { snapshot: null, frame: { reason: 'needs_approval', message: null } });
  expect(frameCard(approval)).toBe('approval');
  expect(presentHeader(approval)).toMatchObject({ phase: 'Needs approval', connection: null, data: { approval: true } });
  expect(frameCard(inputOf('decode', { snapshot: null, frame: { reason: 'contract_mismatch', message: null } }))).toBe('restart');
  const copy = everything(APPROVAL);
  expect(copy).toContain('MLX Scope needs one approval');
  expect(copy).not.toMatch(/sessions|project names|folders|chat titles/i);
  for (const path of ['/usr/sbin/ioreg', '/usr/bin/notifyutil', '/usr/sbin/lsof', '/usr/bin/footprint', '~/.lmstudio/bin/lms', '~/.cache/lm-studio/bin/lms',
    '/opt/homebrew/bin/macmon', '/usr/local/bin/macmon', 'vm_stat, sysctl']) expect(copy).toContain(path);
  expect(RESTART.steps).toEqual(['Open Settings → Extensions → MLX Scope.', 'Pause it, then resume it.']);
});

test('header: phase words and the accent state per status', () => {
  const header = (state: string) => presentHeader(inputOf(state));
  expect([header('decode').phase, header('decode').connection]).toEqual(['Generating', 'Local oMLX']);
  expect(header('offline')).toMatchObject({ phase: 'Offline', data: { phase: 'offline', stale: true } });
  expect(header('splash-recovering')).toMatchObject({ phase: 'Recovering', data: { phase: 'reconnecting' } });
  expect(header('bionic').connection).toBe('Splash via Bionic');
  expect(header('detecting').data.phase).toBe('detecting');
  expect(header('llama-sleeping').phase).toBe('Asleep');
});

test('Server: the server card with its detection basis, then only the cards the server fills', () => {
  const cards = (state: string) => presentServer(snapshotOf(state), MOCK_NOW).cards;
  const omlx = cards('decode');
  expect(omlx.map(card => card.title)).toEqual(['Server', 'Model memory', 'Cache & input', 'Loaded models', 'Overall average']);
  expect(everything(omlx[0])).toContain('/health answered · high confidence');
  expect(everything(omlx[0])).toContain('Last reading');
  expect(everything(omlx[1])).toContain('Model memory limit');
  expect(cards('llama').map(card => card.title)).toEqual(['Server', 'Slots', 'All server speeds', 'Draft token reuse', 'Model inventory']);
  expect(everything(cards('llama'))).toContain('derived');
  expect(everything(cards('ollama'))).toContain('GPU memory (from Ollama)');
  const bionic = cards('bionic').map(card => card.title);
  expect(bionic).toContain('Model software');
  expect(bionic).toContain('Loaded instances');
  expect(everything(cards('splash-recovering'))).toContain('Splash · last reading');
});

test('Server optional readings preserve measured zero and omit absent values with their labels', () => {
  const snapshot = snapshotOf('decode');
  snapshot.runtime.memory = { modelBytes: 0, processBytes: 1024 };
  snapshot.runtime.server.averages = { decodeTps: 0, cacheEfficiencyFraction: 0, requestsTotal: 0 };
  snapshot.runtime.server.cache = { ramBytes: 0, ramEntries: 0, ssdEntries: 12 };
  snapshot.runtime.request = null;
  const cards = presentServer(snapshot, MOCK_NOW).cards;
  expect(cards.find(card => card.key === 'memory')!.blocks).toEqual([{ kind: 'values', cols: 2, items: [
    { label: 'Model memory', value: { text: '0.0 GiB', basis: 'reported' } },
    { label: 'Process memory', value: { text: '0.0 GiB', basis: 'reported' } },
  ] }]);
  expect(cards.find(card => card.key === 'session')!.blocks).toEqual([{ kind: 'values', cols: 2, items: [
    { label: 'Generation speed', value: { text: '0.0 tok/s', basis: 'reported' } },
    { label: 'Cache efficiency', value: { text: '0%', basis: 'reported' } },
    { label: 'Completed', value: { text: '0', basis: 'reported' } },
  ] }]);
  expect(cards.find(card => card.key === 'cache')!.blocks).toEqual([{ kind: 'values', cols: 2, items: [
    { label: 'RAM cache', value: { text: '0.0 GiB', basis: 'reported' }, small: '0 entries' },
  ] }]);
  snapshot.runtime.server.averages = {};
  expect(presentServer(snapshot, MOCK_NOW).cards.some(card => card.key === 'session')).toBe(false);
});

test('an unidentified chat does not claim a reconnecting service or local connection', () => {
  const view = presentHeader(inputOf('decode', { snapshot: null, frame: { reason: 'chat_unavailable', message: 'Choose Whole engine' } }));
  expect(view).toMatchObject({ phase: 'Chat identity unavailable', connection: null, data: { phase: 'unknown' } });
});

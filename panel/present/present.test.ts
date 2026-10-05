import { expect, test } from 'bun:test';
import { parseSnapshotV2, type SnapshotV2 } from '../../src/contract/snapshot.ts';
import type { TrendV2 } from '../../src/contract/trend.ts';
import type { AttributionLabel } from '../attribution/join.ts';
import type { TurnSummary } from '../attribution/turn.ts';
import { liveChart } from '../render/chart.ts';
import type { SignalPoint } from '../signal.ts';
import { MOCK_NOW, MOCK_STATES, mockBody } from '../testing/mock-states.ts';
import { presentAlerts } from './alerts.ts';
import { presentCapture, presentGeneration, savedValue } from './captures.ts';
import { APPROVAL, RESTART, TIP } from './copy.ts';
import { ago, delta, dur, kt, mmss, pct, size, tps } from './format.ts';
import { frameCard, presentHeader } from './header.ts';
import { heroKind, presentLive } from './live.ts';
import { frameReading, fromSnapshot } from './reading.ts';
import { SERVER_WIDE, type ScopeInput } from './scope.ts';
import { presentServer } from './server.ts';
import { HEIGHTS, presentStatusSection, type StatusSectionInput } from './status.ts';

// 2.0 presenters on the approved G2 mock's v2 states (docs/design/2.0-mock-fixtures.json): the strings the mock shows,
// the basis rule, the left-out rule and the honesty wording, pinned next to the presenters.
const snapshotOf = (state: string, now = MOCK_NOW): SnapshotV2 => parseSnapshotV2(JSON.parse(JSON.stringify(mockBody(state, { now }))))!;
const inputOf = (state: string, extra: Partial<ScopeInput> = {}): ScopeInput => {
  const snapshot = snapshotOf(state), last = snapshot.completions.items.at(-1) ?? null;
  return { now: MOCK_NOW, version: '2.0.0', snapshot, fresh: true, frame: null, paused: false, attribution: { kind: 'inferred' }, chatRuntime: null,
    last: last ? { completion: last, label: last.verdict?.attr === 'inferred' ? { kind: 'inferred' } : SERVER_WIDE, vsUsual: null, flag: null } : null,
    next: { kind: 'idle' }, samples: [], turnStartAt: null, ...extra };
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
  expect(hero.body).toMatchObject({ kind: 'decode', rate: '26.4', source: 'Reported by oMLX', chart: null });
  expect(hero.attr?.chip).toEqual({ text: 'This chat · inferred', attr: 'inferred' });
  expect(hero.attr?.tip.paras.join(' ')).toContain('Alternating requests from another chat can’t be ruled out.');
  expect(hero.context?.used).toBe('52.7K of 131K tokens');
  expect(hero.reply?.values.map(v => [v.strong, v.unit, v.basis])).toEqual([['24.9', 'tok/s', 'last-observed'], ['1,104', 'out', 'reported']]);
  expect(hero.reply?.next).toEqual({ kind: 'offer' });
  expect(view.tiles.map(tile => [tile.label, tile.value, tile.detail])).toEqual([['Output', '612', 'tokens so far'], ['Elapsed', '38 s', 'since it started'],
    ['Input reused', '83%', '43.0K cached'], ['Requests', '1', 'Queue clear']]);
  const mac = view.mac!;
  expect(mac.title).toBe('This Mac');
  expect(mac.line.map(item => `${item.label} ${item.value}`)).toEqual(['CPU 31%', 'RAM 36.1 / 48 GiB', 'Swap 1.1 GiB']);
  expect(mac.rows.map(row => `${row.label}: ${row.value.text} (${row.level})`)).toEqual(['macOS memory pressure (kernel): Normal (normal)', 'Thermal pressure (macOS): Normal (normal)']);
  expect(mac.details.map(row => row.label)).toEqual(['GPU busy (driver-reported)', 'GPU memory · driver-reported', 'oMLX model memory vs macOS GPU wired limit',
    'oMLX process listening on :8000', 'Chip power · estimate', 'tok/J · this request']);
  expect(mac.details.find(row => row.key === 'power')?.value).toEqual({ text: '38.4 W', basis: 'estimate' });
  // The concise ⓘ still names the driver, shared memory, and whole-chip power scope.
  expect(mac.tip.paras.join(' ')).toContain('Driver GPU readings never alert. GPU memory includes reserves and other apps, not just the model.');
  expect(mac.tip.paras.join(' ')).toContain('macmon estimates CPU+GPU+ANE power across all apps, not wall power.');
  expect(view.callouts).toEqual([]);
});

test('the live chart appears only after 2 readings and never draws across a gap', () => {
  const point = (at: number, rate: number, segment: number): SignalPoint => ({ at, rate, phase: 'decode', segment });
  expect(liveChart([point(MOCK_NOW - 500, 26, 1)], MOCK_NOW, null)).toBeNull();
  const chart = liveChart([point(MOCK_NOW - 20_000, 25, 1), point(MOCK_NOW - 19_500, 26, 1), point(MOCK_NOW - 1_000, 26.4, 2), point(MOCK_NOW - 500, 26.2, 2)], MOCK_NOW, MOCK_NOW - 38_000)!;
  expect(chart.ceiling).toBe('30 tok/s');
  expect(chart.line.match(/M/g)).toHaveLength(2);
  expect(chart.mark).not.toBeNull();
  expect(chart.label).toMatch(/^Decode · request average, last 20 s: 25\.0 to 26\.4 tokens per second, now 26\.2$/);
});

test('attribution chips: inferred and armed say so; server-wide always names its reason', () => {
  const chip = (attribution: AttributionLabel) => presentLive(inputOf('decode', { attribution })).hero!.attr!.chip;
  expect(chip({ kind: 'armed' })).toEqual({ text: 'Next reply · armed', attr: 'armed', outline: true });
  expect(chip({ kind: 'server-wide', reason: 'model-differs' }).text).toBe('Server-wide · chat model differs');
  expect(presentLive(inputOf('decode', { attribution: { kind: 'server-wide', reason: 'other-provider' }, chatRuntime: 'Splash' })).hero!.attr!.chip.text)
    .toBe('Server-wide · this chat uses Splash');
  // Readings server-wide by nature carry their own reason, whatever the join says.
  expect(presentLive(inputOf('llama')).hero!.attr!.chip.text).toBe('Server-wide · overlapping requests');
  expect(presentLive(inputOf('ollama')).hero!.attr!.chip.text).toBe('Server-wide · runtime can’t count requests');
  expect(presentLive(inputOf('admin-unauthorized')).hero!.attr!.chip.text).toBe('Server-wide · all requests');
});

test('prefill: progress, counts and the runtime\'s own estimate lead; three tiles while nothing is output', () => {
  const view = presentLive(inputOf('prefill'));
  expect(view.hero!.body).toMatchObject({ kind: 'prefill', percent: '64%', counts: '5,824 of 9,100 new tokens read', eta: '18 s', rate: '185' });
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
  expect(presentLive(inputOf('thermal')).callouts[0]?.title).toBe('Thermal pressure: heavy');
  expect(presentLive(inputOf('model-unloaded')).callouts[0]?.title).toBe('Example-27B-4bit was unloaded');
  expect(presentLive(inputOf('memory-guard')).callouts[0]?.detail).toContain('not macOS memory pressure');
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
  expect(copy).toContain('MLX Scope 2.0 needs one approval');
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

test('Server: the runtime card with its detection basis, then only the cards the runtime fills', () => {
  const cards = (state: string) => presentServer(snapshotOf(state), MOCK_NOW).cards;
  const omlx = cards('decode');
  expect(omlx.map(card => card.title)).toEqual(['Runtime', 'Runtime memory', 'Cache & input', 'Loaded models', 'Server session']);
  expect(everything(omlx[0])).toContain('/health answered · high confidence');
  expect(everything(omlx[0])).toContain('Last observed by Scope');
  expect(everything(omlx[1])).toContain('Engine-pool ceiling');
  expect(cards('llama').map(card => card.title)).toEqual(['Runtime', 'Slots', 'Server throughput', 'Speculative decoding', 'Model inventory']);
  expect(everything(cards('llama'))).toContain('derived');
  expect(everything(cards('ollama'))).toContain('GPU-resident (Ollama-reported)');
  const bionic = cards('bionic').map(card => card.title);
  expect(bionic).toContain('Engines');
  expect(bionic).toContain('Loaded instances');
  expect(everything(cards('splash-recovering'))).toContain('Splash native · last observed');
});

const statusOf = (state: string, extra: Partial<StatusSectionInput> = {}) => {
  const snapshot = snapshotOf(state), last = snapshot.completions.items.at(-1) ?? null;
  return presentStatusSection({ now: MOCK_NOW, reading: fromSnapshot(snapshot), snapshot, attribution: { kind: 'inferred' }, turn: null, vsUsual: null,
    sparkline: null, chatIsLocal: true, expanded: false, tipDismissed: true, fresh: true,
    last: last ? { completion: last, label: last.verdict?.attr === 'inferred' ? { kind: 'inferred' } : SERVER_WIDE } : null, ...extra });
};
const trend = (values: Array<number | null>): TrendV2 => ({ contractVersion: 2, serverNow: MOCK_NOW, windowMs: 900_000, bucketMs: 5_000, startAt: MOCK_NOW - 900_000,
  series: { decodeTps: { basis: 'reported', buckets: values.map(v => v === null ? null : [v, v, v]) } }, gaps: [], marks: [] });

test('Work Status glance: 56 px, 80 with an alert, 24 for a non-local chat, 96 with the one-time tip', () => {
  expect(statusOf('decode')).toMatchObject({ mode: 'glance', height: HEIGHTS.glance, glance: { line1: { model: 'Example-27B', rate: '26.4', chip: { text: 'This chat · inferred' } } } });
  expect(statusOf('pressure')).toMatchObject({ height: HEIGHTS.alert, glance: { alert: { severity: 'warning', text: 'macOS memory pressure: warning', more: 1 } } });
  expect(statusOf('decode', { chatIsLocal: false })).toMatchObject({ mode: 'non-local', height: 24 });
  expect(statusOf('decode', { tipDismissed: false })).toMatchObject({ height: 96, glance: { line2: null, notice: { text: TIP, dismiss: 'tip' } } });
  // A server-wide chip is short and needs its reason line, so the reason stays beside the tip.
  expect(statusOf('decode', { tipDismissed: false, attribution: { kind: 'server-wide', reason: 'not-observed' } }))
    .toMatchObject({ height: 120, glance: { line1: { chip: { text: 'Server-wide' }, describedBy: true }, line2: { reason: 'not observed' }, notice: { dismiss: 'tip' } } });
  expect(TIP).toBe('Replace Turn stats: hide it in Panel sections and drag MLX Scope into its place');
  expect(statusOf('idle', { firstRun: true })).toMatchObject({ height: 80, glance: { notice: { text: 'Recording reply history locally', action: 'Open Scope to manage' } } });
  expect(statusOf('prefill').glance!.line2).toEqual({ kind: 'prefill', percent: '64%', eta: '18 s', toggle: true });
  expect(statusOf('offline').glance!.line1).toMatchObject({ dot: 'bad', title: 'oMLX stopped responding' });
  expect(statusOf('splash-recovering').glance!.line2).toEqual({ kind: 'note', text: 'Scope reads its status every 30 s' });
  const approval = presentStatusSection({ ...statusInputFrame('needs_approval') });
  expect(approval).toMatchObject({ height: 56, glance: { line1: { title: 'MLX Scope 2.0 needs one approval' } } });
  // A withheld live reading: a short chip whose reason is line 2.
  const withheld = statusOf('decode', { attribution: { kind: 'server-wide', reason: 'model-differs' } });
  expect(withheld.glance!.line1).toMatchObject({ chip: { text: 'Server-wide' }, describedBy: true });
  expect(withheld.glance!.line2).toMatchObject({ kind: 'spark', reason: 'chat model differs' });
  // The glance reserves its limited space for reply measurements and warnings; GPU remains in details.
  expect(statusOf('decode').glance!.line2).toMatchObject({ chips: [] });
  expect(statusOf('pressure-critical').glance!.alert).toMatchObject({ severity: 'critical' });
});
const statusInputFrame = (reason: 'needs_approval' | 'contract_mismatch'): StatusSectionInput => ({ now: MOCK_NOW, reading: frameReading(reason, null, MOCK_NOW),
  snapshot: null, attribution: SERVER_WIDE, turn: null, vsUsual: null, sparkline: null, chatIsLocal: null, expanded: false, tipDismissed: true });

test('the sparkline needs 2 readings and breaks where the trend has no reading', () => {
  expect(statusOf('decode', { sparkline: trend([null, 26, null]) }).glance!.line2).toMatchObject({ spark: null });
  const line = statusOf('decode', { sparkline: trend([25, 26, null, 24, 25]) }).glance!.line2 as { spark: { path: string; label: string } };
  expect(line.spark.path.match(/M/g)).toHaveLength(2);
  expect(line.spark.label).toBe('Decode speed, last 15 min: 24.0 to 26.0 tokens per second');
});

test('Turn stats replacement: the host\'s rows, basis only on non-reported rows, unreportable rows left out, ≤ 200 px', () => {
  const summary: TurnSummary = { wallMs: 112_000, modelMs: 75_000, toolMs: 37_000, steps: 3, firstTtftMs: 520, promptTokens: 54_400, cachedTokens: 33_200,
    outputTokens: 3_104, decodeTps: 38.1, cacheFraction: 0.61 };
  const fullTurn: Partial<StatusSectionInput> = { expanded: true, turn: summary, vsUsual: { metric: 'decodeTps', ratio: 1.02, n: 23, basis: 'reported' },
    last: { completion: snapshotOf('bionic').completions.items.at(-1)!, label: { kind: 'inferred' } } };
  const bionic = statusOf('bionic', fullTurn);
  expect(bionic.mode).toBe('turn-stats');
  expect(bionic.rows.map(row => row.label)).toEqual(['Response', 'Turn time', 'Model · tool time', 'First token', 'Tokens in · out', 'Cache %', 'Context used', 'vs usual']);
  expect(bionic.rows.map(row => row.basis)).toEqual(['derived', 'observed', 'observed', null, null, null, 'derived', 'derived']);
  expect(bionic.height).toBe(192);
  expect(bionic.turn).toMatchObject({ title: 'Last turn', sub: '3 steps', chip: { text: 'This chat · inferred' } });
  const pressure = snapshotOf('pressure'), warning = { ...snapshotOf('bionic'), alerts: pressure.alerts, host: pressure.host };
  const largest = statusOf('bionic', { ...fullTurn, snapshot: warning });
  expect(largest.rows).toEqual(bionic.rows);
  expect(largest.turn?.alert?.severity).toBe('warning');
  expect(largest.height).toBe(200);
  // oMLX reports no TTFT: the row is left out, and token counts are Scope's last readings.
  const omlx = statusOf('idle', { expanded: true, turn: { ...summary, firstTtftMs: null }, last: { completion: snapshotOf('idle').completions.items.at(-1)!, label: { kind: 'inferred' } } });
  expect(omlx.rows.map(row => row.label)).not.toContain('First token');
  expect(omlx.rows.find(row => row.label === 'Tokens in · out')?.basis).toBe('last observed');
  expect(omlx.rows.find(row => row.label === 'Context used')?.basis).toBe('last observed');
  // A withheld turn: no summary; the last reply, server-wide, with its reason.
  const withheld = statusOf('bionic', { expanded: true, last: { completion: snapshotOf('bionic').completions.items.at(-1)!, label: { kind: 'server-wide', reason: 'overlap' } } });
  expect(withheld.turn).toMatchObject({ title: 'Last reply', reason: 'overlapping requests · no turn summary', chip: { text: 'Server-wide' } });
  expect(withheld.rows.map(row => row.label)).toEqual(['Response', 'First token', 'Tokens in · out', 'Cache %', 'Context used']);
  expect(withheld.rows.find(row => row.label === 'Context used')?.basis).toBe('derived');
  for (const view of [bionic, omlx, withheld]) expect(view.height).toBeLessThanOrEqual(200);
});

test('alerts: most severe first, the log with durations', () => {
  const snapshot = snapshotOf('pressure'), view = presentAlerts(snapshot.alerts, snapshot.alertLog, MOCK_NOW);
  expect(view.top).toMatchObject({ severity: 'warning', text: 'macOS memory pressure: warning' });
  expect(view.rows.map(row => row.id)).toEqual(['pressure-warning', 'swap-growth']);
  expect(view.log.length).toBe(snapshot.alertLog.length);
  expect(view.log.every(entry => entry.duration)).toBe(true);
});

test('captures, recent generations and saved values format bytes through the one GiB formatter', () => {
  const capture = { model: 'm', targetSeconds: 30 as const, startedAt: 0, lastAt: 1, seconds: 12.34, samples: 25, decodeSeconds: 10, decodeTokens: 250,
    peakProcessBytes: 34.5e9, processSamples: 3, meanCPU: 28.44, peakCPU: 35.1, cpuSamples: 6, meanMemoryBytes: Math.round(36.1 * 1024 ** 3),
    peakMemoryBytes: 48 * 1024 ** 3, memorySamples: 6, requestCountChange: 2, startSwapBytes: null, lastSwapBytes: null, status: 'finished' as const, note: 'n' };
  expect(presentCapture(capture, null, false, null)).toMatchObject({ state: 'Captured', speed: '25.0 tok/s', memory: '32.1 GiB', cpu: '28.4 / 35.1 %',
    hostMemory: '36.1 / 48.0 GiB', requests: '2', duration: '12.3s', change: 'Different observation' });
  expect(presentGeneration({ sequence: 1, model: 'org/model', epoch: 1, firstSeenAt: 0, lastSeenAt: 0, outputTokens: 1_234, averageTPS: 24,
    elapsedMs: 1_000, promptTokens: null, cachedTokens: null, peakProcessBytes: 34.5e9, coverage: 'monitoring-gap' }))
    .toMatchObject({ name: 'model', speed: '24 tok/s', tokens: '1,234 tokens last seen', note: 'Monitoring gap · 32.1 GiB peak observed footprint' });
  expect([savedValue('prefillRemaining', 0.4), savedValue('memory', 36.10000000037253), savedValue('cpu', null)]).toEqual(['<1', '36.1', '—']);
});

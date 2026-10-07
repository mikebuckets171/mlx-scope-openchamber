process.env.TZ = 'UTC';
import { describe, expect, test } from 'bun:test';
import { buildBaselines } from '../history/baselines.ts';
import type { ReplyRow } from '../history/ledger-schema.ts';
import { evaluateRegression } from '../history/regress.ts';
import { MOCK_TEXT } from '../testing/history-text.ts';
import { MOCK_MODELS, MOCK_NOW, mockAccounting, mockLedgerRows, mockSnapshot, mockTrend, mockUsage } from '../testing/mock-history.ts';
import { gap, reply, turn } from '../testing/rows.ts';
import { attrChip, delta, dur, HISTORY_LIST_LIMIT, kt, presentHistory, storageSize, type HistoryInput } from './history.ts';

const NOW = MOCK_NOW, rows = mockLedgerRows();
const replies = rows.filter((row): row is ReplyRow => row[0] === 'r');
const input = (extra: Partial<HistoryInput> = {}): HistoryInput => ({
  now: NOW, trend: mockTrend(), rows, models: MOCK_MODELS, baselines: buildBaselines(replies, NOW), flags: [], usage: mockUsage(), storage: mockAccounting(),
  paused: false, retentionDays: 30, alertLog: mockSnapshot().alertLog, runtimeName: 'oMLX', model: 'Example-27B-4bit', text: MOCK_TEXT, ...extra,
});
const text = (value: unknown): string => JSON.stringify(value);

describe('History presenter (plan §5.6, G2 mock)', () => {
  test('the Replies header and counts per basis say what was observed while Scope was open', () => {
    const view = presentHistory(input());
    expect(view.header).toBe('Recorded while Scope was open');
    expect(view.counts).toEqual(['41 last reading', '1 gap']);
    expect(view.basisCounts).toEqual([{ basis: 'last reading', n: 41 }]);
  });
  test('the list is newest first: a turn above its last step, the gap in its place, each reply with its label', () => {
    const view = presentHistory(input());
    expect(presentHistory(input({ listLimit: 12 })).entries.map(e => e.kind === 'gap' ? e.text : e.kind === 'turn' ? `${e.at} ${e.title}` : `${e.at} ${e.rate} ${e.attr.text}`)).toEqual([
      '14:04 Turn · 3 steps', '14:04 24.9 tok/s Likely this chat', '13:58 25.6 tok/s Likely this chat', '13:56 25.1 tok/s Likely this chat',
      '13:51 24.3 tok/s Next reply', '13:49 23.8 tok/s Server-wide · overlapping requests', 'Not recorded · Scope wasn’t open · 13:24–13:46',
      '13:22 24.4 tok/s Server-wide · outside this chat’s turn', '13:17 24.0 tok/s Likely this chat', '13:09 23.6 tok/s Server-wide · not observed',
      'Sep 28 24.4 tok/s Server-wide · not observed', 'Sep 28 26.2 tok/s Likely this chat']);
    expect(view.entries).toHaveLength(HISTORY_LIST_LIMIT);
    expect(view.more).toBe('Showing the newest 6 of 43 entries');
    expect(view.showMore).toBe('Show 24 more');
    expect(presentHistory(input({ listLimit: 60 })).more).toBeNull();
  });
  test('a turn summary: observed time minus waits, token-weighted rate, reuse from its own steps', () => {
    const [first] = presentHistory(input()).entries;
    expect(first).toEqual(expect.objectContaining({ kind: 'turn', title: 'Turn · 3 steps', time: '2 m 46 s', rate: '25.2 tok/s token-weighted',
      detail: '3,284 out · 84% of input reused', attr: { attr: 'inferred', text: 'Likely this chat', reason: null } }));
    const lone = presentHistory(input({ rows: [turn(NOW - 60_000, NOW - 1000, { steps: 2, output: 500, wDecodeTps: 30 })] })).entries[0];
    expect(lone).toEqual(expect.objectContaining({ title: 'Turn · 2 steps', detail: '500 out', time: '59 s' }));
  });
  test('reply rows keep their basis label and never show a TTFT the server did not report', () => {
    const [, row] = presentHistory(input()).entries;
    expect(row).toEqual(expect.objectContaining({ kind: 'reply', rate: '24.9 tok/s', basis: 'last-observed', basisLabel: 'last reading',
      detail: '1,104 out · 49.8K in (41.2K cached)', ttft: null, model: null }));
    const bionic = presentHistory(input({ rows: [reply({ at: NOW - 60_000, rt: 'lmstudio', decodeTps: 38.6, ttftMs: 520, prompt: 18_400, cached: 11_260, output: 1092 })] }));
    expect(bionic.entries[0]).toEqual(expect.objectContaining({ basisLabel: null, ttft: 'First token 0.52 s', detail: '1,092 out · 18.4K in (11.3K cached)' }));
    const noRate = presentHistory(input({ rows: [reply({ at: NOW - 60_000, decodeTps: null, output: 12, prompt: 400 })] }));
    expect(noRate.entries[0]).toEqual(expect.objectContaining({ rate: null, output: '12 out', detail: '400 in' }));
  });
  test('rows name their model only when the list mixes models', () => {
    const mixed = presentHistory(input({ rows: [reply({ at: NOW - 60_000, modelRef: 0 }), reply({ at: NOW - 120_000, modelRef: 1 })] }));
    expect(mixed.entries.map(e => e.kind === 'reply' && e.model)).toEqual(['Example-27B-4bit', 'Example-35B-A3B-4bit']);
  });
  test('a server-wide chip always names its reason; an unknown stored reason reads as not observed', () => {
    expect(attrChip('withheld:overlap', MOCK_TEXT)).toEqual({ attr: 'server', text: 'Server-wide · overlapping requests', reason: 'overlap' });
    expect(attrChip('not-observed', MOCK_TEXT).text).toBe('Server-wide · not observed');
    expect(attrChip('withheld:made-up' as never, MOCK_TEXT)).toEqual({ attr: 'server', text: 'Server-wide · not observed', reason: 'not-observed' });
    expect(attrChip('armed', MOCK_TEXT).text).toBe('Next reply');
  });
  test('empty after a fresh upgrade: honest lines, and the 1.6 captures pointer only when there are some', () => {
    const empty = presentHistory(input({ rows: [], baselines: new Map(), trend: mockTrend(3_600_000, true), storage: { ...mockAccounting(), ledgerBytes: 2048 }, alertLog: [], legacyCaptures: 3 }));
    expect(empty.repliesEmpty).toBe('No replies yet. Scope records a reply when it finishes while any Scope view is open. Your 1.6 captures are in Captures.');
    expect(presentHistory(input({ rows: [] })).repliesEmpty).not.toContain('1.6');
    expect(empty.baseline).toEqual(expect.objectContaining({ model: 'Example-27B-4bit', bucket: null, empty: 'Needs 5 replies for this model and context size.', copy: false }));
    expect(empty.storage).toEqual(expect.objectContaining({ used: '2 KiB', detail: 'of 1.25 MiB · 0 replies · 0 days' }));
    expect(empty.alertLogEmpty).toBe('No alerts while Scope was open.');
    expect(empty.trend.geometry).toBeNull();
    expect(empty.trend.gaps).toHaveLength(1);
    expect(empty.trend.empty).toBeNull();
    expect(empty.trend.summary).toBe('Generation speed over the last 60 min: no line yet; not observed from 13:05 to 14:03.');
  });
  test('the trend card: basis in the title, a round ceiling, a summary for screen readers, gaps as percentages', () => {
    const { trend } = presentHistory(input());
    expect(trend.title).toBe('Generation speed · from oMLX');
    expect(trend.ceiling).toBe('30 tok/s');
    expect(trend.windows.map(w => [w.label, w.pressed])).toEqual([['15 min', false], ['30 min', false], ['60 min', true]]);
    expect(trend.summary).toBe('Generation speed over the last 60 min: 6 turns, 21.5 to 27.6 tokens per second; not observed from 13:24 to 13:46.');
    expect(trend.gaps).toEqual([{ left: '31.91%', width: '36.18%' }]);
    expect(trend.note).toBe('Reply times from OpenChamber · all server activity');
    expect(presentHistory(input({ trend: null })).trend.empty).toBe('Loading the trend…');
    expect(presentHistory(input({ trend: { ...mockTrend(), series: {} }, runtimeName: 'Ollama' })).trend.empty).toBe('Ollama doesn’t report generation speed, so there’s no trend.');
    expect(presentHistory(input({ trend: { ...mockTrend(900_000), gaps: [], series: { decodeTps: { basis: 'derived', buckets: Array(180).fill(null) } } }, runtimeName: 'llama-server' })).trend)
      .toEqual(expect.objectContaining({ title: 'Generation speed · calculated from llama-server totals', empty: 'No generation readings in the last 15 min. The chart starts after 2 readings.' }));
  });
  test('usual speed: p50/p90 with n, prefill, no tok/J from last-observed replies, and TTFT the server never reported', () => {
    const { baseline } = presentHistory(input());
    expect(baseline.model).toBe('Example-27B-4bit');
    expect(baseline.bucket).toBe('32–64K context');
    expect(baseline.tiles.map(t => [t.label, t.value, t.detail])).toEqual([['Typical generation', '25.9 tok/s', '33 replies'], ['Fast generation', '27.2 tok/s', '33 replies'],
      ['Typical prefill', '597 tok/s', '30 replies']]);
    // oMLX replies are last-observed: their token counts are not final, so no tok/J baseline forms (plan §5.6; the mock showed one).
    expect(baseline.rows).toEqual([{ label: 'First token', value: 'No baseline · oMLX doesn’t report it', basis: null }]);
    expect(baseline.copy).toBe(true);
  });
  test('a regression flag on the card lists co-factors as observed during, never as causes', () => {
    const recent = [0, 1, 2].map(i => reply({ at: NOW - (i + 1) * 60_000, decodeTps: 19, prompt: 40_000, cached: 32_000, ctxB: 2, uncB: 0, cofactors: i ? 0 : 1 | 2 }));
    const all = [...rows, ...recent], baselines = buildBaselines(all.filter((r): r is ReplyRow => r[0] === 'r'), NOW);
    const flags = evaluateRegression(recent, baselines, NOW, []);
    const { baseline } = presentHistory(input({ rows: all, baselines, flags }));
    expect(baseline.flag).toEqual({ chip: 'Slower · −27% · last 3', tip: ['Middle value of the last 3 replies 19.0 tok/s against usual 25.9 tok/s (33 replies).',
      'Observed during these replies, not necessarily the cause: macOS memory pressure at warning or above; swap grew.'] });
  });
  test('recorded by oMLX: daily bars, totals, never merged, hidden when oMLX cannot give its records', () => {
    const { usage } = presentHistory(input());
    expect(usage!.title).toBe('Recorded by oMLX');
    expect(usage!.bars.map(b => b.label)).toEqual(['23', '24', '25', '26', '27', '28', '29']);
    expect(usage!.bars.map(b => b.height)).toEqual([37, 52, 27, 2, 47, 72, 61]);
    expect(usage!.rows).toEqual([{ label: 'Requests', value: '412' }, { label: 'Prompt', value: '18.2M', detail: '13.9M cached' }, { label: 'Output', value: '1.31M' }]);
    expect(usage!.tip).toEqual(['oMLX’s own records for every app that used it: output tokens per day. Refreshed 3 min ago.', 'Never merged into Scope’s history, and it has no First token.']);
    expect(presentHistory(input({ usage: { ...mockUsage(), available: false, reason: 'admin_unauthorized' } })).usage).toBeNull();
    const month = presentHistory(input({ usage: mockUsage('30d'), usageRange: '30d' })).usage!;
    expect(month.dense).toBe(true);
    expect(month.bars).toHaveLength(30);
    expect(month.bars.filter(b => b.label).length).toBeLessThanOrEqual(10);
    const hourly = mockUsage(); hourly.granularity = 'hour';
    hourly.buckets = hourly.buckets.flatMap(b => [0, 1, 2].map(h => ({ ...b, at: b.at + h * 3_600_000, outputTokens: b.outputTokens! / 3 })));
    expect(presentHistory(input({ usage: hourly })).usage!.bars.map(b => b.height)).toEqual([37, 52, 27, 2, 47, 72, 61]);
  });
  test('reply history storage: usage bar, retention, pause, full and the clear confirmation', () => {
    const view = presentHistory(input()).storage!;
    expect(view).toEqual(expect.objectContaining({ used: '412 KiB', detail: 'of 1.25 MiB · 41 replies · 13 days', retention: '30 days', paused: false, full: null,
      label: 'Stored on this Mac', options: [7, 14, 30, 60, 90], meter: true, confirm: null }));
    expect(view.fraction).toBeCloseTo(0.322, 3);
    const full = presentHistory(input({ storage: mockAccounting(true) })).storage!;
    expect(full.detail).toBe('at the limit · 41 replies · 13 days');
    expect(full.full).toBe('After each save Scope removes the oldest replies, so it holds 13 of your 30 days. Shorten retention or clear to make room.');
    expect(presentHistory(input({ paused: true })).storage).toEqual(expect.objectContaining({ paused: true, label: 'Recording paused' }));
    expect(presentHistory(input({ confirmClear: true })).storage!.confirm).toEqual({ title: 'Clear 41 replies and the baselines built from them?', detail: 'This can’t be undone. Captures are kept.' });
    expect(presentHistory(input({ retentionDays: 45 })).storage!.options).toEqual([7, 14, 30, 45, 60, 90]);
    expect(presentHistory(input({ storage: null })).storage).toEqual(expect.objectContaining({ used: '41 replies', detail: '13 days', meter: false }));
    expect(presentHistory(input({ recording: 'backoff' })).storage!.note).toContain('nothing is removed because of an error');
  });
  test('the alert log: newest first as the service sends it, with severity words and durations', () => {
    expect(presentHistory(input()).alertLog.map(a => [a.at, a.severityWord, a.text, a.duration])).toEqual([
      ['10:53', 'Notice', 'Swap grew 1.2 GiB in 4 min', '5 min'], ['09:25', 'Notice', 'Example-35B-A3B-4bit was unloaded', '2 min'],
      ['08:02', 'Critical', 'oMLX stopped responding', '6 min'], ['Sep 28', 'Warning', 'macOS memory pressure: warning', '9 min']]);
  });
  test('honest by construction: no VRAM, no zero for idle, nothing class A', () => {
    const all = text(presentHistory(input()));
    expect(all).not.toMatch(/VRAM|sessionId|\/Users\/|api_key/i);
    expect(presentHistory(input()).trend.geometry!.segments.join(' ')).not.toMatch(/ 116\.0/);
  });
  test('formatting follows the mock', () => {
    expect([999, 1000, 9_999, 65_000, 166_000, 3_600_000, 5_000_000].map(dur)).toEqual(['1.00 s', '1.0 s', '10.0 s', '1 m 05 s', '2 m 46 s', '1 h 0 m', '1 h 23 m']);
    expect([604, 12_300, 142_200, 1_310_000, 18_240_000].map(kt)).toEqual(['604', '12.3K', '142K', '1.31M', '18.2M']);
    expect([0.977, 1.019, 1.002, 0.75].map(delta)).toEqual(['−2%', '+2%', '±0%', '−25%']);
    expect([2048, 421_888, 1_310_720].map(storageSize)).toEqual(['2 KiB', '412 KiB', '1.25 MiB']);
    expect(gap(0, 60_000)).toEqual(['g', 0, 60]);
  });
});

import type { AlertLogEntryV2, Severity } from '../../src/contract/alerts.ts';
import type { Basis } from '../../src/contract/capabilities.ts';
import { WITHHOLD_REASONS, type AlertId, type ReasonParams, type WithholdReason } from '../../src/contract/reasons.ts';
import { TREND_WINDOWS_MS, type TrendV2, type TrendWindowMs } from '../../src/contract/trend.ts';
import { USAGE_RANGES, type UsageRange, type UsageV2 } from '../../src/contract/usage.ts';
import type { LedgerAccounting } from '../history/accounting.ts';
import { baselineFor, type Baseline, type BaselineKey, type Baselines } from '../history/baselines.ts';
import type { GapRow, LedgerAttr, LedgerRow, ReplyRow, SizeBucket, TurnRow } from '../history/ledger-schema.ts';
import type { RegressionFlag } from '../history/regress.ts';
import { SIZE_LABELS } from '../history/summary.ts';
import { trendGaps, trendGeometry, type TrendGeometry } from '../render/trend-chart.ts';
import { alertMessage, withholdMessage } from './reasons.ts';

// Owner: ui-history. Pure History tab presenter: trend, replies (each with its attr chip), turn summaries, baselines,
// oMLX usage ("Recorded by oMLX"), storage, alert log. Header "Observed while Scope was open" with counts per basis.

/** The English this tab borrows: withhold reasons and alert titles live in panel/present/reasons.ts (one source). */
export interface HistoryText { withheld(reason: WithholdReason | 'all-requests'): string; alert(id: AlertId, params: ReasonParams): string }
export const HISTORY_TEXT: HistoryText = { withheld: reason => withholdMessage(reason, null), alert: alertMessage };

export interface HistoryInput {
  now: number;
  trend: TrendV2 | null;
  rows: readonly LedgerRow[];
  models: readonly string[];                 // in-view only
  baselines: Baselines;
  flags: readonly RegressionFlag[];
  usage: UsageV2 | null;
  storage: LedgerAccounting | null;
  paused: boolean;
  retentionDays: number;
  alertLog: readonly AlertLogEntryV2[];
  // ui-history additions; all optional so the frozen shape above stays valid.
  runtimeName?: string;                      // "oMLX", "Splash via Bionic": what the trend and baselines are from
  model?: string | null;                     // the connection's current model, for an empty Usual speed card
  windowMs?: TrendWindowMs;
  usageRange?: UsageRange;
  trendError?: string | null;                // why the trend could not be read
  confirmClear?: boolean;
  recording?: 'recording' | 'backoff' | 'idle';
  legacyCaptures?: number;
  listLimit?: number;                        // entries shown; "Show more" raises it
  ceiling?: number;                          // the page shares one y-scale between Live and the trend
  text?: HistoryText;
}
export interface AttrChip { attr: 'inferred' | 'armed' | 'server'; text: string; reason: string | null }
export type HistoryEntry =
  | { kind: 'reply'; key: string; at: string; iso: string; rate: string | null; basis: Basis; basisLabel: string | null; output: string | null;
      detail: string; ttft: string | null; attr: AttrChip; model: string | null }
  | { kind: 'turn'; key: string; at: string; iso: string; title: string; time: string | null; rate: string | null; detail: string; attr: AttrChip }
  | { kind: 'gap'; key: string; text: string };
export interface TrendCard {
  windows: Array<{ label: string; windowMs: TrendWindowMs; pressed: boolean }>;
  title: string; ceiling: string | null; from: string; summary: string; empty: string | null; note: string;
  geometry: TrendGeometry | null; gaps: Array<{ left: string; width: string }>; tip: string[];
}
export interface BaselineCard {
  model: string | null; bucket: string | null; empty: string | null;
  tiles: Array<{ label: string; value: string; detail: string }>;
  rows: Array<{ label: string; value: string; basis: string | null }>;
  flag: { chip: string; tip: string[] } | null;
  copy: boolean; tip: string[];
}
export interface HistoryView {
  header: string;
  basisCounts: Array<{ basis: string; n: number }>;
  replies: Array<{ at: string; model: string; rate: string; ttft: string; tokens: string; attr: string; vsUsual: string | null }>;
  usage: { title: string; rows: Array<{ label: string; value: string; detail?: string }>;
    ranges: Array<{ label: UsageRange; pressed: boolean }>; bars: Array<{ height: number; label: string }>; dense: boolean; aria: string; tip: string[] } | null;
  storage: { used: string; fraction: number; retention: string; paused: boolean;
    detail: string; label: string; full: string | null; note: string | null; retentionDays: number; options: number[];
    confirm: { title: string; detail: string } | null; meter: boolean } | null;
  alertLog: Array<{ at: string; text: string; iso: string; severity: Severity; severityWord: string; duration: string }>;
  // ui-history additions
  counts: string[];                          // "41 last observed", "1 gap"
  entries: HistoryEntry[];                   // turns, replies and gaps, newest first
  more: string | null;
  showMore: string | null;
  repliesEmpty: string | null;
  repliesTip: string[];
  trend: TrendCard;
  baseline: BaselineCard;
  alertLogEmpty: string | null;
}

export const HISTORY_HEADER = 'Observed while Scope was open';
export const HISTORY_LIST_LIMIT = 12;
export const HISTORY_LIST_STEP = 24;
export const RETENTION_OPTIONS = [7, 14, 30, 60, 90] as const;
const TURN_NOTE = 'Turn times from OpenChamber · readings are server-wide';
const BASIS_WORD: Readonly<Record<Basis, string>> = { reported: 'reported', derived: 'derived', observed: 'observed', 'last-observed': 'last observed', estimate: 'estimate' };
const SEVERITY_WORD: Readonly<Record<Severity, string>> = { critical: 'Critical', warning: 'Warning', info: 'Notice' };
const BASIS_ORDER: readonly Basis[] = ['reported', 'derived', 'observed', 'last-observed', 'estimate'];

// ---------- formatting (the mock's rules; host locale for grouping) ----------
const whole = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
export const int = (n: number): string => whole.format(Math.round(n));
/** Token counts: 1,104 · 49.8K · 142K · 1.31M · 18.2M. */
export const kt = (n: number): string => n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M` : n >= 1e5 ? `${Math.round(n / 1e3)}K`
  : n >= 1e4 ? `${(n / 1e3).toFixed(1)}K` : int(n);
export const tps = (v: number): string => v >= 100 ? int(v) : v.toFixed(1);
export const pct = (f: number): string => `${Math.round(f * 100)}%`;
/** A ratio to usual as a signed percentage: 0.977 → "−2%". */
export const delta = (ratio: number): string => { const d = ratio - 1; return `${d > 0.004 ? '+' : d < -0.004 ? '−' : '±'}${Math.abs(Math.round(d * 100))}%`; };
export const dur = (ms: number): string => ms < 1000 ? `${(ms / 1000).toFixed(2)} s` : ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : ms < 60_000 ? `${Math.round(ms / 1000)} s`
  : ms < 3_600_000 ? ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.floor(ms / 60_000)} m ${String(Math.floor(ms % 60_000 / 1000)).padStart(2, '0')} s`
    : `${Math.floor(ms / 3_600_000)} h ${Math.floor(ms % 3_600_000 / 60_000)} m`;
export const ago = (at: number, now: number): string => { const d = now - at;
  return d < 5000 ? 'just now' : d < 60_000 ? `${Math.round(d / 1000)} s ago` : d < 3_600_000 ? `${Math.round(d / 60_000)} min ago` : `${Math.round(d / 3_600_000)} h ago`; };
const hm = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const md = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const mdUtc = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const day = (at: number): string => { const d = new Date(at); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);
/** Local wall time today ("14:04"), else the date ("Sep 28"). */
export const clock = (at: number, now: number): string => day(at) === day(now) ? hm.format(at) : md.format(at);
export const storageSize = (bytes: number): string => bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(2)} MiB` : `${Math.round(bytes / 1024)} KiB`;
const plural = (n: number, one: string, many = `${one}s`): string => `${int(n)} ${n === 1 ? one : many}`;
const iso = (at: number): string => new Date(at).toISOString();

// ---------- labels ----------
const WITHHOLD = new Set<string>(WITHHOLD_REASONS);
export const attrChip = (attr: LedgerAttr, text: HistoryText): AttrChip => {
  if (attr === 'inferred') return { attr: 'inferred', text: 'This chat · inferred', reason: null };
  if (attr === 'armed') return { attr: 'armed', text: 'Next reply · armed', reason: null };
  // A server-wide label always names its reason; an unknown stored reason reads as not observed.
  const stored = attr.startsWith('withheld:') ? attr.slice('withheld:'.length) : 'not-observed';
  const reason = (WITHHOLD.has(stored) ? stored : 'not-observed') as WithholdReason;
  return { attr: 'server', text: text.withheld(reason), reason };
};
const basisPhrase = (basis: Basis, rt: string): string => basis === 'reported' ? `reported by ${rt}` : basis === 'derived' ? `derived from ${rt} counters`
  : basis === 'observed' ? 'observed by Scope' : basis === 'last-observed' ? 'last observed by Scope' : 'estimate';

// ---------- replies ----------
const tokens = (output: number | null, prompt: number | null, cached: number | null): string =>
  [output !== null ? `${int(output)} out` : null, prompt !== null ? `${kt(prompt)} in${cached ? ` (${kt(cached)} cached)` : ''}` : null].filter(Boolean).join(' · ');
const replyEntry = (row: ReplyRow, input: HistoryInput, text: HistoryText, named: boolean): HistoryEntry & { kind: 'reply' } => {
  const [, finishedS, , modelRef, , , prompt, cached, output, ttftMs, , decodeTps10, basis, attr, , , , id] = row, at = finishedS * 1000;
  return { kind: 'reply', key: `r:${id}`, at: clock(at, input.now), iso: iso(at), rate: decodeTps10 === null ? null : `${tps(decodeTps10 / 10)} tok/s`,
    basis, basisLabel: basis === 'reported' ? null : BASIS_WORD[basis], output: output === null ? null : `${int(output)} out`,
    detail: decodeTps10 === null ? tokens(null, prompt, cached) : tokens(output, prompt, cached),
    ttft: ttftMs === null || basis === 'last-observed' ? null : `TTFT ${dur(ttftMs)}`, attr: attrChip(attr, text), model: named && modelRef !== null ? input.models[modelRef] ?? null : null };
};
const turnEntry = (row: TurnRow, replies: readonly ReplyRow[], input: HistoryInput, text: HistoryText): HistoryEntry => {
  const [, startedS, endedS, rt, modelRef, steps, output, , wDecodeTps10, waitMs, attr] = row;
  // Cache reuse comes from the turn's own step rows; left out unless every step reported its input.
  const own = replies.filter(r => r[2] === rt && r[3] === modelRef && r[1] >= startedS - 1 && r[1] <= endedS + 1);
  const prompt = own.reduce((sum, r) => sum + (r[6] ?? NaN), 0), cached = own.reduce((sum, r) => sum + (r[7] ?? NaN), 0);
  const reuse = own.length === steps && prompt > 0 && Number.isFinite(cached) ? ` · ${pct(cached / prompt)} of input reused` : '';
  const wall = (endedS - startedS) * 1000 - (waitMs ?? 0);
  return { kind: 'turn', key: `t:${startedS}:${endedS}`, at: clock(endedS * 1000, input.now), iso: iso(endedS * 1000), title: `Turn · ${plural(steps, 'step')}`,
    time: wall > 0 ? dur(wall) : null, rate: wDecodeTps10 === null ? null : `${tps(wDecodeTps10 / 10)} tok/s token-weighted`,
    detail: `${int(output)} out${reuse}`, attr: attrChip(attr, text) };
};
const gapEntry = (row: GapRow, now: number): HistoryEntry =>
  ({ kind: 'gap', key: `g:${row[1]}:${row[2]}`, text: `Not observed · Scope wasn’t open · ${clock(row[1] * 1000, now)}–${clock(row[2] * 1000, now)}` });
/** Newest first: a turn sits above its last step, a gap at its end. */
const rowTime = (row: LedgerRow): number => row[0] === 'r' ? row[1] : row[2];
const rowRank = (row: LedgerRow): number => row[0] === 't' ? 0 : row[0] === 'r' ? 1 : 2;

// ---------- trend ----------
const presentTrend = (input: HistoryInput, rt: string): TrendCard => {
  const windowMs = input.trend?.windowMs ?? input.windowMs ?? 3_600_000, minutes = windowMs / 60_000, trend = input.trend;
  const series = trend?.series.decodeTps, geometry = trend && series ? trendGeometry(trend, 'decodeTps', 600, 120, input.ceiling) : null;
  const gaps = trend ? trendGaps(trend).map(gap => ({ left: `${(gap.x / 600 * 100).toFixed(2)}%`, width: `${(gap.width / 600 * 100).toFixed(2)}%` })) : [];
  const turns = trend?.marks.filter(mark => mark.phase === 'started').length ?? 0;
  const unseen = trend?.gaps.map(gap => `not observed from ${clock(gap.fromAt, input.now)} to ${clock(gap.toAt, input.now)}`).join(', ') || 'observed throughout';
  const bucketS = Math.round(windowMs / 180 / 1000);
  return {
    windows: TREND_WINDOWS_MS.map(ms => ({ label: `${ms / 60_000} min`, windowMs: ms, pressed: ms === windowMs })),
    title: `Decode speed · ${basisPhrase(series?.basis ?? 'reported', rt)}`, ceiling: geometry ? `${geometry.max} tok/s` : null, from: `−${minutes} min`,
    summary: geometry ? `Decode speed over the last ${minutes} min: ${plural(turns, 'turn')}, ${tps(geometry.low)} to ${tps(geometry.high)} tokens per second; ${unseen}.`
      : gaps.length ? `Decode speed over the last ${minutes} min: no line yet; ${unseen}.` : `Nothing observed in the last ${minutes} min.`,
    empty: input.trendError ?? (!trend ? 'Loading the trend…' : !series ? `${rt} doesn’t report decode speed, so there’s no trend.`
      : geometry || gaps.length ? null : `No decode readings in the last ${minutes} min. The chart starts after 2 readings.`),
    note: TURN_NOTE, geometry, gaps,
    tip: [`Decode speed as ${rt} reports it, in ${bucketS} s buckets: the line is each bucket’s last reading and the band its min–max.`,
      'The line breaks while nothing is generating. Hatched spans weren’t observed because no Scope view was open. Nothing is interpolated.'],
  };
};

// ---------- usual speed ----------
const needs = (base: Baseline | null, of: number): string => `n ${base?.n ?? 0} of ${of}`;
const presentBaseline = (input: HistoryInput, replies: readonly ReplyRow[], rt: string): BaselineCard => {
  const tip = ['Last 14 days, up to 50 replies, excluding the current 30 min. p50 needs 5 replies and p90 needs 10.',
    'Overlapping and aggregate replies are left out, and so are last-observed replies for TTFT.'];
  const newest = [...replies].reverse().find(row => row[3] !== null && row[4] !== null);
  const model = newest ? input.models[newest[3]!] ?? input.model ?? null : input.model ?? null;
  if (!newest) return { model, bucket: null, empty: 'Needs 5 replies for this model and context size.', tiles: [], rows: [], flag: null, copy: input.baselines.size > 0, tip };
  const ctx: BaselineKey = { rt: newest[2], modelRef: newest[3]!, bucket: newest[4]! };
  const unc: BaselineKey | null = newest[5] === null ? null : { ...ctx, bucket: newest[5] };
  const decode = baselineFor(input.baselines, 'decodeTps', ctx), prefill = unc && baselineFor(input.baselines, 'prefillTps', unc);
  const ttft = unc && baselineFor(input.baselines, 'ttftMs', unc), perJ = baselineFor(input.baselines, 'tokPerJ', ctx);
  const bucket = `${SIZE_LABELS[ctx.bucket as SizeBucket]} context`;
  const rows: BaselineCard['rows'] = [];
  if (perJ?.p50) rows.push({ label: 'tok/J, usual', value: `${perJ.p50.toFixed(2)} · n ${perJ.n}`, basis: 'estimate baseline' });
  const reportsTtft = replies.some(row => row[2] === ctx.rt && row[9] !== null && row[12] !== 'last-observed');
  rows.push({ label: 'TTFT', basis: null, value: !reportsTtft ? `No baseline · ${rt} doesn’t report it`
    : ttft?.p50 ? `p50 ${dur(ttft.p50)}${ttft.p90 ? ` · p90 ${dur(ttft.p90)}` : ''} · n ${ttft.n}` : `Needs 5 replies · ${needs(ttft, 5)}` });
  const flag = input.flags.find(item => [`decodeTps|${ctx.rt}|${ctx.modelRef}|${ctx.bucket}`, unc && `prefillTps|${unc.rt}|${unc.modelRef}|${unc.bucket}`,
    unc && `ttftMs|${unc.rt}|${unc.modelRef}|${unc.bucket}`].includes(item.key));
  const causes = flag ? [flag.cofactors & 1 && 'macOS memory pressure at warning or above', flag.cofactors & 2 && 'swap grew', flag.cofactors & 4 && 'heavy thermal pressure'].filter(Boolean) : [];
  const unit = (value: number, metric: RegressionFlag['metric']): string => metric === 'ttftMs' ? dur(value) : `${tps(value)} tok/s`;
  return {
    model, bucket, tip, rows, copy: input.baselines.size > 0,
    empty: decode?.p50 ? null : `Needs 5 replies for this model and context size.${decode?.n ? ` Scope has ${decode.n} so far.` : ''}`,
    tiles: decode?.p50 ? [
      { label: 'Decode p50', value: `${tps(decode.p50)} tok/s`, detail: `n ${decode.n}` },
      { label: 'Decode p90', value: decode.p90 ? `${tps(decode.p90)} tok/s` : 'Not yet', detail: decode.p90 ? `n ${decode.n}` : needs(decode, 10) },
      ...prefill ? [{ label: 'Prefill p50', value: prefill.p50 ? `${tps(prefill.p50)} tok/s` : 'Not yet', detail: prefill.p50 ? `n ${prefill.n}` : needs(prefill, 5) }] : [],
    ] : [],
    flag: flag ? { chip: `${flag.metric === 'ttftMs' ? 'Slower first token' : 'Slower'} · ${delta(flag.recentMedian / flag.p50)} · last 3`, tip: [
      `Median of the last 3 replies ${unit(flag.recentMedian, flag.metric)} against usual ${unit(flag.p50, flag.metric)} (p50, n ${flag.n}).`,
      ...causes.length ? [`Observed during these replies, not necessarily the cause: ${causes.join('; ')}.`] : []] } : null,
  };
};

// ---------- oMLX usage ----------
const presentUsage = (usage: UsageV2 | null, input: HistoryInput): HistoryView['usage'] => {
  if (!usage?.available) return null;
  const days = new Map<string, { at: number; output: number }>();
  for (const bucket of usage.buckets) {
    // Hourly records are shown per local day, like the daily ones.
    // Day buckets are oMLX's local dates keyed at 00:00 UTC (contract §12.6); 30d and 90d carry only totalTokens.
    const key = usage.granularity === 'day' ? utcDay(bucket.at) : day(bucket.at), entry = days.get(key) ?? { at: bucket.at, output: 0 };
    days.set(key, { at: entry.at, output: entry.output + (bucket.outputTokens ?? bucket.totalTokens ?? 0) });
  }
  const list = [...days.values()].sort((a, b) => a.at - b.at), max = Math.max(1, ...list.map(entry => entry.output)), every = Math.ceil(list.length / 10);
  const utc = usage.granularity === 'day', what = usage.buckets.every(bucket => bucket.outputTokens !== undefined) ? 'Output tokens' : 'Prompt and output tokens';
  const t = usage.totals;
  return {
    title: 'Recorded by oMLX', ranges: USAGE_RANGES.map(label => ({ label, pressed: label === usage.range })), dense: list.length > 14,
    bars: list.map((entry, index) => ({ height: Math.max(2, Math.round(entry.output / max * 72)),
      label: index % every ? '' : String(utc ? new Date(entry.at).getUTCDate() : new Date(entry.at).getDate()) })),
    aria: `${what} per day: ${list.map(entry => `${(utc ? mdUtc : md).format(entry.at)} ${kt(entry.output)}`).join(', ')}`,
    rows: [{ label: 'Requests', value: int(t.requests) }, { label: 'Prompt', value: kt(t.promptTokens), ...t.cachedTokens != null ? { detail: `${kt(t.cachedTokens)} cached` } : {} },
      { label: 'Output', value: kt(t.outputTokens) }],
    tip: [`oMLX’s own records for every app that used it: ${what.toLowerCase()} per day. Refreshed ${ago(usage.cachedAt, input.now)}.`, 'Never merged into Scope’s history, and it has no TTFT.'],
  };
};

// ---------- storage ----------
const presentStorage = (input: HistoryInput, replies: number, oldestS: number | null): NonNullable<HistoryView['storage']> => {
  const a = input.storage, days = oldestS === null ? 0 : Math.max(1, Math.ceil((input.now - oldestS * 1000) / 86_400_000));
  const full = a !== null && a.ledgerBytes >= a.capBytes * 0.95;
  const span = `${plural(replies, 'reply', 'replies')} · ${plural(days, 'day')}`;
  return {
    used: a ? storageSize(a.ledgerBytes) : plural(replies, 'reply', 'replies'), fraction: a ? Math.min(1, a.ledgerBytes / a.capBytes) : 0, meter: a !== null,
    detail: a ? `${full ? 'at the limit' : `of ${storageSize(a.capBytes)}`} · ${span}` : plural(days, 'day'),
    retention: `${input.retentionDays} days`, retentionDays: input.retentionDays, paused: input.paused,
    options: [...new Set([...RETENTION_OPTIONS, input.retentionDays])].sort((x, y) => x - y),
    label: input.paused ? 'Recording paused' : 'Stored on this Mac',
    full: full ? days < input.retentionDays
      ? `After each save Scope removes the oldest replies, so it holds ${days} of your ${input.retentionDays} days. Shorten retention or clear to make room.`
      : `After each save Scope removes the oldest replies to stay within ${storageSize(a!.capBytes)}.` : null,
    note: input.recording === 'backoff' ? 'OpenChamber didn’t accept the last save. Scope keeps the replies in memory and tries again; nothing is removed because of an error.' : null,
    confirm: input.confirmClear ? { title: `Clear ${plural(replies, 'reply', 'replies')} and the baselines built from them?`, detail: 'This can’t be undone. Captures are kept.' } : null,
  };
};

export const presentHistory = (input: HistoryInput): HistoryView => {
  const text = input.text ?? HISTORY_TEXT, rt = input.runtimeName ?? 'the runtime';
  const replies = input.rows.filter((row): row is ReplyRow => row[0] === 'r');
  const sorted = [...input.rows].sort((a, b) => rowTime(b) - rowTime(a) || rowRank(a) - rowRank(b));
  // Rows name their model only when the list mixes models; one model is named once, in Usual speed.
  const named = new Set(replies.map(row => row[3])).size > 1;
  const limit = input.listLimit ?? HISTORY_LIST_LIMIT;
  const entries = sorted.slice(0, limit).map(row => row[0] === 'r' ? replyEntry(row, input, text, named)
    : row[0] === 't' ? turnEntry(row, replies, input, text) : gapEntry(row, input.now));
  const basisCounts = BASIS_ORDER.map(basis => ({ basis: BASIS_WORD[basis], n: replies.filter(row => row[12] === basis).length })).filter(entry => entry.n);
  const gaps = input.rows.filter(row => row[0] === 'g').length;
  const oldest = input.rows.reduce<number | null>((min, row) => min === null || row[1] < min ? row[1] : min, null);
  const shown = entries.filter((entry): entry is HistoryEntry & { kind: 'reply' } => entry.kind === 'reply');
  return {
    header: HISTORY_HEADER, basisCounts,
    counts: [...basisCounts.map(entry => `${int(entry.n)} ${entry.basis}`), ...gaps ? [plural(gaps, 'gap')] : []],
    entries,
    replies: shown.map(entry => ({ at: entry.at, model: entry.model ?? '', rate: entry.rate ?? '', ttft: entry.ttft ?? '', tokens: entry.detail, attr: entry.attr.text, vsUsual: null })),
    more: sorted.length > limit ? `Showing the newest ${int(limit)} of ${int(sorted.length)} entries` : null,
    showMore: sorted.length > limit ? `Show ${int(Math.min(HISTORY_LIST_STEP, sorted.length - limit))} more` : null,
    repliesEmpty: input.rows.length ? null : `No replies yet. Scope records a reply when it finishes while any Scope view is open.${input.legacyCaptures ? ' Your 1.6 captures are in Captures.' : ''}`,
    repliesTip: ['Each reply Scope saw finish while any Scope view was open, with its label.',
      'A turn summary appears only when every step in it is attributed. Rows with no verdict read “Server-wide · not observed”.',
      ...replies.some(row => row[12] === 'last-observed') ? ['Where a runtime doesn’t report completions, its rows are Scope’s last reading of the request.'] : []],
    trend: presentTrend(input, rt),
    baseline: presentBaseline(input, replies, rt),
    usage: presentUsage(input.usage, input),
    storage: presentStorage(input, replies.length, oldest),
    alertLog: input.alertLog.map(entry => ({ at: clock(entry.since, input.now), iso: iso(entry.since), text: text.alert(entry.id, entry.params), severity: entry.severity,
      severityWord: SEVERITY_WORD[entry.severity], duration: entry.until === null ? 'active' : dur(entry.until - entry.since) })),
    alertLogEmpty: input.alertLog.length ? null : 'No alerts while Scope was open.',
  };
};

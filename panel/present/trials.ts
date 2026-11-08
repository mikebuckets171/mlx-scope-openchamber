import type { TrialBaselineNotes } from '../history/ledger-schema.ts';
import { COFACTOR, type BatchRow, type ReplyRow, type SideRow, type TrialChangeRow, type WaitRow } from '../history/ledger-schema.ts';
import { clock, dur, int, pct, size, tps } from './format.ts';
import { modelDisplayName, type ModelNames } from './model-name.ts';

// Owner: ui-history. Advisory verdicts against one observed trial and a selected prior stretch or local notes.

export type TrialGateState = 'pass' | 'fail' | 'unknown';
export interface TrialGate {
  key: string;
  label: string;
  state: TrialGateState;
  current: string;
  baseline: string;
  detail: string;
}
export interface TrialBaselineOption { key: string; label: string }
export interface TrialCard {
  verdict: 'watching' | 'keep' | 'revert' | 'not-enough-data';
  verdictText: string;
  config: string | null;
  started: string | null;
  summary: string;
  gates: TrialGate[];
  baselines: TrialBaselineOption[];
  baselineIndex: number | null;
  baselineLabel: string;
  canStart: boolean;
  startLabel: string;
  notes: TrialBaselineNotes;
  note: string | null;
}
export interface TrialInput {
  now: number;
  rows: readonly ReplyRow[];
  side: readonly SideRow[];
  models: readonly string[];
  notes: TrialBaselineNotes;
  paused: boolean;
  canStart: boolean;
  baselineIndex?: number | null;
  modelNames?: ModelNames;
  modelProvider?: string;
}

interface Stretch { row: TrialChangeRow; endS: number }
interface Metric { value: number | null; count: number; source: 'history' | 'notes' | null }

const quantile = (values: readonly number[], p: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
};
const median = (values: readonly number[]): number | null => quantile(values, 0.5);
const changesOf = (side: readonly SideRow[]): TrialChangeRow[] => side.filter((row): row is TrialChangeRow => row[0] === 'c').sort((a, b) => a[1] - b[1]);
const stretchesOf = (changes: readonly TrialChangeRow[]): Stretch[] => changes.slice(0, -1)
  .map((row, index) => ({ row, endS: changes[index + 1]![1] })).filter(stretch => stretch.endS > stretch.row[1]);
const rowLabel = (row: TrialChangeRow, models: readonly string[], now: number, modelNames?: ModelNames, provider?: string): string => {
  const parts: string[] = [];
  if (row[2] !== null) parts.push(`${size(row[2])} experts`);
  if (row[3] !== null) parts.push(`${size(row[3])} budget`);
  if (row[4] !== null) parts.push(`${int(row[4] / 1024)}K context`);
  if (row[5] !== null && models[row[5]]) parts.push(modelDisplayName(models[row[5]]!, modelNames, provider));
  return `${parts.length ? parts.join(' · ') : 'Splash setup'} · ${clock(row[1] * 1000, now)}`;
};
const rangeValues = <T extends SideRow>(rows: readonly T[], startS: number, endS: number, includeStart = true): T[] => rows.filter(row => {
  const at = row[1]; return (includeStart ? at >= startS : at > startS) && at <= endS;
});
const displayedWaits = (side: readonly SideRow[], startS: number, endS: number): WaitRow[] => rangeValues(side, startS, endS)
  .filter((row): row is WaitRow => row[0] === 'w' && row[4] === 'splash');
const waitMetric = (waits: readonly WaitRow[], quantileValue: number, note: number | null): Metric => {
  if (waits.length >= 5) return { value: quantile(waits.map(row => row[2]), quantileValue), count: waits.length, source: 'history' };
  return note === null ? { value: null, count: waits.length, source: null } : { value: note, count: waits.length, source: 'notes' };
};
const soloRates = (rows: readonly ReplyRow[], startS: number, endS: number, modelRef: number | null): number[] => rows
  .filter(row => row[1] >= startS && row[1] <= endS && row[2] === 'splash' && modelRef !== null && row[3] === modelRef
    && row[6] !== null && row[6] >= 160_000 && row[11] !== null && (row[15] & (COFACTOR.overlapped | COFACTOR.aggregate)) === 0)
  .map(row => row[11]! / 10);
const rateMetric = (rates: readonly number[], note: number | null): Metric => rates.length ? { value: median(rates), count: rates.length, source: 'history' }
  : note === null ? { value: null, count: 0, source: null } : { value: note, count: 0, source: 'notes' };
const batchTotals = (side: readonly SideRow[], startS: number, endS: number): { single: number; multi: number } => {
  const rows: BatchRow[] = rangeValues(side, startS, endS, false).filter((row): row is BatchRow => row[0] === 'k');
  return rows.reduce((sum, row) => ({ single: sum.single + row[2], multi: sum.multi + row[3] }), { single: 0, multi: 0 });
};
const sourceLabel = (metric: Metric): string => metric.source === 'history' ? `from Scope History · n=${metric.count}` : metric.source === 'notes' ? 'from your notes' : 'no baseline';
const gate = (key: string, label: string, current: number | null, baseline: Metric, enough: boolean, passes: (value: number, baseline: number) => boolean,
  show: (value: number) => string, baselineShow: (value: number) => string, detail: string): TrialGate => {
  const state: TrialGateState = !enough || current === null || baseline.value === null ? 'unknown' : passes(current, baseline.value) ? 'pass' : 'fail';
  const baselineText = baseline.value === null ? '—' : `${baselineShow(baseline.value)} · ${sourceLabel(baseline)}`;
  const currentText = current === null ? 'Not enough readings' : show(current);
  const reason = state === 'unknown' ? detail : state === 'pass' ? 'Gate passed.' : 'Gate not met.';
  return { key, label, state, current: currentText, baseline: baselineText, detail: reason };
};

export const presentTrial = (input: TrialInput): TrialCard => {
  const changes = changesOf(input.side), latest = changes.at(-1) ?? null;
  const trialOpen = !!latest && (latest[6] || changes.length > 1);
  const baselineStretches = stretchesOf(changes);
  let selected = input.baselineIndex ?? (baselineStretches.length ? baselineStretches.length - 1 : null);
  if (selected !== null && (selected < 0 || selected >= baselineStretches.length)) selected = baselineStretches.length ? baselineStretches.length - 1 : null;
  const baseline = selected === null ? null : baselineStretches[selected] ?? null;
  const baselineStart = baseline?.row[1] ?? 0, baselineEnd = baseline?.endS ?? (latest?.[1] ?? 0);
  const baselineWaits = baseline ? displayedWaits(input.side, baselineStart, baselineEnd) : [];
  const notedMedian = input.notes.waitMedianMs;
  const notedP90 = input.notes.waitP90Ms;
  const baseMedian = waitMetric(baselineWaits, 0.5, notedMedian);
  const baseP90 = waitMetric(baselineWaits, 0.9, notedP90);
  const startS = latest?.[1] ?? 0;
  const currentWaits = latest ? displayedWaits(input.side, startS, Math.floor(input.now / 1000)) : [];
  const currentMedian = currentWaits.length ? median(currentWaits.map(row => row[2])) : null;
  const currentP90 = currentWaits.length ? quantile(currentWaits.map(row => row[2]), 0.9) : null;
  const currentBatches = latest ? batchTotals(input.side, startS, Math.floor(input.now / 1000)) : { single: 0, multi: 0 };
  const batchCount = currentBatches.single + currentBatches.multi;
  const currentShare = currentBatches.multi > 0 && batchCount > 0 ? currentBatches.multi / batchCount : null;
  const baselineDecode = baseline && latest && baseline.row[5] === latest[5]
    ? rateMetric(soloRates(input.rows, baselineStart, baselineEnd, latest[5]), input.notes.soloDecodeTps)
    : rateMetric([], input.notes.soloDecodeTps);
  const currentRates = latest ? soloRates(input.rows, startS, Math.floor(input.now / 1000), latest[5]) : [];
  const currentDecode = currentRates.length ? median(currentRates) : null;
  const gates: TrialGate[] = [
    gate('wait-median', 'Wait median', currentMedian, baseMedian, currentWaits.length >= 5,
      (value, base) => value < base, value => `${dur(value)} · n=${currentWaits.length}`, value => dur(value), currentWaits.length < 5 ? `Scope has ${currentWaits.length} waits; needs 5.` : 'No comparison baseline yet.'),
    gate('wait-p90', 'Wait p90', currentP90, baseP90, currentWaits.length >= 5,
      (value, base) => value < base, value => `${dur(value)} · n=${currentWaits.length}`, value => dur(value), currentWaits.length < 5 ? `Scope has ${currentWaits.length} waits; needs 5.` : 'No comparison baseline yet.'),
    gate('two-chat', 'Overlapping decode batches', currentShare, { value: input.notes.multiChatFraction, count: 0, source: input.notes.multiChatFraction === null ? null : 'notes' }, currentShare !== null,
      (value, threshold) => value > threshold, pct, value => `more than ${pct(value)}`, currentShare === null ? 'No two-chat decode batch observed yet; that is not a pass.'
        : input.notes.multiChatFraction === null ? 'Set the two-chat threshold in baseline notes.' : 'Compared with your noted threshold.'),
    gate('long-solo', 'Solo replies past 160K', currentDecode, baselineDecode, currentRates.length > 0,
      (value, base) => value >= base * 0.95, value => `${tps(value)} tok/s · ${int(currentRates.length)} replies`, value => `${tps(value)} tok/s`,
      currentRates.length ? 'No same-model long-reply baseline yet.' : 'No solo reply with a prompt of at least 160K was observed yet.'),
  ];
  const hasFailure = gates.some(item => item.state === 'fail'), hasUnknown = gates.some(item => item.state === 'unknown');
  const verdict: TrialCard['verdict'] = !trialOpen ? 'watching' : hasFailure ? 'revert' : hasUnknown ? 'not-enough-data' : 'keep';
  const verdictText = verdict === 'keep' ? 'Keep' : verdict === 'revert' ? 'Revert' : verdict === 'watching' ? 'Watching for a change' : 'Not enough data';
  const config = latest ? rowLabel(latest, input.models, input.now, input.modelNames, input.modelProvider) : null;
  const baselineOptions = baselineStretches.map((stretch, index) => ({ key: String(index), label: rowLabel(stretch.row, input.models, input.now, input.modelNames, input.modelProvider) }));
  const baselineLabel = baseline ? rowLabel(baseline.row, input.models, input.now, input.modelNames, input.modelProvider) : 'No prior Scope stretch';
  const summary = !trialOpen ? latest ? 'Scope is watching this Splash setup. A detected setting change opens a trial.'
    : 'Waiting for a ready Splash model and its memory plan.'
    : input.paused ? 'History recording is paused, so this trial is missing readings.'
    : verdict === 'keep' ? 'Every measured gate passed. This is advisory; it does not change Splash.'
    : verdict === 'revert' ? 'At least one measured gate missed its setup threshold. This is advisory; it does not change Splash.'
    : 'A gate still needs enough observed data or a comparison baseline. No overlap is never a pass.';
  const note = input.paused ? 'Resume History to record trial readings.' : input.canStart
    ? 'Start a trial here covers a Splash update or flag change Scope cannot detect.' : 'Open a ready Splash model to start a trial manually.';
  return { verdict, verdictText, config, started: trialOpen && latest ? clock(latest[1] * 1000, input.now) : null, summary,
    gates: trialOpen ? gates : [], baselines: baselineOptions, baselineIndex: selected, baselineLabel, canStart: input.canStart && !input.paused,
    startLabel: trialOpen ? 'Start another trial here' : 'Start a trial here', notes: input.notes, note };
};

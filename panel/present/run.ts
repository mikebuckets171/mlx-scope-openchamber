import type { Basis } from '../../src/contract/capabilities.ts';
import { baselineKey, replyMetric, type BaselineMetric } from '../history/baselines.ts';
import { COFACTOR, type LedgerRow, type ReplyRow, type TurnRow } from '../history/ledger-schema.ts';
import { SIZE_LABELS } from '../history/summary.ts';
import { RT } from './copy.ts';
import { clock, delta, dur, int, kt, pct, tps } from './format.ts';
import { attrChip, HISTORY_TEXT } from './history.ts';
import { presentLive } from './live.ts';
import { modelDisplayName, type ModelNames } from './model-name.ts';
import type { ScopeInput } from './scope.ts';

export interface RunFact { label: string; value: string; basis: Basis; scope?: string }
export interface RunDetail { title: string; identity: string; facts: RunFact[]; notes: string[] }
export interface RunComparison { label: string; current: string; reference: string; change: string; group: string }
const METRICS: readonly [BaselineMetric, string, (n: number) => string][] = [
  ['decodeTps', 'Generation speed', n => `${tps(n)} tok/s`], ['prefillTps', 'Prefill speed', n => `${tps(n)} tok/s`],
  ['ttftMs', 'First token', dur], ['tokPerJ', 'Tokens per joule (estimated)', n => `${tps(n)} tok/J`],
];
const fact = (facts: RunFact[], label: string, value: number | null | undefined, format: (n: number) => string, basis: Basis): void => {
  if (value != null) facts.push({ label, value: format(value), basis });
};
const rate = (n: number): string => `${tps(n / 10)} tok/s`;

/** A stored row is a bounded observation, never a reconstructed phase timeline. */
export const presentRecordedRun = (row: ReplyRow | TurnRow, models: readonly string[], now: number, names?: ModelNames, provider?: string): RunDetail => {
  const reply = row[0] === 'r', rt = reply ? row[2] : row[3], ref = reply ? row[3] : row[4];
  const facts: RunFact[] = [], notes = ['Stage boundaries and complete observation coverage were not stored.'];
  const basis = reply ? row[12] : 'derived', bits = reply ? row[15] : row[11];
  if (reply) {
    fact(facts, 'Generation speed', row[11], rate, basis);
    fact(facts, 'Prefill speed', row[10], rate, basis);
    if (basis !== 'last-observed') fact(facts, 'First token', row[9], dur, basis);
    fact(facts, basis === 'last-observed' ? 'Observed output' : 'Output', row[8], n => `${kt(n)} tokens`, basis);
    fact(facts, 'Input', row[6], n => `${kt(n)} tokens`, basis);
    if (row[6] !== null && row[6] > 0 && row[7] !== null && row[7] <= row[6]) fact(facts, 'Input reused', row[7] / row[6], pct, 'derived');
    if (row[4] !== null) facts.push({ label: 'Context group', value: SIZE_LABELS[row[4]]!, basis: 'derived' });
    if (basis === 'last-observed') notes.unshift('Last observed engine result; completion and final counts were not confirmed.');
  } else {
    fact(facts, 'Turn duration', (row[2] - row[1]) * 1000, dur, 'observed');
    fact(facts, 'Steps', row[5], int, 'observed');
    fact(facts, 'Output', row[6], n => `${kt(n)} tokens`, 'derived');
    if (row[7] !== null) notes.push('First-token time withheld: its measurement basis was not stored.');
    fact(facts, 'Token-weighted speed', row[8], rate, 'derived');
    fact(facts, 'Time outside engine intervals', row[9], dur, 'derived');
    notes.unshift('Time outside observed engine intervals includes tools, orchestration and waiting; it is not exact tool execution time.');
  }
  const conditions = [[COFACTOR.pressure, 'memory pressure'], [COFACTOR.swap, 'swap growth'], [COFACTOR.thermal, 'thermal pressure']] as const;
  const observed = conditions.filter(([bit]) => bits & bit).map(([, label]) => label);
  if (observed.length) notes.push(`Also observed: ${observed.join(', ')}. These conditions do not establish the cause of a slow run.`);
  if (bits & (COFACTOR.overlapped | COFACTOR.aggregate)) notes.push('Requests overlapped or were aggregated; per-reply comparisons are unavailable.');
  return { title: reply ? 'Recorded reply' : 'Recorded turn', facts, notes,
    identity: [RT[rt], ref === null || !models[ref] ? null : modelDisplayName(models[ref]!, names, provider), clock((reply ? row[1] : row[2]) * 1000, now), attrChip(reply ? row[13] : row[10], HISTORY_TEXT).text].filter(Boolean).join(' · ') };
};

/** Per-metric groups and matching bases prevent mixing native, estimated and last-observed meanings. */
export const compareRuns = (a: ReplyRow, b: ReplyRow): RunComparison[] => {
  if (a[17] === b[17] || a[12] !== b[12]) return [];
  return METRICS.flatMap(([metric, label, format]) => {
    const current = replyMetric(a, metric), reference = replyMetric(b, metric);
    if (!current || !reference || baselineKey(metric, current.key) !== baselineKey(metric, reference.key)) return [];
    return [{ label, current: format(current.value), reference: format(reference.value), change: delta(current.value / reference.value - 1),
      group: `${metric === 'prefillTps' || metric === 'ttftMs' ? 'Uncached input' : 'Context'} ${SIZE_LABELS[current.key.bucket]}` }];
  });
};
export const comparableRuns = (row: ReplyRow, rows: readonly LedgerRow[]): ReplyRow[] => rows
  .filter((other): other is ReplyRow => other[0] === 'r' && compareRuns(row, other).length > 0)
  .sort((a, b) => b[1] - a[1]).slice(0, 24);

/** Current detail uses the same pure presentation gates as Now, including cloud, stale and paused states. */
export const presentCurrentRun = (input: ScopeInput): RunDetail => {
  const view = presentLive({ ...input, samples: [] }), hero = view.hero, instrument = hero?.instrument;
  const reading = instrument?.measurement, facts: RunFact[] = [];
  if (reading) facts.push({ label: reading.label, value: `${reading.text}${reading.unit ? ` ${reading.unit}` : ''}`, basis: reading.basis });
  for (const tile of view.tiles) facts.push({ scope: 'Engine', label: tile.label, value: `${tile.value}${tile.detail ? ` · ${tile.detail}` : ''}`, basis: tile.basis ?? 'reported' });
  if (hero?.context) facts.push({ scope: 'Engine', label: 'Context used', value: hero.context.used, basis: hero.context.basis });
  if (hero?.firstToken?.strong) facts.push({ scope: 'Engine', label: 'First token', value: hero.firstToken.strong, basis: hero.firstToken.basis });
  const notes = [input.frame?.message, instrument?.note, instrument?.support?.text, reading?.detail,
    ...view.callouts.map(item => `${item.title}${item.detail ? ` · ${item.detail}` : ''}`)].filter((note): note is string => !!note);
  if (!facts.length && !notes.length) notes.push('No run measurement is available in this state.');
  notes.push('Current observation only. Compare eligible saved replies in History; gaps and unreported stages are not reconstructed.');
  return { title: 'Current observation', identity: [hero?.title, instrument?.phase, hero?.attr?.chip.text].filter(Boolean).join(' · '), facts, notes: [...new Set(notes)] };
};

import { runtimeKind, runtimeNames } from '../../src/contract/runtime.ts';
import { clamp, redact } from '../share/report.ts';
import { BASELINE_MIN_N, type Baseline, type BaselineMetric, type Baselines } from './baselines.ts';

// Owner: ui-history. "Copy baseline summary" (decision 11): sanitized through panel/share/report.ts, models aliased
// "Model A/B…", ≤ 32,000 chars, no model names (class B).

export const SUMMARY_MAX_CHARS = 32_000;
export const SIZE_LABELS = ['under 8K', '8–32K', '32–64K', '64–128K', 'over 128K'] as const;
const METRIC: Readonly<Record<BaselineMetric, { name: string; input: string; value: (v: number) => string }>> = {
  decodeTps: { name: 'decode', input: 'context', value: v => `${v.toFixed(1)} tok/s` },
  prefillTps: { name: 'prefill', input: 'uncached input', value: v => `${Math.round(v)} tok/s` },
  ttftMs: { name: 'TTFT', input: 'uncached input', value: v => `${(v / 1000).toFixed(2)} s` },
  tokPerJ: { name: 'tok/J (chip estimate)', input: 'context', value: v => v.toFixed(2) },
};
const ORDER: readonly BaselineMetric[] = ['decodeTps', 'prefillTps', 'ttftMs', 'tokPerJ'];

/** "Model A" … "Model Z", then "Model AA": a letter per dictionary ref, in ref order, never the name. */
export const modelAlias = (index: number): string => {
  let label = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) label = String.fromCharCode(65 + (n - 1) % 26) + label;
  return `Model ${label}`;
};
const values = (base: Baseline, metric: BaselineMetric): string => base.p50 === null
  ? `not enough replies yet (n ${base.n}; p50 needs ${BASELINE_MIN_N.p50})`
  : `p50 ${METRIC[metric].value(base.p50)}${base.p90 === null ? '' : ` · p90 ${METRIC[metric].value(base.p90)}`} · n ${base.n}`;

export const baselineSummary = (baselines: Baselines, models: readonly string[], version: string, now: number): string => {
  const parsed = [...baselines].flatMap(([key, base]) => {
    const [metric, rt, ref, bucket] = key.split('|') as [BaselineMetric, string, string, string];
    const kind = runtimeKind(rt), modelRef = Number(ref), size = Number(bucket);
    return kind && ORDER.includes(metric) && Number.isSafeInteger(modelRef) && SIZE_LABELS[size] ? [{ metric, kind, modelRef, size, base }] : [];
  });
  const refs = [...new Set(parsed.map(row => row.modelRef))].sort((a, b) => a - b);
  const lines = parsed.sort((a, b) => a.modelRef - b.modelRef || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)
    || ORDER.indexOf(a.metric) - ORDER.indexOf(b.metric) || a.size - b.size)
    .map(row => `${modelAlias(refs.indexOf(row.modelRef))} · ${runtimeNames[row.kind]} · ${SIZE_LABELS[row.size]} ${METRIC[row.metric].input} · ${METRIC[row.metric].name}: ${values(row.base, row.metric)}`);
  const head = [`MLX Scope ${version} — usual speeds (baseline summary)`, `Generated ${new Date(now).toISOString()}`,
    'From replies Scope observed while it was open: the last 14 days, up to 50 replies per row, the current 30 min left out. p50 needs 5 replies and p90 needs 10; n is how many replies a row uses.',
    'Server-wide readings unless a reply was labelled for a chat; not a controlled benchmark. tok/J is a chip-power estimate. Model names are replaced by aliases.', ''];
  if (!lines.length) lines.push('No usual speeds yet: each model and size needs 5 observed replies.');
  // Whole lines only: the summary stays readable when a large ledger has more rows than fit.
  const budget = SUMMARY_MAX_CHARS - head.join('\n').length - 120;
  let used = 0, kept = 0;
  for (const line of lines) { if (used + line.length + 1 > budget) break; used += line.length + 1; kept += 1; }
  const tail = kept < lines.length ? [`… ${lines.length - kept} more rows left out to stay under ${SUMMARY_MAX_CHARS.toLocaleString('en-US')} characters.`] : [];
  // The one sanitizer runs last, so even a model name that slipped into a line could not leave the Mac.
  return clamp(redact([...head, ...lines.slice(0, kept), ...tail].join('\n'), models), SUMMARY_MAX_CHARS);
};

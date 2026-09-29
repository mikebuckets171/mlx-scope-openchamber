import { CONNECTION_ID, HEX8 } from './guards.ts';
import { withholdReason, type WithholdReason } from './reasons.ts';
import { runtimeKind, type RuntimeKind } from './runtime.ts';
import { SURFACES, type Surface } from './snapshot.ts';
import { MARK_PHASES, TREND_SERIES, type MarkPhase, type TrendSeries } from './trend.ts';
import { USAGE_RANGES, type UsageRange } from './usage.ts';

// Query grammar (contract §7). Unknown parameters are ignored; a malformed known one is `bad_query` naming only the
// parameter, never its value.
export type BadQuery = { error: 'bad_query'; param: string };
type Params = { get(name: string): string | null; getAll(name: string): string[] };
export const MAX_MARKS = 4;
export const MAX_ATTRS = 8;

export interface Selection { provider?: string; runtime?: RuntimeKind }
export interface SnapshotQuery extends Selection {
  frame?: string; surface?: Surface; tier: 'glance' | 'full'; since?: number;
  marks: Array<{ phase: MarkPhase; at: number; tag: string }>;
  attrs: Array<{ seq: number; attr: 'inferred' | 'withheld' | 'armed'; reason: WithholdReason | null }>;
  detail?: 'server';
}
export interface TrendQuery extends Selection { windowMs: 900_000 | 1_800_000 | 3_600_000; series: TrendSeries[] }
export interface UsageQuery extends Selection { range: UsageRange }

class Bad extends Error { constructor(readonly param: string) { super(param); } }
const one = (params: Params, name: string): string | undefined => {
  const values = params.getAll(name);
  if (values.length > 1) throw new Bad(name);
  return values[0];
};
const match = <T>(params: Params, name: string, parse: (value: string) => T | null): T | undefined => {
  const value = one(params, name);
  if (value === undefined) return undefined;
  const parsed = parse(value);
  if (parsed === null) throw new Bad(name);
  return parsed;
};
const integer = (value: string): number | null => /^\d{1,15}$/.test(value) ? Number(value) : null;
const selection = (params: Params): Selection => {
  const provider = match(params, 'provider', value => CONNECTION_ID.test(value) ? value : null);
  const runtime = match(params, 'runtime', runtimeKind);
  return { ...(provider ? { provider } : {}), ...(runtime ? { runtime } : {}) };
};
const mark = (value: string): SnapshotQuery['marks'][number] | null => {
  const [phase, when, tag, extra] = value.split('.');
  const parsedPhase = MARK_PHASES.find(item => item === phase), at = when === undefined ? null : integer(when);
  return parsedPhase && at !== null && tag !== undefined && HEX8.test(tag) && extra === undefined ? { phase: parsedPhase, at, tag } : null;
};
const attr = (value: string): SnapshotQuery['attrs'][number] | null => {
  const [seq, verdict, reason, extra] = value.split('.');
  const parsedSeq = seq === undefined ? null : integer(seq), parsedReason = reason === '-' ? null : withholdReason(reason);
  const kind = verdict === 'inferred' || verdict === 'withheld' || verdict === 'armed' ? verdict : null;
  if (!parsedSeq || !kind || extra !== undefined || reason !== '-' && !parsedReason || kind === 'withheld' && !parsedReason) return null;
  return { seq: parsedSeq, attr: kind, reason: parsedReason };
};
const repeated = <T>(params: Params, name: string, max: number, parse: (value: string) => T | null): T[] => {
  const values = params.getAll(name);
  if (values.length > max) throw new Bad(name);
  return values.map(value => { const parsed = parse(value); if (parsed === null) throw new Bad(name); return parsed; });
};
const run = <T>(read: () => T): T | BadQuery => {
  try { return read(); } catch (error) { if (error instanceof Bad) return { error: 'bad_query', param: error.param }; throw error; }
};
export const isBadQuery = (value: object): value is BadQuery => (value as BadQuery).error === 'bad_query';

export const parseSnapshotQuery = (params: Params): SnapshotQuery | BadQuery => run(() => {
  const tier = match(params, 'tier', value => value === 'glance' || value === 'full' ? value : null);
  const detail = match(params, 'detail', value => value === 'server' ? value : null);
  // Server-tab-only reads never run on the glance tier.
  if (detail && tier !== 'full') throw new Bad('detail');
  const frame = match(params, 'frame', value => HEX8.test(value) ? value : null);
  const surface = match(params, 'surface', value => SURFACES.find(item => item === value) ?? null);
  const since = match(params, 'since', integer);
  return { ...selection(params), ...(frame ? { frame } : {}), ...(surface ? { surface } : {}),
    tier: tier ?? (surface === 'status' || surface === 'background' ? 'glance' : 'full'), ...(since !== undefined ? { since } : {}),
    marks: repeated(params, 'mark', MAX_MARKS, mark), attrs: repeated(params, 'attr', MAX_ATTRS, attr), ...(detail ? { detail } : {}) };
});

const WINDOWS = { 900: 900_000, 1800: 1_800_000, 3600: 3_600_000 } as const;
export const parseTrendQuery = (params: Params): TrendQuery | BadQuery => run(() => {
  const windowMs = match(params, 'window', value => Object.hasOwn(WINDOWS, value) ? WINDOWS[Number(value) as keyof typeof WINDOWS] : null);
  const series = match(params, 'series', value => {
    const names = value.split(',');
    return names.every(name => TREND_SERIES.includes(name as TrendSeries)) ? [...new Set(names as TrendSeries[])] : null;
  });
  return { ...selection(params), windowMs: windowMs ?? 900_000, series: series ?? ['decodeTps'] };
});

export const parseUsageQuery = (params: Params): UsageQuery | BadQuery => run(() => {
  const range = match(params, 'range', value => USAGE_RANGES.find(item => item === value) ?? null);
  return { ...selection(params), range: range ?? '7d' };
});

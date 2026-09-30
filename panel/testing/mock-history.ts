import fixtures from '../../docs/design/2.0-mock-fixtures.json';
import type { Basis } from '../../src/contract/capabilities.ts';
import { parseSnapshotV2, type SnapshotV2 } from '../../src/contract/snapshot.ts';
import { parseTrendV2, type TrendBucket, type TrendV2, type TrendWindowMs } from '../../src/contract/trend.ts';
import { parseUsageV2, type UsageRange, type UsageV2 } from '../../src/contract/usage.ts';
import type { LedgerAccounting } from '../history/accounting.ts';
import { sizeBucket, type LedgerAttr, type LedgerRow } from '../history/ledger-schema.ts';
import { gap, reply, turn } from './rows.ts';

// Test support only (ui-history): the approved mock's History and Captures data (docs/design/2.0-mock-fixtures.json) as the
// ledger, trend and usage bodies the views read. S2 dropped the chat and subagent reasons, so the mock's two rows that
// used them read "overlapping requests" and "outside this chat's turn" here.

export const MOCK_NOW = fixtures.serverNow;
export const MOCK_MODELS = ['Example-27B-4bit', 'Example-35B-A3B-4bit'];
type MockAttr = { label: string; reason?: string };
const attr = (a: MockAttr): LedgerAttr => a.label === 'inferred' || a.label === 'armed' ? a.label
  : a.reason === 'several-chats' ? 'withheld:overlap' : a.reason === 'subagent-running' ? 'withheld:outside-turn'
    : a.reason && a.reason !== 'not-observed' ? `withheld:${a.reason}` as LedgerAttr : 'not-observed';

/** The mock's ledger, plus 33 older replies from the last 13 days so the baselines and basis counts have history. */
export const mockLedgerRows = (): LedgerRow[] => {
  const rows: LedgerRow[] = [];
  for (const item of fixtures.panel.ledger as Array<Record<string, unknown>>) {
    if (item.kind === 'gap') rows.push(gap(item.fromAt as number, item.toAt as number));
    else if (item.kind === 't') rows.push(turn(item.startedAt as number, item.endedAt as number, { steps: item.steps as number, output: item.outputTokens as number,
      wDecodeTps: item.wDecodeTps as number, waitMs: item.waitMs as number, attr: attr(item.attr as MockAttr) }));
    else {
      const prompt = item.promptTokens as number, cached = item.cachedTokens as number;
      rows.push(reply({ at: item.finishedAt as number, basis: item.basis as Basis, decodeTps: item.decodeTps as number, output: item.outputTokens as number,
        prompt, cached, ctxB: sizeBucket(prompt + (item.outputTokens as number)), uncB: sizeBucket(prompt - cached), prefillTps: 590 + prompt % 17,
        attr: attr(item.attr as MockAttr), cofactors: item.overlapped ? 8 : 0, energyJ: (item.outputTokens as number) / 0.72 }));
    }
  }
  for (let i = 0; i < 33; i += 1) {
    const prompt = 40_000 + i * 300, cached = Math.round(prompt * 0.8);
    rows.push(reply({ at: MOCK_NOW - 86_400_000 - i * 9 * 3_600_000, basis: 'last-observed', decodeTps: 24.4 + (i * 7 % 13) / 4, output: 900 + i * 37,
      prompt, cached, ctxB: sizeBucket(prompt), uncB: sizeBucket(prompt - cached), prefillTps: 560 + i * 7 % 90, energyJ: i % 2 ? (900 + i * 37) / (0.66 + i % 5 / 50) : null,
      attr: i % 3 ? 'inferred' : 'not-observed' }));
  }
  return rows.sort((a, b) => a[1] - b[1]);
};
export const mockAccounting = (full = false): LedgerAccounting => full
  ? { totalBytes: 1_424_384, keys: 64, ledgerBytes: 1_310_720, capBytes: 1_310_720, oldestS: Math.floor((MOCK_NOW - 19 * 86_400_000) / 1000) }
  : { totalBytes: 479_232, keys: 31, ledgerBytes: 421_888, capBytes: 1_310_720, oldestS: Math.floor((MOCK_NOW - 12 * 86_400_000) / 1000) };

const base = parseTrendV2(fixtures.trend)!;
/** The mock's 60 min trend, resampled for 15 and 30 min windows so every window button has data. */
export const mockTrend = (windowMs: TrendWindowMs = 3_600_000, fresh = false): TrendV2 => {
  const source = fresh ? parseTrendV2(fixtures.trendFresh)! : base, bucketMs = windowMs / 180, startAt = source.serverNow - windowMs;
  const buckets: TrendBucket[] = Array.from({ length: 180 }, (_, i) => {
    const at = startAt + (i + 0.5) * bucketMs, index = Math.floor((at - source.startAt) / source.bucketMs);
    return source.series.decodeTps!.buckets[index] ?? null;
  });
  return { ...source, windowMs, bucketMs, startAt, series: { decodeTps: { basis: 'reported', buckets } },
    gaps: source.gaps.filter(g => g.toAt > startAt).map(g => ({ fromAt: Math.max(g.fromAt, startAt), toAt: g.toAt })), marks: source.marks.filter(m => m.at >= startAt) };
};
export const mockUsage = (range: UsageRange = '7d'): UsageV2 => {
  const week = parseUsageV2(fixtures.usage)!;
  if (range === '7d') return week;
  const days = range === '30d' ? 30 : 90, dayMs = 86_400_000, first = week.buckets.at(-1)!.at - (days - 1) * dayMs;
  const buckets = Array.from({ length: days }, (_, i) => { const n = (i * 37 % 11) / 10; return { at: first + i * dayMs, requests: Math.round(60 * n), promptTokens: Math.round(2.8e6 * n),
    cachedTokens: Math.round(2.1e6 * n), outputTokens: Math.round(2.1e5 * n) }; });
  const sum = (key: 'requests' | 'promptTokens' | 'cachedTokens' | 'outputTokens') => buckets.reduce((total, b) => total + b[key], 0);
  return { ...week, range, granularity: 'day', buckets, totals: { requests: sum('requests'), promptTokens: sum('promptTokens'), cachedTokens: sum('cachedTokens'), outputTokens: sum('outputTokens') } };
};

const merge = (a: unknown, b: unknown): unknown => b === undefined ? a : b === null || typeof b !== 'object' || Array.isArray(b) ? b
  : Object.fromEntries([...new Set([...Object.keys(a ?? {}), ...Object.keys(b)])].map(k => [k, merge((a as Record<string, unknown>)?.[k], (b as Record<string, unknown>)[k])]));
/** A mock state's snapshot, validated like a real body. */
export const mockSnapshot = (state = 'decode'): SnapshotV2 => {
  const states = fixtures.states as Record<string, { snapshot: string; patch?: unknown }>, st = states[state] ?? states.decode!;
  return parseSnapshotV2(merge((fixtures.snapshots as Record<string, unknown>)[st.snapshot], st.patch))!;
};

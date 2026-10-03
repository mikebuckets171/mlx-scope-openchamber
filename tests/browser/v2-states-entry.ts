// The 2.0 fixture host's copy of the mock states: tests/browser/server.ts bundles this for v2-host.html.
import { MOCK_STATES, mockBody, mockTitle, type MockOptions } from '../../panel/testing/mock-states.ts';
import { MOCK_MODELS, MOCK_NOW, mockLedgerRows, mockTrend, mockUsage } from '../../panel/testing/mock-history.ts';
import { chunkKey, DEFAULT_PREF, KEYS, type ChunkV2, type LedgerRow } from '../../panel/history/ledger-schema.ts';
import { parseSnapshotV2 } from '../../src/contract/snapshot.ts';
import { TREND_WINDOWS_MS, type TrendWindowMs, type TrendV2 } from '../../src/contract/trend.ts';
import { USAGE_RANGES, type UsageRange, type UsageV2 } from '../../src/contract/usage.ts';

// Optional design handoff only. Every demo source is synthetic and stays in this test host.
const demoTrend = (now: number, seconds = '900', state = ''): TrendV2 => {
  const requested = Number(seconds) * 1000;
  const windowMs = TREND_WINDOWS_MS.includes(requested as TrendWindowMs) ? requested as TrendWindowMs : 900_000;
  const trend = mockTrend(windowMs), offset = now - trend.serverNow;
  // Splash live rates are a separate server signal; the persisted trend has no request-rate capability.
  if (state.startsWith('splash-')) { delete trend.series.decodeTps; delete trend.series.prefillTps; }
  return { ...trend, serverNow: now, startAt: trend.startAt + offset,
    gaps: trend.gaps.map(gap => ({ fromAt: gap.fromAt + offset, toAt: gap.toAt + offset })),
    marks: trend.marks.map(mark => ({ ...mark, at: mark.at + offset })) };
};

const demoUsage = (now: number, requested = '7d'): UsageV2 => {
  const range = USAGE_RANGES.includes(requested as UsageRange) ? requested as UsageRange : '7d';
  const usage = mockUsage(range), offset = now - usage.serverNow;
  const day = 86_400_000, calendarOffset = (Math.floor(now / day) - Math.floor(usage.serverNow / day)) * day;
  return { ...usage, serverNow: now, cachedAt: usage.cachedAt + offset,
    buckets: usage.buckets.map(bucket => ({ ...bucket, at: bucket.at + calendarOffset })) };
};

const demoStorage = (now: number): Record<string, unknown> => {
  const offset = Math.floor(now / 1000) - Math.floor(MOCK_NOW / 1000);
  const rows = mockLedgerRows().map(row => {
    const shifted: LedgerRow = [...row];
    shifted[1] += offset;
    if (shifted[0] !== 'r') shifted[2] += offset;
    return shifted;
  });
  const value: ChunkV2 = { v: 2, c: {}, r: rows };
  return { [KEYS.models]: MOCK_MODELS, [chunkKey(Math.min(...rows.map(row => row[1])), 'de00')]: value,
    [KEYS.pref]: { ...DEFAULT_PREF, tipDismissed: true, noticeDismissed: true } };
};

const DEMO_RATES = [26.4, 26.9, 27.7, 26.8, 25.8, 26.1, 27.3, 28.1, 27.5, 26.7, 25.9, 26.6];
const demoBody = (state: string, options: MockOptions, elapsedMs: number): Record<string, unknown> => {
  const body = mockBody(state === 'idle-pressure' ? 'pressure' : state, options);
  if (state === 'idle-pressure') body.runtime = mockBody('idle', options).runtime;
  const snapshot = parseSnapshotV2(body);
  if (state === 'splash-decode' && snapshot?.runtime.server.rates) {
    snapshot.runtime.server.rates.decodeTps = 43.8 + DEMO_RATES[Math.floor(Math.max(0, elapsedMs) / 1000) % DEMO_RATES.length]! - 26.4;
    return snapshot as unknown as Record<string, unknown>;
  }
  if (state !== 'decode' || !snapshot?.runtime.request) return body;
  const elapsed = Math.max(0, elapsedMs), rate = DEMO_RATES[Math.floor(elapsed / 500) % DEMO_RATES.length]!;
  const request = snapshot.runtime.request, output = (request.outputTokens ?? 0) + Math.floor(elapsed / 1000 * 26.6);
  request.decodeTps = rate; request.outputTokens = output;
  request.elapsedMs = (request.elapsedMs ?? 0) + elapsed;
  request.contextUsedTokens = (request.promptTokens ?? 0) + output;
  for (const model of snapshot.runtime.residency) if (model.phase === 'decode') model.decodeTps = rate;
  return snapshot as unknown as Record<string, unknown>;
};

(globalThis as unknown as { ScopeStates: unknown }).ScopeStates = {
  MOCK_STATES, mockBody, mockTitle, demoTrend, demoUsage, demoStorage, demoBody,
};

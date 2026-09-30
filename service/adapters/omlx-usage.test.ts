import { expect, test } from 'bun:test';
import { assertBodyLimit, bodyChars, classAKeys, MAX_BODY_CHARS } from '../../src/contract/guards.ts';
import { unitViolations } from '../../src/contract/units.ts';
import { parseUsageV2, USAGE_MAX_MODELS, type UsageRange, type UsageV2 } from '../../src/contract/usage.ts';
import type { ReadContext } from '../core/adapter-v2.ts';
import { OMLX_PATHS, OmlxAdapter } from './omlx.ts';
import { dayKey, normalizeOmlxUsage, readOmlxUsage, unavailableUsage, usageDays, usageDetails, usagePath } from './omlx-usage.ts';
import { admin, clock, contextFor, fakeOmlx, fixture, from, leaks, login, ok, wire, type Answer, type Route } from './testing/omlx.ts';

const NOW = Date.UTC(2026, 8, 29, 5, 30);
type Body = Record<string, any>;
const body = (file: string): Body => fixture('0.7.0rc1', file) as Body;
/** A frame's view of a /v2/usage body: it parses unchanged, in contract units, free of class A data, under the limit. */
const roundTrip = (usage: UsageV2, name = ''): UsageV2 => {
  expect(parseUsageV2(wire(usage)), name).toEqual(wire(usage));
  expect([unitViolations(usage), classAKeys(usage), leaks(usage)], name).toEqual([[], [], []]);
  expect(bodyChars(usage), name).toBeLessThan(MAX_BODY_CHARS);
  return usage;
};

test('paths: details only where G1 bounds the body, and never a key', () => {
  expect((['today', 'yesterday', '7d', '30d', '90d'] as const).map(range => usagePath(range, usageDetails(range)))).toEqual([
    '/admin/api/usage?range=today&include_details=true', '/admin/api/usage?range=yesterday&include_details=true',
    '/admin/api/usage?range=7d&include_details=true', '/admin/api/usage?range=30d', '/admin/api/usage?range=90d']);
});

test('day keys are oMLX’s local dates at 00:00 UTC; anything else is no date', () => {
  expect([dayKey('2026-09-23'), dayKey('2026-02-29'), dayKey('2026-13-01'), dayKey('2026-9-23'), dayKey('2026-09-23T00:00:00+09:00'), dayKey(20260923)])
    .toEqual([Date.UTC(2026, 8, 23), null, null, null, null, null]);
});

test('7d with details: one bucket per day with oMLX’s request and token split', () => {
  const usage = roundTrip(normalizeOmlxUsage(body('admin-api-usage.7d-details.json'), '7d', NOW)!);
  expect(usage).toMatchObject({ available: true, range: '7d', granularity: 'day', basis: 'reported', serverNow: NOW, cachedAt: NOW,
    totals: { requests: 788, promptTokens: 10_860_497, cachedTokens: 6_909_948, outputTokens: 434_032 } });
  expect(usage.buckets).toHaveLength(7);
  expect(usage.buckets[0]).toEqual({ at: Date.UTC(2026, 8, 23), requests: 139, promptTokens: expect.any(Number), cachedTokens: expect.any(Number),
    outputTokens: expect.any(Number), totalTokens: 1_980_632 });
  // An idle day is oMLX's recorded zero, and the day totals agree with the heatmap they summarise.
  expect(usage.buckets[3]).toMatchObject({ at: Date.UTC(2026, 8, 26), requests: 0, totalTokens: 0 });
  expect(usage.buckets.map(bucket => bucket.totalTokens)).toEqual(usageDays({ heatmap: body('admin-api-usage.7d-details.json').heatmap })!.map(bucket => bucket.totalTokens));
  expect(usage.buckets.reduce((sum, bucket) => sum + bucket.requests!, 0)).toBe(788);
  expect(usage.models).toEqual([{ model: 'Example-27B-4bit', requests: 500, promptTokens: 7_249_914, outputTokens: 295_552 },
    { model: 'Example-35B-A3B-4bit', requests: 288, promptTokens: 3_610_583, outputTokens: 138_480 }]);
});

test.each([['7d', 'admin-api-usage.7d.json', 7], ['30d', 'admin-api-usage.30d.json', 30], ['90d', 'admin-api-usage.90d.json', 90],
  ['90d', 'admin-api-usage.90d-many-models.json', 90]] as Array<[UsageRange, string, number]>)(
  'without details (%s, %s): day totals from the heatmap, no invented request counts', (range, file, days) => {
    const raw = body(file), usage = roundTrip(normalizeOmlxUsage(raw, range, NOW)!, file);
    expect(usage.buckets).toHaveLength(days);
    expect(usage.buckets.every(bucket => Object.keys(bucket).join() === 'at,totalTokens')).toBe(true);
    expect(usage.buckets.map(bucket => bucket.at)).toEqual([...usage.buckets.map(bucket => bucket.at)].sort((a, b) => a - b));
    expect(usage.buckets.reduce((sum, bucket) => sum + bucket.totalTokens!, 0)).toBe(raw.totals.prompt_tokens + raw.totals.completion_tokens);
    expect(usage.models).toHaveLength(Math.min(USAGE_MAX_MODELS, raw.models.length));
    // oMLX sorts models by tokens; the cap keeps its first 50.
    expect(usage.models.map(model => model.model)).toEqual(raw.models.slice(0, USAGE_MAX_MODELS).map((model: Body) => model.model_id));
  });

test('today and yesterday detail reads give their one day', () => {
  for (const [file, date] of [['admin-api-usage.today-details.json', 29], ['admin-api-usage.yesterday-details.json', 28]] as const) {
    const days = usageDays(body(file))!;
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ at: Date.UTC(2026, 8, date), requests: body(file).totals.requests, totalTokens: body(file).totals.total_tokens });
  }
});

test('recording off, unexpected bodies and malformed rows: hidden or left out, never zero', () => {
  expect(roundTrip(normalizeOmlxUsage(body('admin-api-usage.disabled.json'), '7d', NOW)!)).toEqual(unavailableUsage('disabled', '7d', NOW));
  expect(normalizeOmlxUsage({ ...body('admin-api-usage.7d.json'), available: false }, '7d', NOW)).toMatchObject({ available: false, reason: 'runtime_unavailable' });
  expect([normalizeOmlxUsage(body('admin-api-usage.7d.json'), '30d', NOW), normalizeOmlxUsage(body('admin-api-usage.bad-range.json'), '7d', NOW),
    normalizeOmlxUsage({ ...body('admin-api-usage.7d.json'), totals: { requests: -1 } }, '7d', NOW), normalizeOmlxUsage(null, '7d', NOW)])
    .toEqual([null, null, null, null]);
  const raw = body('admin-api-usage.7d.json');
  raw.heatmap[1].tokens[3] = -5; raw.heatmap[2].date = 'yesterday'; raw.heatmap[4].tokens = [];
  raw.models[1].model_id = '/Users/fixture/models/Example-35B-A3B-4bit'; raw.models.push({ model_id: 'x', requests: 1.5 });
  const usage = roundTrip(normalizeOmlxUsage(raw, '7d', NOW)!);
  expect(usage.buckets.map(bucket => new Date(bucket.at).getUTCDate())).toEqual([23, 26, 28, 29]);
  expect(usage.models.map(model => model.model)).toEqual(['Example-27B-4bit', 'Example-35B-A3B-4bit']);
});

test('the fullest body oMLX can produce stays far under the route limit', () => {
  const raw = body('admin-api-usage.90d-many-models.json');
  raw.models = raw.models.map((model: Body, index: number) => ({ ...model, model_id: `${'m'.repeat(252)}${String(index).padStart(4, '0')}`,
    requests: 999_999_999, prompt_tokens: 999_999_999_999, completion_tokens: 999_999_999_999 }));
  raw.heatmap = raw.heatmap.map((day: Body) => ({ ...day, tokens: Array(24).fill(99_999_999_999) }));
  const usage = roundTrip(normalizeOmlxUsage(raw, '90d', NOW)!);
  expect([usage.models.length, usage.models[0]!.model.length, usage.buckets.length]).toEqual([50, 256, 90]);
  expect(() => assertBodyLimit(usage)).not.toThrow();
  expect(bodyChars(usage)).toBeLessThan(40_000);
});

const usageServer = (answers: Partial<Record<UsageRange, Answer>>, key: string | null = 'fixture-main-key') => {
  const routes: Record<string, Route> = { [OMLX_PATHS.login]: login() };
  for (const [range, answer] of Object.entries(answers)) routes[usagePath(range as UsageRange, usageDetails(range as UsageRange))] = admin(answer);
  const fake = fakeOmlx(routes), time = clock(NOW);
  return { fake, time, context: contextFor(fake.fetchImpl, time, key) };
};

test('readOmlxUsage: one login, allowlisted fields, and the card hidden on 401/404/503', async () => {
  const { fake, context } = usageServer({ '7d': from('0.7.0rc1', 'admin-api-usage.7d-details.json'), '30d': from('0.7.0rc1', 'admin-api-usage.30d.json'),
    '90d': from('0.7.0rc1', 'admin-api-usage.unavailable.json', 503) });
  expect(roundTrip(await readOmlxUsage(context, '7d'))).toMatchObject({ available: true, range: '7d', buckets: { length: 7 } });
  expect(roundTrip(await readOmlxUsage(context, '30d'))).toMatchObject({ available: true, range: '30d', buckets: { length: 30 } });
  expect(roundTrip(await readOmlxUsage(context, '90d'))).toEqual(unavailableUsage('runtime_unavailable', '90d', NOW));
  expect(fake.calls.map(call => `${call.method} ${call.path}`)).toEqual(['POST /admin/api/login', 'GET /admin/api/usage?range=7d&include_details=true',
    'GET /admin/api/usage?range=30d', 'GET /admin/api/usage?range=90d']);
  expect(fake.calls.slice(1).every(call => call.headers.Cookie === 'omlx_admin_session=session-cookie' && !call.headers.Authorization)).toBe(true);
});

test('readOmlxUsage never throws: every failure is a reason', async () => {
  const cases: Array<[string, ReturnType<typeof usageServer>, UsageV2['reason']]> = [
    ['0.6.4 has no route', usageServer({ '7d': from('0.6.4', 'admin-api-usage.not-found.json', 404) }), 'route_missing'],
    ['cookie refused', usageServer({ '7d': from('0.7.0rc1', 'admin-api-usage.unauthorized.json', 401) }), 'admin_unauthorized'],
    ['sub key', usageServer({ '7d': from('0.7.0rc1', 'admin-api-usage.7d-details.json') }, 'fixture-sub-key'), 'admin_unauthorized'],
    ['bad range', usageServer({ '7d': from('0.7.0rc1', 'admin-api-usage.bad-range.json', 422) }), 'runtime_unavailable'],
    ['offline', usageServer({ '7d': 'network' }), 'runtime_unavailable'],
    ['recording off', usageServer({ '7d': from('0.7.0rc1', 'admin-api-usage.disabled.json') }), 'disabled'],
    ['not usage', usageServer({ '7d': ok({ detail: 'x' }) }), 'runtime_unavailable'],
  ];
  for (const [name, { context }, reason] of cases) expect(roundTrip(await readOmlxUsage(context, '7d'), name), name).toEqual(unavailableUsage(reason!, '7d', NOW));
});

test('usage reuses the adapter’s admin login, and the snapshot stops offering a card oMLX will not fill', async () => {
  const fake = fakeOmlx({ [OMLX_PATHS.health]: from('0.7.0rc1', 'health.healthy-loaded.json'), [OMLX_PATHS.login]: login(),
    [OMLX_PATHS.activity]: admin(from('0.7.0rc1', 'admin-api-activity.idle.json')), [OMLX_PATHS.status]: from('0.7.0rc1', 'api-status.idle.json'),
    [OMLX_PATHS.models]: ok({ models: [] }), [usagePath('7d', true)]: admin(from('0.7.0rc1', 'admin-api-usage.7d-details.json')),
    [usagePath('30d', false)]: admin(from('0.7.0rc1', 'admin-api-usage.disabled.json')) });
  const time = clock(NOW), context = contextFor(fake.fetchImpl, time), adapter = new OmlxAdapter(context);
  const read = () => adapter.read({ deadline: time.state.mono + 8_000, tier: 'full', detail: false } satisfies ReadContext);
  expect((await read()).capabilities['server.usage']).toEqual({ scope: 'server', basis: 'reported' });
  expect((await readOmlxUsage(context, '7d')).available).toBe(true);
  expect(fake.calls.filter(call => call.method === 'POST')).toHaveLength(1);
  // A 30d body with the wrong range is unexpected, and recording switched off hides the card until oMLX restarts.
  fake.routes[usagePath('30d', false)] = admin(ok({ ...body('admin-api-usage.disabled.json'), range: '30d' }));
  expect(await readOmlxUsage(context, '30d')).toMatchObject({ available: false, reason: 'disabled' });
  time.advance(1_000);
  expect((await read()).capabilities['server.usage']).toBeUndefined();
  expect((await readOmlxUsage(context, '7d')).available).toBe(true);
  time.advance(1_000);
  expect((await read()).capabilities['server.usage']).toEqual({ scope: 'server', basis: 'reported' });
});

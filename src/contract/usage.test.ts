import { expect, test } from 'bun:test';
import fixtures from '../../docs/design/2.0-mock-fixtures.json';
import { parseUsageV2 } from './usage.ts';

type Body = Record<string, any>;
const base = (): Body => structuredClone(fixtures.usage) as Body;
const edit = (change: (body: Body) => void): Body => { const body = base(); change(body); return body; };

test('the G2 mock usage parses unchanged', () => { expect(parseUsageV2(base())).toEqual(base() as never); });

test.each([
  ['null', null], ['contract v1', edit(body => { body.contractVersion = 1; })], ['a 1d range', edit(body => { body.range = 'today'; })],
  ['another basis', edit(body => { body.basis = 'derived'; })], ['a minute granularity', edit(body => { body.granularity = 'minute'; })],
  ['no totals', edit(body => { delete body.totals; })], ['fractional totals', edit(body => { body.totals.requests = 1.5; })],
  ['unavailable without a reason', edit(body => { body.available = false; })], ['an api_key', edit(body => { body.api_key = 'fixture'; })],
  ['a cookie in a bucket', edit(body => { body.buckets[0].cookie = 'x'; })],
] as Array<[string, unknown]>)('rejects %s', (_, body) => { expect(parseUsageV2(body)).toBeNull(); });

test('rows are allowlisted, model paths trimmed and lists capped', () => {
  const parsed = parseUsageV2(edit(body => {
    body.available = false; body.reason = 'admin_unauthorized';
    body.buckets = [{ at: 1, requests: 1, promptTokens: 2, outputTokens: 3, ttftMs: 5 }, { at: 1, requests: -1, promptTokens: 2, outputTokens: 3 }];
    body.models = Array.from({ length: 60 }, (_, index) => ({ model: `/models/m${index}`, requests: 1, promptTokens: 2, outputTokens: 3, cachedTokens: 1 }));
  }))!;
  expect(parsed).toMatchObject({ available: false, reason: 'admin_unauthorized' });
  expect(parsed.buckets).toEqual([{ at: 1, requests: 1, promptTokens: 2, outputTokens: 3 }]);
  expect(parsed.models).toHaveLength(50);
  expect(parsed.models[0]).toEqual({ model: 'm0', requests: 1, promptTokens: 2, outputTokens: 3 });
  expect(parseUsageV2(edit(body => { body.reason = 'not_omlx'; }))).not.toHaveProperty('reason');
});

test('§12.3: heatmap days carry a token total only; a bucket needs a total or both halves, and a present count must be valid', () => {
  const parsed = parseUsageV2(edit(body => {
    body.range = '90d';
    body.buckets = [{ at: 1, totalTokens: 7 }, { at: 2, promptTokens: 1, outputTokens: 2 }, { at: 3, requests: 4, totalTokens: 9 },
      { at: 4, promptTokens: 1 }, { at: 5 }, { at: 6, totalTokens: 1, requests: null }, { at: 7, totalTokens: 1.5 }, { at: 8, totalTokens: 3, cachedTokens: -1 }];
  }))!;
  expect(parsed.buckets).toEqual([{ at: 1, totalTokens: 7 }, { at: 2, promptTokens: 1, outputTokens: 2 }, { at: 3, requests: 4, totalTokens: 9 }]);
  expect(parseUsageV2(edit(body => { body.available = false; body.reason = 'disabled'; }))).toMatchObject({ available: false, reason: 'disabled' });
});

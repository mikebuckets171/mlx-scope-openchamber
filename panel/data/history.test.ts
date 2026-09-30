import { HostRequestError } from '@openchamber/sdk';
import { describe, expect, test } from 'bun:test';
import fixtures from '../../docs/design/2.0-mock-fixtures.json';
import { HistoryClient, trendQuery, usageQuery } from './history.ts';

type Reply = { status: number; body: unknown } | Error;
const host = (reply: Reply) => {
  const requests: unknown[] = [];
  return { requests, serviceRequest: async (request: unknown) => { requests.push(request); if (reply instanceof Error) throw reply; return reply as { status: number; body: unknown }; } };
};
const client = (reply: Reply) => { const h = host(reply); return { h, c: new HistoryClient(h as never) }; };

describe('History data client (/v2/trend, /v2/usage)', () => {
  test('queries are GET with the contract grammar: window in seconds, series and range as given', async () => {
    expect(trendQuery({ provider: 'omlx', windowMs: 900_000, series: ['decodeTps', 'active'] })).toEqual({ provider: 'omlx', window: '900', series: 'decodeTps,active' });
    expect(trendQuery({ runtime: 'splash', windowMs: 3_600_000, series: ['decodeTps'] })).toEqual({ runtime: 'splash', window: '3600', series: 'decodeTps' });
    expect(usageQuery({ range: '30d' })).toEqual({ range: '30d' });
    const { h, c } = client({ status: 200, body: JSON.stringify(fixtures.trend) });
    await c.trend({ provider: 'omlx', windowMs: 3_600_000, series: ['decodeTps'] });
    expect(h.requests).toEqual([{ method: 'GET', path: '/v2/trend', query: { provider: 'omlx', window: '3600', series: 'decodeTps' } }]);
  });
  test('string bodies are parsed and validated before use', async () => {
    const trend = await client({ status: 200, body: JSON.stringify(fixtures.trend) }).c.trend({ windowMs: 3_600_000, series: ['decodeTps'] });
    expect(trend.ok && trend.body.series.decodeTps?.buckets).toHaveLength(180);
    const usage = await client({ status: 200, body: JSON.stringify(fixtures.usage) }).c.usage({ range: '7d' });
    expect(usage.ok && usage.body.totals.requests).toBe(412);
  });
  test('404 is a still-running older service; 501 is a route not served yet; other codes are service failures', async () => {
    expect(await client({ status: 404, body: '{"error":"not_found"}' }).c.trend({ windowMs: 900_000, series: ['decodeTps'] })).toEqual({ ok: false, reason: 'contract_mismatch' });
    expect(await client({ status: 501, body: '{"error":"not_implemented"}' }).c.usage({ range: '7d' })).toEqual({ ok: false, reason: 'not_served' });
    expect(await client({ status: 400, body: '{"error":"bad_query"}' }).c.usage({ range: '7d' })).toEqual({ ok: false, reason: 'service_failed' });
  });
  test('another contract version, malformed JSON or a body that fails validation never reaches the view', async () => {
    expect(await client({ status: 200, body: '{"contractVersion":3}' }).c.trend({ windowMs: 900_000, series: ['decodeTps'] })).toEqual({ ok: false, reason: 'contract_mismatch' });
    expect(await client({ status: 200, body: '{"contractVersion":2' }).c.trend({ windowMs: 900_000, series: ['decodeTps'] })).toEqual({ ok: false, reason: 'unparseable' });
    const classA = JSON.stringify({ ...fixtures.usage, sessionId: 'canary-session' });
    expect(await client({ status: 200, body: classA }).c.usage({ range: '7d' })).toEqual({ ok: false, reason: 'unparseable' });
  });
  test('host errors become frame reasons; a refused grant is needs-approval', async () => {
    expect(await client(new HostRequestError('NOT_GRANTED', 'x')).c.trend({ windowMs: 900_000, series: ['decodeTps'] })).toEqual({ ok: false, reason: 'needs_approval' });
    expect(await client(new HostRequestError('HOST_TIMEOUT', 'x')).c.usage({ range: '7d' })).toEqual({ ok: false, reason: 'host_timeout' });
    expect(await client(new Error('boom')).c.usage({ range: '7d' })).toEqual({ ok: false, reason: 'host_unavailable' });
  });
});

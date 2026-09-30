import { expect, test } from 'bun:test';
import { HostRequestError } from '@openchamber/sdk';
import { isBadQuery, parseSnapshotQuery } from '../../src/contract/query.ts';
import { CONTRACT_MISMATCH } from '../present/messages.ts';
import { v2Body } from '../testing/readings.ts';
import { frameId, readResponse, snapshotQuery, SnapshotClient } from './client.ts';

const body = v2Body({ available: true, runtime: 'omlx', phase: 'decode', modelID: 'fixture/model', liveDecodeTPS: 24.6, activeRequests: 1, queuedRequests: 0, sampledAt: 1_000 });

test('the query carries the selection, this frame, its surface, the full tier and the cursor, and the service accepts it', () => {
  const frame = frameId();
  expect(frame).toMatch(/^[0-9a-f]{8}$/);
  const query = snapshotQuery({ provider: 'omlx', runtime: 'omlx', frame, surface: 'page', since: 7 });
  expect(query).toEqual({ provider: 'omlx', runtime: 'omlx', frame, surface: 'page', tier: 'full', since: '7' });
  const parsed = parseSnapshotQuery(new URLSearchParams(query));
  expect(isBadQuery(parsed)).toBe(false);
  expect(parsed).toMatchObject({ provider: 'omlx', runtime: 'omlx', frame, surface: 'page', tier: 'full', since: 7 });
  // A host surface v2 does not know is left out rather than rejected; an empty selection sends nothing.
  expect(snapshotQuery({ frame, surface: 'dialog' })).toEqual({ frame, tier: 'full' });
  expect(isBadQuery(parseSnapshotQuery(new URLSearchParams(snapshotQuery({ frame, surface: 'dialog' }))))).toBe(false);
});

test('bodies are read whether the host sends a string or an object', () => {
  for (const sent of [JSON.stringify(body), structuredClone(body)]) {
    const reading = readResponse(200, sent, 5_000);
    expect(reading).toMatchObject({ available: true, reason: null, runtime: 'omlx', phase: 'decode', model: 'fixture/model', sampledAt: 1_000 });
    expect(reading.body).toEqual(body);
  }
  expect(() => readResponse(200, '{not json', 5_000)).toThrow(SyntaxError);
});

test('a still-running older service is a contract mismatch; other failures keep their 1.6 meaning', () => {
  for (const [status, sent] of [[404, '{"error":"not_found"}'], [200, '{"contractVersion":1}'], [200, '{"contractVersion":3}']] as const) {
    expect(readResponse(status, sent, 5_000)).toMatchObject({ available: false, reason: 'contract_mismatch', message: CONTRACT_MISMATCH, sampledAt: 5_000, body: null });
  }
  expect(readResponse(200, '{"contractVersion":2}', 5_000)).toMatchObject({ available: false, reason: 'unparseable_snapshot', message: null });
  expect(readResponse(200, '{"available":true}', 5_000)).toMatchObject({ reason: 'unparseable_snapshot' });
  expect(readResponse(500, '', 5_000)).toMatchObject({ reason: 'service_failed', message: 'The MLX Scope service returned HTTP 500. Reopen the extension and try again.' });
  expect(readResponse(401, '', 5_000).message).toBe('The extension service authorization was rejected by OpenChamber.');
  // A leak anywhere in a body rejects all of it.
  expect(readResponse(200, JSON.stringify({ ...body, runtime: { ...body.runtime, api_key: 'fixture' } }), 5_000).reason).toBe('unparseable_snapshot');
});

test('the client asks GET /v2/snapshot and estimates the service clock from the median of five round trips', async () => {
  let now = 10_000, serverNow = 0;
  const calls: unknown[] = [];
  const client = new SnapshotClient({ serviceRequest: async request => {
    calls.push(request);
    now += 20;   // a 20 ms round trip; the service stamps its reply at the midpoint
    return { status: 200, body: JSON.stringify({ ...body, serverNow: serverNow + now - 10 }) };
  } }, () => now);
  expect(client.offsetMs).toBe(0);
  for (const offset of [250, 260, 5_000, 240, 255]) { serverNow = offset; await client.read({ frame: 'c0ffee42', surface: 'panel' }); }
  expect(calls[0]).toEqual({ method: 'GET', path: '/v2/snapshot', query: { frame: 'c0ffee42', surface: 'panel', tier: 'full' } });
  expect(client.offsetMs).toBe(255);
  expect(client.now()).toBe(now + 255);
  serverNow = 100; await client.read({ frame: 'c0ffee42', surface: 'panel' });
  expect(client.offsetMs).toBe(255);
});

test('NO_SERVICE after an update is the needs-approval state (S11); other host errors keep the 1.6 diagnostics', async () => {
  const failing = (error: unknown) => new SnapshotClient({ serviceRequest: async () => { throw error; } }, () => 7_000);
  const service = failing(new HostRequestError('NO_SERVICE', 'NO_SERVICE: Allow this extension’s local service in Settings → Extensions.'));
  const error = await service.read({ frame: 'c0ffee42', surface: 'panel' }).catch(caught => caught);
  expect(service.failure(error)).toMatchObject({ available: false, reason: 'needs_approval', sampledAt: 7_000, body: null,
    message: 'Allow MLX Scope’s local service in Settings → Extensions.' });
  expect(failing(null).failure(new HostRequestError('SERVICE_FAILED', 'raw detail'))).toMatchObject({ reason: 'service_failed',
    message: 'The MLX Scope service is stopped or failed. Reopen the extension or check its approval.' });
  expect(failing(null).failure(new Error('raw detail'))).toMatchObject({ reason: 'host_unavailable',
    message: 'OpenChamber did not return a service response. Reopen the panel and try again.' });
});

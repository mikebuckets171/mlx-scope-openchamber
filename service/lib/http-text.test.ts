import { expect, test } from 'bun:test';
import { HttpFailure } from '../http.ts';
import { isRouteMissingBody, JSON_MAX_BYTES, requestReply, requestText } from './http-text.ts';

const url = new URL('http://127.0.0.1:8000/metrics');
const failure = async (run: () => Promise<unknown>): Promise<string | null> => {
  try { await run(); return null; } catch (error) { return error instanceof HttpFailure ? `${error.reason}: ${error.message}` : `thrown: ${String(error)}`; }
};

test('text and JSON GETs return every status, and never follow a redirect', async () => {
  const seen: RequestInit[] = [];
  const reply = (status: number, body: string) => async (_input: RequestInfo | URL, init?: RequestInit) => { seen.push(init!); return new Response(body, { status }); };
  expect(await requestText({ url, fetchImpl: reply(200, '# TYPE a counter\na 1\n') })).toEqual({ status: 200, text: '# TYPE a counter\na 1\n' });
  expect(await requestText({ url, fetchImpl: reply(501, '{"error":{"code":501}}') })).toEqual({ status: 501, text: '{"error":{"code":501}}' });
  expect(await requestReply({ url, fetchImpl: reply(401, '{"detail":"Unauthorized"}') })).toEqual({ status: 401, body: { detail: 'Unauthorized' }, routeMissing: false });
  expect(await requestReply({ url, fetchImpl: reply(503, '{"status":"loading"}') })).toEqual({ status: 503, body: { status: 'loading' }, routeMissing: false });
  expect(await requestReply({ url, fetchImpl: reply(200, 'not json') })).toEqual({ status: 200, body: null, routeMissing: false });
  expect(await requestReply({ url, fetchImpl: reply(200, '[1]') })).toEqual({ status: 200, body: null, routeMissing: false });
  expect(seen.every(init => init.redirect === 'manual' && init.method === 'GET')).toBe(true);
  for (const status of [301, 302, 307, 308]) {
    expect(await failure(() => requestReply({ url, fetchImpl: async () => new Response('', { status, headers: { location: 'http://127.0.0.1:9/' } }) })))
      .toBe('runtime_unreachable: The runtime returned an unsafe response.');
  }
  const moved = Object.defineProperty(new Response('{}'), 'url', { value: 'http://127.0.0.1:9000/other' });
  expect(await failure(() => requestReply({ url, fetchImpl: async () => moved }))).toBe('runtime_unreachable: The runtime returned an unsafe response.');
});

test('LM Studio answers unknown routes with 200 and an error body: that is a missing route', async () => {
  const body = { error: 'Unexpected endpoint or method. (GET /health)' };
  expect(await requestReply({ url, fetchImpl: async () => new Response(JSON.stringify(body)) })).toEqual({ status: 200, body, routeMissing: true });
  expect(isRouteMissingBody(body)).toBe(true);
  expect(isRouteMissingBody({ error: 'unexpected endpoint' })).toBe(true);
  for (const other of [{ error: 'Model not loaded' }, { error: 'Unexpected endpoint', models: [] }, { error: 'Unexpected endpoint', data: [] }, null, [], 'x', { error: 42 }]) {
    expect(isRouteMissingBody(other), JSON.stringify(other)).toBe(false);
  }
  // Only a 200 is folded: a 404 with the same body is already a 404.
  expect((await requestReply({ url, fetchImpl: async () => new Response(JSON.stringify(body), { status: 404 }) })).routeMissing).toBe(false);
});

test('size caps, timeouts and network failures throw as unreachable, and release the body stream', async () => {
  let cancelled = false;
  const endless = () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(64 * 1024)); }, cancel() { cancelled = true; } }));
  expect(await failure(() => requestText({ url, fetchImpl: async () => endless(), maxBytes: 100_000 }))).toBe('runtime_unreachable: The runtime response was too large.');
  expect(cancelled).toBe(true);
  expect(await failure(() => requestReply({ url, fetchImpl: async () => new Response('x'.repeat(JSON_MAX_BYTES + 1)) })))
    .toBe('runtime_unreachable: The runtime response was too large.');
  let signal: AbortSignal | undefined;
  const start = performance.now();
  expect(await failure(() => requestText({ url, timeoutMs: 40, fetchImpl: async (_input, init) => { signal = init?.signal ?? undefined; return new Promise<Response>(() => {}); } })))
    .toBe('runtime_unreachable: The runtime request timed out.');
  expect(performance.now() - start).toBeLessThan(500);
  expect(signal?.aborted).toBe(true);
  expect(await failure(() => requestReply({ url, fetchImpl: async () => { throw new TypeError('fetch failed'); } }))).toBe('runtime_unreachable: The runtime did not answer.');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePlugin } from './index.js';
import { createStore, key, MAX_ENTRIES, TTL_MS } from './store.js';
import { observeStream, parseProgress } from './stream.js';

const encode = text => new TextEncoder().encode(text);
const progress = (processed = 32, extra = {}) => `data: ${JSON.stringify({ model: 'canonical/model', choices: [{ delta: {} }], prompt_progress: { total: 100, cache: 20, processed, time_ms: processed / 2 }, ...extra })}\r\n\r\n`;
const metadata = { requestID: 'request-opaque', sessionKey: key('session', 'ses_private'), providerID: 'splish', endpointKey: key('endpoint', 'http://127.0.0.1:8000'), modelKey: key('model', 'alias/model'), kind: 'primary' };
const memory = () => {
  const entries = new Map(); let closed = false;
  return { entries, update: item => entries.set(item.requestID, item), remove: id => entries.delete(id), close: async () => { closed = true; entries.clear(); }, get closed() { return closed; } };
};
function source(parts) {
  let reads = 0, cancelled;
  return { response: new Response(new ReadableStream({ pull(c) { reads++; if (parts.length) c.enqueue(parts.shift()); else c.close(); }, cancel(reason) { cancelled = reason; } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream', 'x-test': 'preserved' } }), get reads() { return reads; }, get cancelled() { return cancelled; } };
}
const event = (extra = {}) => ({ sessionID: 'ses_private', kind: 'primary', model: { providerID: 'splish', id: 'alias/model' }, request: new Request('http://127.0.0.1:8000/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', 'x-opencode-session-id': 'ses_private', authorization: 'Bearer secret-token' }, body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'PRIVATE PROMPT' }] }) }), ...extra });
async function setup(store = memory(), shared = {}) {
  const hooks = new Map(), options = [];
  const dispose = await makePlugin({ storeFactory: () => store, shared }).setup({ session: { hook: async (name, callback, filter) => { hooks.set(name, callback); options.push(filter); } } });
  return { hooks, options, store, dispose };
}

test('http hooks opt in only the same Splash request', async () => {
  const plugin = await setup(), input = event(); const original = await input.request.clone().json();
  await plugin.hooks.get('http.request')(input);
  assert.equal(input.request.url, 'http://127.0.0.1:8000/v1/chat/completions');
  assert.equal(input.request.headers.get('authorization'), 'Bearer secret-token');
  assert.deepEqual(await input.request.clone().json(), { ...original, return_progress: true });
  assert.deepEqual(plugin.options, [{ providerID: 'splish' }, { providerID: 'splish' }]);
  const upstream = source([encode(progress()), encode('data: [DONE]\n\n')]); input.response = upstream.response;
  plugin.hooks.get('http.response')(input);
  const reader = input.response.body.getReader(); await reader.read();
  const saved = [...plugin.store.entries.values()][0];
  assert.equal(saved.sessionKey, key('session', 'ses_private')); assert.equal(saved.responseModelKey, key('model', 'canonical/model'));
  assert.equal(saved.processed / saved.total, 0.32); assert.equal(saved.cache, 20);
  assert.ok(!JSON.stringify(saved).match(/PRIVATE|secret-token|ses_private|canonical\/model|alias\/model/));
  await reader.read(); assert.equal(plugin.store.entries.size, 0); await reader.cancel(); await plugin.dispose();
});

test('other providers, nonloopback routes, auxiliary wrong session headers and nonstreaming bodies are untouched', async () => {
  const plugin = await setup();
  const requests = [event({ model: { providerID: 'omlx', id: 'model' } }), event({ request: new Request('https://example.com/v1/chat/completions', event().request) }), event({ sessionID: 'different' }), event({ kind: 'unknown' })];
  const unstreamed = event(); unstreamed.request = new Request(unstreamed.request, { body: JSON.stringify({ stream: false, messages: [] }) }); requests.push(unstreamed);
  for (const input of requests) { const original = input.request; await plugin.hooks.get('http.request')(input); assert.equal(input.request, original); }
  assert.equal(plugin.store.entries.size, 0); await plugin.dispose();
});

test('response bytes, chunk boundaries, headers and backpressure are preserved', async () => {
  const bytes = encode(progress()); const chunks = [bytes.slice(0, 1), bytes.slice(1, 27), bytes.slice(27, -1), bytes.slice(-1)];
  const originals = [...chunks], upstream = source(chunks), store = memory();
  const response = observeStream(upstream.response, { metadata, store });
  assert.equal(upstream.reads, 0); assert.equal(response.headers.get('x-test'), 'preserved');
  const reader = response.body.getReader();
  for (const original of originals) { const next = await reader.read(); assert.equal(next.value, original); }
  assert.equal(upstream.reads, 4); assert.equal(store.entries.size, 1);
  await reader.cancel('user stopped'); assert.equal(upstream.cancelled, 'user stopped'); assert.equal(store.entries.size, 0);
});

test('every SSE byte split, CRLF boundary and UTF8 split preserves the same progress', async () => {
  const bytes = encode(progress(40, { ignored: '🙂' }));
  for (let split = 1; split < bytes.length; split++) {
    const store = memory(), upstream = source([bytes.slice(0, split), bytes.slice(split)]);
    const reader = observeStream(upstream.response, { metadata, store }).body.getReader();
    await reader.read(); await reader.read(); assert.equal([...store.entries.values()][0].processed, 40); await reader.cancel();
  }
});

test('first generation/finish/error frame clears progress without altering reply bytes', async () => {
  for (const body of [{ choices: [{ delta: { content: 'text' } }] }, { choices: [{ delta: { reasoning_content: 'thinking' } }] }, { choices: [{ delta: { tool_calls: [{ id: 'call' }] } }] }, { choices: [{ finish_reason: 'stop' }] }, { type: 'response.output_text.delta', delta: 'text' }, { type: 'content_block_start' }, { error: { message: 'failed' } }]) {
    const store = memory(), parts = [encode(progress()), encode(`data: ${JSON.stringify(body)}\n\n`)];
    const reader = observeStream(source(parts).response, { metadata, store }).body.getReader();
    await reader.read(); assert.equal(store.entries.size, 1); await reader.read(); assert.equal(store.entries.size, 0); await reader.cancel();
  }
});

test('stream EOF, error and request abort clear progress', async () => {
  for (const end of ['eof', 'error', 'abort']) {
    let controller; const upstream = new ReadableStream({ start(c) { controller = c; c.enqueue(encode(progress())); } });
    const store = memory(), signal = new AbortController();
    const reader = observeStream(new Response(upstream, { headers: { 'content-type': 'text/event-stream' } }), { metadata, store, signal: signal.signal }).body.getReader();
    await reader.read(); assert.equal(store.entries.size, 1);
    if (end === 'eof') { controller.close(); await reader.read(); }
    if (end === 'error') { controller.error(new Error('upstream failed')); await assert.rejects(reader.read(), /upstream failed/); }
    if (end === 'abort') { signal.abort(); assert.equal(store.entries.size, 0); await reader.cancel(); }
    assert.equal(store.entries.size, 0);
  }
});

test('invalid counts, cache bounds, rollback and changed totals cannot create or retain percentages', async () => {
  for (const candidate of [{ total: 0, cache: 0, processed: 0, time_ms: 0 }, { total: 100, cache: 60, processed: 50, time_ms: 1 }, { total: true, cache: 0, processed: 1, time_ms: 1 }, { total: 100, cache: 0, processed: 1.5, time_ms: 1 }, { total: 100, cache: 0, processed: 101, time_ms: 1 }, { total: 100, cache: 0, processed: 1, time_ms: Infinity }]) assert.equal(parseProgress(candidate), null);
  const previous = { total: 100, cache: 20, processed: 50, timeMs: 25 };
  for (const candidate of [{ total: 100, cache: 20, processed: 40, time_ms: 26 }, { total: 101, cache: 20, processed: 60, time_ms: 26 }, { total: 100, cache: 21, processed: 60, time_ms: 26 }, { total: 100, cache: 20, processed: 60, time_ms: 24 }]) assert.equal(parseProgress(candidate, previous), null);
  const store = memory(), reader = observeStream(source([encode(progress(50)), encode(progress(40)), encode(progress(60))]).response, { metadata, store }).body.getReader();
  await reader.read(); assert.equal(store.entries.size, 1); await reader.read(); await reader.read(); assert.equal(store.entries.size, 0); await reader.cancel();
});

test('oversized or malformed telemetry abandons observation while continuing byte passthrough', async () => {
  for (const invalid of ['data: {bad json}\n\n', 'data: ' + 'x'.repeat(70_000) + '\n\n']) {
    const store = memory(), original = encode(invalid), reader = observeStream(source([encode(progress()), original]).response, { metadata, store }).body.getReader();
    await reader.read(); assert.equal((await reader.read()).value, original); assert.equal(store.entries.size, 0); await reader.cancel();
  }
});

test('Responses and Messages protocol progress uses the same validated counters', async () => {
  for (const protocol of ['response.in_progress', 'ping']) {
    const store = memory(), body = { type: protocol, prompt_progress: { total: 50, cache: 10, processed: 25, time_ms: 10.5 } };
    const reader = observeStream(source([encode(`event: ${protocol}\ndata: ${JSON.stringify(body)}\n\n`)]).response, { metadata, store }).body.getReader();
    await reader.read(); assert.equal([...store.entries.values()][0].processed / 50, 0.5); await reader.cancel();
  }
});

test('process-shared plugin store survives one location unloading', async () => {
  const shared = {}, store = memory(), first = await setup(store, shared), second = await setup(store, shared);
  await first.dispose(); assert.equal(store.closed, false); await second.dispose(); assert.equal(store.closed, true);
});

test('location unload disables its observers while another location keeps the shared store alive', async () => {
  const shared = {}, store = memory(), first = await setup(store, shared), second = await setup(store, shared), input = event();
  await first.hooks.get('http.request')(input); input.response = source([encode(progress()), encode(progress(50))]).response;
  first.hooks.get('http.response')(input); const reader = input.response.body.getReader(); await reader.read();
  assert.equal(store.entries.size, 1); await first.dispose(); await reader.read(); assert.equal(store.entries.size, 0);
  await reader.cancel(); await second.dispose();
});

test('atomic per-writer files have bounded entries, private permissions, TTL and lifecycle cleanup', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'scope-bridge-test-'))); let now = 100_000;
  const store = createStore({ directory, now: () => now, intervalMs: 0 });
  try {
    for (let i = 0; i < MAX_ENTRIES + 3; i++) store.update({ ...metadata, requestID: `id-${i}`, total: 100, cache: 20, processed: 30, timeMs: 1 });
    await store.flush();
    const parsed = JSON.parse(await readFile(store.file, 'utf8'));
    assert.equal(parsed.schemaVersion, 1); assert.equal(parsed.entries.length, MAX_ENTRIES);
    assert.equal((await stat(store.file)).mode & 0o777, 0o600); assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(directory), [`${store.writerID}.json`]);
    now += TTL_MS; await store.flush(); assert.deepEqual(await readdir(directory), []);
    store.update({ ...metadata, total: 100, cache: 20, processed: 40, timeMs: 2 }); await store.flush(); assert.equal((await readdir(directory)).length, 1);
    await store.close(); assert.deepEqual(await readdir(directory), []);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('independent writers never overwrite or delete each other', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'scope-bridge-test-')));
  const first = createStore({ directory, intervalMs: 0 }), second = createStore({ directory, intervalMs: 0 });
  try {
    for (const store of [first, second]) { store.update({ ...metadata, total: 100, cache: 20, processed: 30, timeMs: 1 }); await store.flush(); }
    assert.equal((await readdir(directory)).length, 2); await first.close(); assert.deepEqual(await readdir(directory), [`${second.writerID}.json`]);
  } finally { await first.close(); await second.close(); await rm(directory, { recursive: true, force: true }); }
});

test('cache failures do not reject generation or emit sensitive warning data', async () => {
  const messages = [], store = createStore({ directory: '/dev/null/scope-cache', warn: value => messages.push(value), intervalMs: 0 });
  store.update({ ...metadata, total: 100, cache: 20, processed: 30, timeMs: 1 }); await store.flush(); await store.close();
  assert.equal(messages.length, 1); assert.ok(!messages[0].includes('ses_private'));
});

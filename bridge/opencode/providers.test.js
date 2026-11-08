import test from 'node:test';
import assert from 'node:assert/strict';
import { makePlugin } from './index.js';
import { key } from './store.js';
import { createSplashLookup, namesSplash, splashOptions } from './providers.js';

const row = (id, name, baseURL) => ({ id, name, activation: 'enabled', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL, apiKey: 'sk-never-read' } });
const SPLASH = row('splash', 'Splash', 'http://127.0.0.1:18181/v1');
const clock = (start = 1_000_000) => { let at = start; return { now: () => at, advance: ms => { at += ms; } }; };
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

test('Splash is named by the same id and name rule as the service, with LM Studio taking precedence', () => {
  for (const [id, name] of [['splash', 'Splash'], ['Splash ', ''], ['local', 'Splash'], ['splish', 'x'], ['my-splish-fork', ''], ['llama-swap', 'Splash via llama-swap']]) assert.equal(namesSplash(id, name), true, `${id}/${name}`);
  for (const [id, name] of [['splash-bionic', 'Splash via Bionic'], ['lmstudio', 'Splash'], ['omlx', 'oMLX'], ['openai', 'OpenAI'], ['ollama', 'Ollama'], ['', '']]) assert.equal(namesSplash(id, name), false, `${id}/${name}`);
});

test('only a loopback /v1 address is accepted for a Splash provider', () => {
  assert.deepEqual(splashOptions({ providerID: 'splash', baseURL: 'http://localhost:8000/v1/' }),
    { providerID: 'splash', origin: 'http://localhost:8000', endpointKey: key('endpoint', 'http://127.0.0.1:8000') });
  for (const baseURL of ['https://example.com/v1', 'http://splash.example.com:8000/v1', 'http://127.0.0.1:8000', 'http://127.0.0.1:8000/v1?x=1', 'http://user:pass@127.0.0.1:8000/v1', undefined]) {
    if (baseURL === undefined) { assert.equal(splashOptions({}).origin, 'http://127.0.0.1:8000'); continue; }
    assert.throws(() => splashOptions({ providerID: 'splash', baseURL }), /loopback Splash/);
  }
});

test('a lookup finds a Splash provider by id or name, returns its address and never its key, and ignores the rest', async () => {
  const lookup = createSplashLookup({ list: async () => [row('openai', 'OpenAI', 'https://api.openai.com/v1'), SPLASH, row('local', 'Splash', 'http://localhost:8000/v1'),
    row('splash-lan', 'Splash', 'http://splash.example.com:8000/v1'), row('lms', 'LM Studio', 'http://127.0.0.1:1234/v1')] });
  const found = await lookup('splash');
  assert.deepEqual(found, { providerID: 'splash', origin: 'http://127.0.0.1:18181', endpointKey: key('endpoint', 'http://127.0.0.1:18181') });
  assert.deepEqual(await lookup('local'), { providerID: 'local', origin: 'http://localhost:8000', endpointKey: key('endpoint', 'http://127.0.0.1:8000') });
  for (const id of ['openai', 'splash-lan', 'lms', 'missing', 'bad id', '', undefined, 5]) assert.equal(await lookup(id), null, String(id));
  assert.ok(!JSON.stringify(found).includes('sk-never-read'));
});

test('the provider list is read once per ttl, answered from the last read in between, and not retried faster than retryMs', async () => {
  const time = clock(); let reads = 0, down = false;
  const lookup = createSplashLookup({ list: async () => { reads++; if (down) throw new Error('down'); return [SPLASH]; }, now: time.now });
  assert.ok(await lookup('splash')); assert.equal(reads, 1);
  time.advance(10_000); assert.ok(await lookup('splash')); assert.equal(reads, 1);
  // A provider the last read did not list is looked for again, once, and the next ask within retryMs does not repeat it.
  assert.equal(await lookup('newcomer'), null); await settle(); assert.equal(reads, 2);
  assert.equal(await lookup('newcomer'), null); await settle(); assert.equal(reads, 2);
  // Past the ttl the old answer is still given at once while a fresh read runs behind it.
  time.advance(30_000); assert.ok(await lookup('splash')); await settle(); assert.equal(reads, 3);
  down = true; time.advance(30_000);
  assert.ok(await lookup('splash')); await settle(); assert.equal(reads, 4);
  assert.ok(await lookup('splash')); await settle(); assert.equal(reads, 4);
  time.advance(5_000); assert.ok(await lookup('splash')); await settle(); assert.equal(reads, 5);
});

test('the first lookup waits only briefly for a slow provider list; the answer arrives with a later request', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const lookup = createSplashLookup({ list: () => gate.then(() => [SPLASH]), firstWaitMs: 20 });
  const started = Date.now(); assert.equal(await lookup('splash'), null); assert.ok(Date.now() - started < 1_000);
  release(); await settle(); assert.ok(await lookup('splash'));
});

test('every request that arrives during the first read waits for it, and none waits again, even for a list that never answers', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const lookup = createSplashLookup({ list: () => gate.then(() => [SPLASH]), firstWaitMs: 5_000 });
  const both = Promise.all([lookup('splash'), lookup('splash')]); release();
  for (const found of await both) assert.ok(found);
  const time = clock(), hung = createSplashLookup({ list: () => new Promise(() => {}), now: time.now, firstWaitMs: 100 });
  assert.equal(await hung('splash'), null);
  time.advance(5_000);
  assert.equal(await Promise.race([hung('splash'), new Promise(resolve => setTimeout(resolve, 50, 'still waiting'))]), null);
});

test('a provider list that is missing, malformed or throws never makes a lookup throw', async () => {
  for (const list of [async () => null, async () => ({}), async () => [null, 5, 'x', {}, { id: 7 }], async () => { throw new Error('boom'); }, () => { throw new Error('sync boom'); }]) {
    const lookup = createSplashLookup({ list }); assert.equal(await lookup('splash'), null);
  }
});

const encode = text => new TextEncoder().encode(text);
const progress = (processed = 32) => `data: ${JSON.stringify({ model: 'canonical/model', choices: [{ delta: {} }], prompt_progress: { total: 100, cache: 20, processed, time_ms: processed / 2 } })}\r\n\r\n`;
const memory = () => { const entries = new Map(); return { entries, update: item => entries.set(item.requestID, item), remove: id => entries.delete(id), close: async () => entries.clear() }; };
const request = (url, providerID) => ({ sessionID: 'ses_private', kind: 'primary', model: { providerID, id: 'alias/model' },
  request: new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-opencode-session-id': 'ses_private' }, body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'PRIVATE PROMPT' }] }) }) });
const splashRequest = () => request('http://127.0.0.1:18181/v1/chat/completions', 'splash');
async function load({ list, options, version = '2.2.6' } = {}) {
  const hooks = new Map(), filters = [], store = memory(); let listed = 0;
  const ctx = { app: { version }, ...options ? { options } : {}, session: { hook: async (name, callback, filter) => { hooks.set(name, callback); filters.push(filter); } },
    provider: { list: async () => { listed++; return list(); } } };
  const dispose = await makePlugin({ storeFactory: () => store, shared: {}, observerFactory: () => ({ async attach() {}, async close() {} }) }).setup(ctx);
  return { hooks, filters, store, dispose, get listed() { return listed; } };
}

test('with no options, a request to the Splash provider OpenCode lists gets progress and is observed; every other provider is untouched', async () => {
  const plugin = await load({ list: async () => ({ data: [SPLASH, row('openai', 'OpenAI', 'https://api.openai.com/v1')] }) });
  assert.deepEqual(plugin.filters, [undefined, undefined]);
  const input = splashRequest(), original = await input.request.clone().json();
  await plugin.hooks.get('http.request')(input);
  assert.deepEqual(await input.request.clone().json(), { ...original, return_progress: true });
  const cloud = request('https://api.openai.com/v1/chat/completions', 'openai'), before = cloud.request;
  await plugin.hooks.get('http.request')(cloud); assert.equal(cloud.request, before);
  cloud.response = new Response('x', { headers: { 'content-type': 'text/event-stream' } });
  const untouched = cloud.response; plugin.hooks.get('http.response')(cloud); assert.equal(cloud.response, untouched); assert.equal(plugin.store.entries.size, 0);
  input.response = new Response(new ReadableStream({ start(controller) { controller.enqueue(encode(progress())); } }), { headers: { 'content-type': 'text/event-stream' } });
  plugin.hooks.get('http.response')(input);
  const reader = input.response.body.getReader(); await reader.read();
  const saved = [...plugin.store.entries.values()][0];
  assert.equal(saved.providerID, 'splash'); assert.equal(saved.endpointKey, key('endpoint', 'http://127.0.0.1:18181')); assert.equal(saved.sessionKey, key('session', 'ses_private'));
  assert.ok(!JSON.stringify(saved).match(/PRIVATE|sk-never-read|ses_private/));
  await reader.cancel(); await plugin.dispose();
});

test('a Splash provider that is not on loopback, or a provider list that fails, leaves requests exactly as they were', async () => {
  for (const list of [async () => [row('splash', 'Splash', 'http://splash.example.com:18181/v1')], async () => { throw new Error('unavailable'); }, async () => null]) {
    const plugin = await load({ list }), input = splashRequest(), before = input.request;
    await plugin.hooks.get('http.request')(input); assert.equal(input.request, before); await plugin.dispose();
  }
});

test('options naming a provider keep the earlier behavior and never read the provider list; promptProgress false installs nothing', async () => {
  const named = await load({ list: async () => [SPLASH], options: { providerID: 'splish', baseURL: 'http://127.0.0.1:8000/v1' } });
  assert.deepEqual(named.filters, [{ providerID: 'splish' }, { providerID: 'splish' }]); assert.equal(named.listed, 0);
  const input = splashRequest(), before = input.request; await named.hooks.get('http.request')(input); assert.equal(input.request, before);
  assert.equal(named.listed, 0); await named.dispose();
  const off = await load({ list: async () => [SPLASH], options: { promptProgress: false } });
  assert.equal(off.hooks.size, 0); assert.equal(off.listed, 0); await off.dispose();
});

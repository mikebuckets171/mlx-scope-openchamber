import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_PROTOCOL, FEATURE_IDS, REVIEWED_BUILDS, acceptsChatProtocol, acceptsRuntime, featureSupport, parseFeatures } from './compatibility.js';
import { QUALIFIED_VERSIONS, candidateProfile, modeFor, profileFor } from './qualified.js';
import { makePlugin } from './index.js';

test('the helper accepts the reviewed OpenCode lines and reviewed local builds only', () => {
  for (const version of ['2.0.25', '2.0.26', '2.0.29', '2.0.32', '2.0.33', '2.0.100', '2.0.9999', '2.1.1', '2.1.2', '2.1.9999']) {
    assert.equal(acceptsRuntime(version), true, version);
    assert.equal(acceptsChatProtocol(version, CHAT_PROTOCOL), true);
    assert.equal(acceptsChatProtocol(version, 'future-wire'), false);
    assert.equal(acceptsChatProtocol(version, undefined), false);
  }
  for (const version of REVIEWED_BUILDS) assert.equal(acceptsRuntime(version), true, version);
  for (const version of [undefined, null, '', 2.0, '2.0.24', '2.0.0', '2.0.032', '2.0.25-custom', '2.0.32.1', ' 2.0.32', '2.1.0', '2.1.01',
    '2.1.1-compaction', '2.1.1-compaction.2', '2.1.1-custom', '2.1.2-rc.1', '2.2.0', '2.10.25', '3.0.0', '1.19.3', '2.0.10000'])
    assert.equal(acceptsRuntime(version), false, String(version));
});

test('native qualification is a separate service-side record of exact versions', () => {
  assert.deepEqual(QUALIFIED_VERSIONS, ['2.0.25', '2.0.27', '2.0.28', '2.0.29', '2.0.32', '2.1.1-compaction.1']);
  for (const version of QUALIFIED_VERSIONS) {
    assert.equal(profileFor(version).id, `opencode-${version}-v1`);
    assert.equal(profileFor(version).websocketCancellation, version === '2.0.25' ? 'unit-only' : 'native');
    assert.equal(modeFor(version), 'qualified');
  }
  for (const version of ['2.0.26', '2.0.30', '2.0.31', '2.0.33', '2.1.1', '2.1.2']) {
    assert.equal(profileFor(version), null);
    assert.equal(modeFor(version), 'self-checked');
    assert.equal(candidateProfile(version).candidate, true);
  }
  for (const version of ['2.0.24', '2.1.0', '2.2.0', '2.0.32-custom', undefined]) {
    assert.equal(modeFor(version), 'unsupported');
    assert.equal(candidateProfile(version), null);
  }
});

test('feature status carries checks, upgrades 3.3 helpers, and rejects contradictory claims', () => {
  const features = featureSupport('2.0.32');
  features['http-delivery'] = { support: 'compatible', available: true, check: { state: 'passed' } };
  features['prompt-progress'] = { support: 'unavailable', available: false, check: { state: 'failed', reason: 'session-header' } };
  const parsed = parseFeatures({ ...features, privateContent: 'not retained' }, '2.0.32');
  assert.deepEqual(Object.keys(parsed), FEATURE_IDS);
  assert.deepEqual(parsed['http-delivery'], { support: 'compatible', available: true, check: { state: 'passed' } });
  assert.deepEqual(parsed['prompt-progress'], { support: 'unavailable', available: false, check: { state: 'failed', reason: 'session-header' } });
  // A 3.3 helper's `qualified` claim means the same as `compatible`.
  const legacy = Object.fromEntries(FEATURE_IDS.map(id => [id, { support: 'qualified', available: id === 'http-delivery' }]));
  assert.deepEqual(parseFeatures(legacy, '2.0.29')['http-delivery'], { support: 'compatible', available: true });
  assert.equal(parseFeatures(legacy, '2.1.0'), undefined);
  for (const contradiction of [
    { 'http-delivery': { support: 'unavailable', available: true } },
    { 'http-delivery': { support: 'compatible', available: true, check: { state: 'failed', reason: 'event-shape' } } },
    { 'http-delivery': { support: 'compatible', available: false, check: { state: 'failed' } } },
    { 'http-delivery': { support: 'compatible', available: false, check: { state: 'failed', reason: '/private/path' } } },
    { 'http-delivery': { support: 'compatible', available: true, check: { state: 'passed', reason: 'event-shape' } } },
    { 'http-delivery': { support: 'compatible', available: true, check: 'passed' } },
  ]) assert.equal(parseFeatures({ ...features, ...contradiction }, '2.0.32'), undefined, JSON.stringify(contradiction));
  assert.equal(parseFeatures({}, '2.0.32'), undefined);
});

async function fixture(reject, observerFails = false, { version = '2.0.32', hookAPI = true } = {}) {
  const hooks = [], disposed = [], warnings = []; let features;
  const plugin = makePlugin({ shared: {}, warn: message => warnings.push(message), storeFactory: () => ({ async close() {} }),
    observerFactory: () => ({ async attach(ctx, value) { features = value; if (observerFails) throw new Error('private failure detail'); },
      authorizeHttp() {}, authorizeWebSocket() {}, async report() {}, async close() {} }) });
  const dispose = await plugin.setup({ app: { version }, event: { subscribe() {} },
    session: hookAPI ? { async hook(name, callback, options) {
      const id = options ? `prompt:${name}` : name;
      if (id === reject) throw new Error('private failure detail');
      const entry = { id, callback }; hooks.push(entry);
      return { dispose() { disposed.push(id); hooks.splice(hooks.indexOf(entry), 1); } };
    } } : {} });
  return { hooks, disposed, warnings, dispose, get features() { return features; } };
}

test('an unsupported release line installs no hook and leaves every feature unqualified', async () => {
  const f = await fixture(null, false, { version: '2.2.0' });
  assert.deepEqual(f.hooks, []);
  for (const id of FEATURE_IDS) assert.deepEqual(f.features[id], { support: 'unqualified', available: false });
  await f.dispose();
});

test('a reviewed local build installs the same hooks as its release line', async () => {
  const f = await fixture(null, false, { version: '2.1.1-compaction.1' });
  assert.deepEqual(f.hooks.map(hook => hook.id), ['http.request', 'experimental.ws.handshake', 'prompt:http.request', 'prompt:http.response']);
  assert.deepEqual(f.features['prompt-progress'], { support: 'compatible', available: true, check: { state: 'waiting' } });
  await f.dispose();
});

test('failed prompt response hook removes its request mutation while delivery remains available', async () => {
  const f = await fixture('prompt:http.response');
  assert.deepEqual(f.hooks.map(hook => hook.id), ['http.request', 'experimental.ws.handshake']);
  assert.deepEqual(f.disposed, ['prompt:http.request']);
  assert.deepEqual(f.features['http-delivery'], { support: 'compatible', available: true, check: { state: 'waiting' } });
  assert.equal(f.features['websocket-delivery'].available, true);
  assert.deepEqual(f.features['prompt-progress'], { support: 'unavailable', available: false, check: { state: 'failed', reason: 'hook-rejected' } });
  assert.ok(f.warnings.every(message => !message.includes('private failure detail')));
  await f.dispose();
});

test('a missing hook API is reported as such, separately from a rejected registration', async () => {
  const f = await fixture(null, false, { hookAPI: false });
  for (const id of ['http-delivery', 'websocket-delivery', 'prompt-progress'])
    assert.deepEqual(f.features[id], { support: 'unavailable', available: false, check: { state: 'failed', reason: 'hook-missing' } });
  await f.dispose();
});

test('an event observer failure leaves accepted prompt progress registered', async () => {
  const f = await fixture(null, true);
  assert.deepEqual(f.hooks.map(hook => hook.id), ['prompt:http.request', 'prompt:http.response']);
  assert.equal(f.features['prompt-progress'].available, true);
  assert.equal(f.features['http-delivery'].available, false);
  assert.deepEqual(f.features['websocket-delivery'].check, { state: 'failed', reason: 'events-missing' });
  await f.dispose();
});

test('Splash requests that stop carrying the session header withdraw prompt progress, never a changed request', async () => {
  const f = await fixture(null);
  const request = f.hooks.find(hook => hook.id === 'prompt:http.request').callback;
  const call = headers => ({ kind: 'primary', sessionID: 'ses_private', model: { providerID: 'splish', id: 'model' },
    request: new Request('http://127.0.0.1:8000/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ stream: true, messages: [] }) }) });
  // Other providers and a present header prove nothing against the contract.
  await request({ ...call({}), model: { providerID: 'omlx', id: 'model' } });
  for (let i = 0; i < 2; i++) await request(call({}));
  await request(call({ 'x-opencode-session-id': 'ses_private' }));
  for (let i = 0; i < 2; i++) await request(call({}));
  assert.equal(f.features['prompt-progress'].available, true, 'a matched request resets the count');
  const last = call({}), original = last.request;
  await request(last);
  assert.equal(last.request, original);
  assert.deepEqual(f.features['prompt-progress'], { support: 'compatible', available: false, check: { state: 'failed', reason: 'session-header' } });
  const later = call({ 'x-opencode-session-id': 'ses_private' }), before = later.request;
  await request(later);
  assert.equal(later.request, before, 'a withdrawn feature stays off for this helper load');
  assert.ok(f.warnings.some(message => message.includes('prompt progress paused')));
  await f.dispose();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_PROTOCOL, FEATURE_IDS, acceptsChatProtocol, featureSupport, parseFeatures, profileFor } from './compatibility.js';
import { makePlugin } from './index.js';

test('qualification is exact and independent from wire spelling and package version', () => {
  assert.equal(profileFor('2.0.25').id, 'opencode-2.0.25-v1');
  assert.equal(acceptsChatProtocol('2.0.25', CHAT_PROTOCOL), true);
  for (const version of [undefined, null, '', '2.0.24', '2.0.26', '2.0.25-custom']) {
    assert.equal(profileFor(version), null);
    assert.equal(acceptsChatProtocol(version, CHAT_PROTOCOL), false);
    assert.equal(acceptsChatProtocol(version, undefined), false);
  }
  assert.equal(acceptsChatProtocol('2.0.25', 'future-wire'), false);
  assert.equal(profileFor('2.0.25').websocketCancellation, 'unit-only');
  assert.equal(profileFor('2.0.27').id, 'opencode-2.0.27-v1');
  assert.equal(profileFor('2.0.27').websocketCancellation, 'native');
  assert.equal(acceptsChatProtocol('2.0.27', CHAT_PROTOCOL), true);
  assert.equal(acceptsChatProtocol('2.0.27', 'future-wire'), false);
  for (const version of ['2.0.28', '2.0.27-custom', '2.0.270', '3.0.0']) assert.equal(profileFor(version), null);
});

test('feature status rejects contradictory qualification and strips unrelated metadata', () => {
  const features = featureSupport('2.0.25');
  features['http-delivery'].available = true;
  const parsed = parseFeatures({ ...features, privateContent: 'not retained' }, '2.0.25');
  assert.deepEqual(Object.keys(parsed), FEATURE_IDS);
  assert.deepEqual(parsed['http-delivery'], { support: 'qualified', available: true });
  assert.equal(parseFeatures(features, '2.0.26'), undefined);
  assert.equal(parseFeatures({ ...features, 'http-delivery': { support: 'unavailable', available: true } }, '2.0.25'), undefined);
  assert.equal(parseFeatures({}, '2.0.25'), undefined);
});

async function fixture(reject, observerFails = false) {
  const hooks = [], disposed = [], warnings = []; let features;
  const plugin = makePlugin({ shared: {}, warn: message => warnings.push(message), storeFactory: () => ({ async close() {} }),
    observerFactory: () => ({ async attach(ctx, value) { features = value; if (observerFails) throw new Error('private failure detail'); },
      authorizeHttp() {}, authorizeWebSocket() {}, async close() {} }) });
  const dispose = await plugin.setup({ app: { version: '2.0.25' }, event: { subscribe() {} },
    session: { async hook(name, callback, options) {
      const id = options ? `prompt:${name}` : name;
      if (id === reject) throw new Error('private failure detail');
      const entry = { id, callback }; hooks.push(entry);
      return { dispose() { disposed.push(id); hooks.splice(hooks.indexOf(entry), 1); } };
    } } });
  return { hooks, disposed, warnings, dispose, get features() { return features; } };
}

test('failed prompt response hook removes its request mutation while delivery remains available', async () => {
  const f = await fixture('prompt:http.response');
  assert.deepEqual(f.hooks.map(hook => hook.id), ['http.request', 'experimental.ws.handshake']);
  assert.deepEqual(f.disposed, ['prompt:http.request']);
  assert.equal(f.features['http-delivery'].available, true);
  assert.equal(f.features['websocket-delivery'].available, true);
  assert.deepEqual(f.features['prompt-progress'], { support: 'unavailable', available: false });
  assert.ok(f.warnings.every(message => !message.includes('private failure detail')));
  await f.dispose();
});

test('an event observer failure leaves qualified prompt progress registered', async () => {
  const f = await fixture(null, true);
  assert.deepEqual(f.hooks.map(hook => hook.id), ['prompt:http.request', 'prompt:http.response']);
  assert.equal(f.features['prompt-progress'].available, true);
  assert.equal(f.features['http-delivery'].available, false);
  assert.equal(f.features['websocket-delivery'].available, false);
  await f.dispose();
});

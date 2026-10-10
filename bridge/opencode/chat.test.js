import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { key } from './store.js';
import { createChatTracker, loopbackEndpoint, observedEndpoint, WINDOW_MS } from './chat.js';
import { createChatStore, readPrivateJSON, atomicPrivateJSON } from './chat-store.js';
import { createChatObserver, parseDemand } from './demand.js';
import { makePlugin } from './index.js';
import { execFileSync } from 'node:child_process';

const ident = (session = 'ses_private', model = 'private-model', provider = 'local') => ({
  sessionKey: key('session', session), modelKey: key('model', model), providerKey: key('provider', provider) });
function harness({ remote = false } = {}) {
  let time = 100_000, serial = 0; const saved = new Map();
  const tracker = createChatTracker({ now: () => time, publish: entry => saved.set(entry.sessionKey, entry), remove: k => saved.delete(k) });
  tracker.setWatched([{ ...ident(), ...remote ? { destination: 'remote' } : {} }]);
  const send = (type, data = {}, envelope = {}) => tracker.event({ type: `session.${type}`, id: `evt_${++serial}`, created: time,
    data: { sessionID: 'ses_private', assistantMessageID: 'assistant-private', ...data }, ...envelope });
  const authorize = (overrides = {}) => tracker.authorizeHttp({ sessionID: 'ses_private', model: { providerID: 'local', id: 'private-model' }, kind: 'primary',
    request: new Request(remote ? 'https://cloud.example/v1/chat/completions' : 'http://127.0.0.1:8000/v1/chat/completions', { method: 'POST' }), ...overrides });
  const start = (data = {}) => { authorize(); send('step.started', { started: time, model: { providerID: 'local', id: 'private-model' }, ...data }); };
  const part = (kind = 'text', ordinal = 0) => send(`${kind}.started`, { ordinal });
  const delta = (value = 'a'.repeat(40), kind = 'text', ordinal = 0, envelope) => send(`${kind}.delta`, { ordinal, delta: value }, envelope);
  return { tracker, send, authorize, start, part, delta, saved, get time() { return time; }, advance: n => { time += n; },
    get measurement() { return saved.get(ident().sessionKey)?.measurement; } };
}
function complete(h, { chars = 120, tokens = 30, reasoning = 0, finish = 'stop' } = {}) {
  h.send('text.ended', { ordinal: 0, text: 'a'.repeat(chars) });
  h.advance(100); h.send('step.streamed'); h.send('step.ended', { finish, tokens: { output: tokens, reasoning } });
}

test('released 2.0.25 events estimate delivery only after two seconds and include reasoning', () => {
  const h = harness(); h.start(); h.part(); h.delta(); assert.equal(h.measurement.tokensPerSecond, undefined);
  h.advance(1000); h.delta(); assert.equal(h.measurement.tokensPerSecond, undefined);
  h.part('reasoning', 1); h.advance(1000); h.delta('b'.repeat(40), 'reasoning', 1);
  assert.equal(h.measurement.tokensPerSecond, 10); assert.equal(h.measurement.phase, 'reasoning');
  assert.equal(h.measurement.basis, 'estimated-characters'); assert.equal(h.measurement.timingBasis, 'delivery-window');
  assert.deepEqual(h.measurement.observation, { startedAtMs: 100_000, endedAtMs: 102_000 });
  assert.ok(!JSON.stringify([...h.saved.values()]).match(/ses_private|private-model|assistant-private|aaaaaaaa|bbbbbb/));
});

test('Unicode pairs split between deltas count once, not as UTF16 code units', () => {
  const h = harness(); h.start(); h.part(); h.delta('🙂'.repeat(40));
  h.advance(1000); h.delta('\ud83d'); h.delta('\ude42'.repeat(1) + '🙂'.repeat(39));
  h.advance(1000); h.delta('🙂'.repeat(40)); assert.equal(h.measurement.tokensPerSecond, 10);
});

test('rolling window drops old rates and stays bounded under high frequency deltas', () => {
  const h = harness(); h.start(); h.part();
  for (let i = 0; i < 12_000; i++) { h.delta('a'); h.advance(1); }
  assert.ok(h.tracker.stats().points <= 52);
  assert.ok(h.measurement.tokensPerSecond > 249 && h.measurement.tokensPerSecond < 251);
  assert.equal(h.measurement.observation.endedAtMs - h.measurement.observation.startedAtMs, 5000);
});

test('gaps clear live speed; long prompt wait can still begin a fresh observation', () => {
  const h = harness(); h.start(); h.advance(20_000); h.tracker.tick(); assert.equal(h.measurement, undefined);
  h.part(); h.delta(); h.advance(2000); h.delta(); assert.equal(h.measurement.tokensPerSecond, 5);
  h.advance(WINDOW_MS); h.tracker.tick(); assert.equal(h.measurement, undefined);
  h.delta(); assert.equal(h.measurement.tokensPerSecond, undefined);
  h.advance(2000); h.delta(); assert.equal(h.measurement.tokensPerSecond, 5);
  complete(h, { chars: 160 }); assert.equal(h.measurement.tokensPerSecond, undefined);
});

test('tool activity clears speed and tool text never counts or calibrates', () => {
  const h = harness(); h.start(); h.part(); h.delta(); h.advance(2000); h.delta();
  h.send('tool.input.started', { id: 'call' }); assert.equal(h.measurement.phase, 'tool'); assert.equal(h.measurement.tokensPerSecond, undefined);
  h.send('tool.input.delta', { id: 'call', delta: 'PRIVATE TOOL'.repeat(10_000) });
  h.send('tool.success', { id: 'call', content: [{ text: 'PRIVATE RESULT' }] }); assert.equal(h.measurement.phase, 'waiting');
  complete(h, { chars: 80 }); assert.equal(h.measurement.tokensPerSecond, undefined); assert.equal(h.tracker.stats().calibrationModels, 0);
});

test('three eligible steps calibrate comparable output; only latest ten are retained', () => {
  const h = harness();
  for (let i = 0; i < 13; i++) {
    h.start(); h.part(); h.delta(); h.advance(1000); h.delta(); h.advance(1000); h.delta();
    assert.equal(h.measurement.basis, i < 3 ? 'estimated-characters' : 'calibrated-characters');
    assert.equal(h.measurement.tokensPerSecond, i < 3 ? 10 : 5);
    if (i >= 3) assert.equal(h.measurement.calibrationSteps, Math.min(i, 10));
    complete(h, { tokens: 15 }); assert.equal(h.measurement.basis, 'reported-output');
    assert.equal(h.measurement.freshness, 'last'); assert.ok(Math.abs(h.measurement.tokensPerSecond - 15 / 2.1) < 1e-10);
    h.advance(1000);
  }
});

test('usage with hidden reasoning, missing endings, noninteger counts, or missing streamed boundary is rejected', () => {
  for (const mode of ['hidden', 'noninteger', 'missing-ending', 'missing-streamed', 'bad-finish']) {
    const h = harness(); h.start(); h.part(); h.delta(); h.advance(2000); h.delta();
    if (mode !== 'missing-ending') h.send('text.ended', { ordinal: 0, text: 'a'.repeat(80) });
    if (mode !== 'missing-streamed') h.send('step.streamed');
    h.send('step.ended', { finish: mode === 'bad-finish' ? 'unknown' : 'stop', tokens: { output: mode === 'noninteger' ? 20.5 : 20, reasoning: mode === 'hidden' ? 40 : 0 } });
    assert.equal(h.measurement.tokensPerSecond, undefined, mode); assert.equal(h.tracker.stats().calibrationModels, 0, mode);
  }
});

test('short completed step can report a separately labeled completed-step average without a live estimate', () => {
  const h = harness(); h.start(); h.part(); h.delta(); h.advance(500); complete(h, { chars: 40, tokens: 10 });
  assert.equal(h.measurement.tokensPerSecond, 10 / .6); assert.equal(h.measurement.timingBasis, 'completed-step');
  h.advance(5000); h.tracker.tick(); assert.equal(h.measurement.freshness, 'last');
  h.advance(10_000); h.tracker.tick(); assert.equal(h.measurement, undefined);
});

test('completed-step timing uses producer boundaries despite delayed subscriber delivery', () => {
  const h = harness(); h.start(); h.part(); h.delta(); h.advance(2000); h.delta();
  h.send('text.ended', { ordinal: 0, text: 'a'.repeat(80) });
  const streamedAt = h.time;
  h.advance(3000); h.send('step.streamed', {}, { created: streamedAt });
  h.send('step.ended', { finish: 'stop', tokens: { output: 20, reasoning: 0 } }, { created: streamedAt });
  assert.equal(h.measurement.tokensPerSecond, 10);
  assert.deepEqual(h.measurement.observation, { startedAtMs: 100_000, endedAtMs: streamedAt });
  assert.equal(h.measurement.observedAtMs, h.time);
  assert.equal(h.measurement.timingBasis, 'completed-step');
});

test('cancellation, retry, model switch, unsupported events, and mismatched step clear speed', () => {
  for (const type of ['execution.interrupted', 'step.failed', 'retry.scheduled', 'model.selected', 'text.unknown']) {
    const h = harness(); h.start(); h.part(); h.delta(); h.advance(2000); h.delta(); h.send(type);
    assert.equal(h.measurement?.tokensPerSecond, undefined, type);
    if (type === 'execution.interrupted' || type === 'step.failed') { assert.equal(h.measurement.phase, 'cancelled'); complete(h, { chars: 80 }); assert.equal(h.measurement.phase, 'cancelled'); }
  }
  const h = harness(); h.start(); h.part(); h.delta(); h.send('text.delta', { ordinal: 0, delta: 'oops', assistantMessageID: 'other' }); assert.equal(h.measurement, undefined);
});

test('duplicate events do not inflate live rate; stale and future frames invalidate observation', () => {
  const h = harness(); h.start(); h.part(); h.delta(); h.advance(2000);
  h.delta('a'.repeat(40), 'text', 0, { id: 'evt_same' }); const rate = h.measurement.tokensPerSecond;
  h.delta('a'.repeat(40), 'text', 0, { id: 'evt_same' }); assert.equal(h.measurement.tokensPerSecond, rate);
  h.delta('a', 'text', 0, { created: h.time - 5001 }); assert.equal(h.measurement, undefined);
  h.start(); h.part(); h.delta('a', 'text', 0, { created: h.time + 1 }); assert.equal(h.measurement, undefined);
});

test('only watched primary loopback requests may prove a step; no title, compaction, cloud, alias guesses', () => {
  for (const overrides of [{ kind: 'title' }, { kind: 'compaction' }, { kind: 'generate' },
    { request: new Request('https://example.org/v1/chat/completions', { method: 'POST' }) },
    { request: new Request('http://127.0.0.1:8000/v1/chat/completions?secret=yes', { method: 'POST' }) },
    { sessionID: 'unwatched' }, { model: { providerID: 'other', id: 'private-model' } }]) {
    const h = harness(); h.authorize(overrides); h.send('step.started', { model: { providerID: 'local', id: 'private-model' }, started: h.time }); assert.equal(h.measurement, undefined);
  }
  assert.equal(loopbackEndpoint('http://localhost:8000/v1'), loopbackEndpoint('http://127.0.0.1:8000/v1'));
  assert.equal(loopbackEndpoint('http://localhost.example.org:8000'), null);
  const h = harness(); h.start(); h.tracker.setWatched([]); h.delta(); assert.equal(h.measurement, undefined); assert.equal(h.tracker.stats().routes, 0);
});

test('remote observations require deliberate remote demand and the actual primary HTTP destination', () => {
  const h = harness({ remote: true }); h.start(); h.part(); h.delta(); h.advance(2000); h.part('reasoning', 1); h.delta('b'.repeat(40), 'reasoning', 1);
  assert.equal(h.measurement.tokensPerSecond, 5); assert.equal(h.measurement.phase, 'reasoning');
  assert.equal(h.saved.get(ident().sessionKey).destination, 'remote');
  assert.equal(h.saved.get(ident().sessionKey).endpointKey, key('endpoint', 'https://cloud.example'));
  for (const overrides of [{ kind: 'title' }, { kind: 'compaction' }, { kind: 'generate' },
    { request: new Request('http://127.0.0.1:8000/v1/chat/completions', { method: 'POST' }) },
    { request: new Request('https://cloud.example/v1/chat/completions') }]) {
    const other = harness({ remote: true }); other.authorize(overrides);
    other.send('step.started', { model: { providerID: 'local', id: 'private-model' }, started: other.time });
    assert.equal(other.measurement, undefined);
  }
});

test('primary WebSocket handshakes prove a watched remote step in either public event order', () => {
  for (const first of ['handshake', 'step']) {
    const h = harness({ remote: true });
    const handshake = () => h.tracker.authorizeWebSocket({ sessionID: 'ses_private', model: { providerID: 'local', id: 'private-model' }, kind: 'primary',
      url: 'wss://cloud.example/private?api_key=PRIVATE', headers: { Authorization: 'PRIVATE' } });
    const step = () => h.send('step.started', { started: h.time, model: { providerID: 'local', id: 'private-model' } });
    if (first === 'handshake') { handshake(); step(); } else { step(); handshake(); }
    h.part(); h.delta(); h.advance(2000); h.delta();
    assert.equal(h.measurement.tokensPerSecond, 5, first);
    assert.equal(h.saved.get(ident().sessionKey).endpointKey, key('endpoint', 'wss://cloud.example'));
    assert.equal(h.saved.get(ident().sessionKey).destination, 'remote');
    assert.ok(!JSON.stringify([...h.saved.values()]).match(/PRIVATE|cloud\.example|api_key|private-model/));
  }
});

test('WebSocket proof rejects auxiliary, unwatched, unsafe, non-WebSocket, or mismatched destinations', () => {
  for (const change of [{ kind: 'title' }, { kind: 'compaction' }, { kind: 'generate' }, { sessionID: 'other' },
    { model: { providerID: 'other', id: 'private-model' } }, { url: 'https://cloud.example/v1' },
    { url: 'wss://user:PRIVATE@cloud.example/v1' }, { url: 'wss://cloud.example/v1#PRIVATE' }, { url: 'ws://127.0.0.1:8000/v1' }]) {
    const h = harness({ remote: true });
    h.tracker.authorizeWebSocket({ sessionID: 'ses_private', model: { providerID: 'local', id: 'private-model' }, kind: 'primary', url: 'wss://cloud.example/v1', ...change });
    h.send('step.started', { started: h.time, model: { providerID: 'local', id: 'private-model' } });
    h.part(); h.delta(); h.advance(2000); h.delta();
    assert.equal(h.measurement, undefined, JSON.stringify(change));
  }
});

test('harmless released metadata events preserve a pending step without publishing or retaining their content', () => {
  const h = harness({ remote: true });
  h.send('step.started', { started: h.time, model: { providerID: 'local', id: 'private-model' } });
  for (const type of ['renamed', 'metadata.updated', 'permissions', 'viewed', 'usage.updated']) {
    h.send(type, { title: 'PRIVATE TITLE', metadata: { private: 'PRIVATE CONTENT' } });
    assert.equal(h.measurement, undefined); assert.equal(h.tracker.stats().chats, 1, type);
  }
  h.authorize(); h.part(); h.delta(); h.advance(2000); h.delta();
  assert.equal(h.measurement.tokensPerSecond, 5);
  assert.ok(!JSON.stringify([...h.saved.values()]).includes('PRIVATE'));
});

test('pending proof cannot cross lifecycle boundaries or reconstruct unobserved output', () => {
  for (const type of ['model.selected', 'execution.started', 'execution.interrupted', 'execution.failed', 'execution.succeeded',
    'step.failed', 'step.streamed', 'step.ended', 'text.started', 'reasoning.started', 'tool.input.started']) {
    const h = harness({ remote: true });
    h.send('step.started', { started: h.time, model: { providerID: 'local', id: 'private-model' } });
    h.send(type, { ordinal: 0 }); assert.equal(h.tracker.stats().chats, 0, type);
    const before = h.time; h.advance(100); h.authorize();
    // The later dispatch observes only its own call: output published before it is never attributed to it.
    h.delta('a'.repeat(400), 'text', 0, { created: before });
    assert.equal(h.measurement.phase, 'waiting', type); assert.equal(h.measurement.tokensPerSecond, undefined, type);
    h.part(); h.delta(); h.advance(2000); h.delta();
    assert.equal(h.measurement.tokensPerSecond, 5, type);
  }
});

test('a dispatch proves its own call when step.started is lost in a subscription restart', () => {
  const h = harness({ remote: true }); h.authorize();
  // Never dark: the qualified dispatch is visible before any output.
  assert.equal(h.measurement.phase, 'waiting'); assert.equal(h.measurement.tokensPerSecond, undefined);
  h.part(); h.delta(); h.advance(2000); h.delta();
  assert.equal(h.measurement.tokensPerSecond, 5); assert.equal(h.measurement.timingBasis, 'delivery-window');
  assert.equal(h.saved.get(ident().sessionKey).destination, 'remote');
  assert.equal(h.tracker.stats().routes, 0, 'the bound dispatch cannot prove a later step');
  // Without the step boundary there is no completed-step average and nothing calibrates.
  complete(h, { tokens: 20 });
  assert.equal(h.measurement.phase, 'complete'); assert.equal(h.measurement.tokensPerSecond, undefined);
  assert.equal(h.tracker.stats().calibrationModels, 0);
  // A later step announced without its own observed dispatch stays unproven.
  h.advance(1000); h.send('step.started', { started: h.time, assistantMessageID: 'next-reply', model: { providerID: 'local', id: 'private-model' } });
  h.send('text.started', { ordinal: 0, assistantMessageID: 'next-reply' });
  h.delta(); assert.equal(h.measurement, undefined); assert.equal(h.tracker.stats().chats, 0);
});

test('step.started after the dispatch upgrades the seeded state to a full step', () => {
  const h = harness(); h.authorize(); assert.equal(h.measurement.phase, 'waiting');
  h.send('step.started', { started: h.time, model: { providerID: 'local', id: 'private-model' } });
  h.part(); h.delta(); h.advance(2000); h.delta(); assert.equal(h.measurement.tokensPerSecond, 5);
  complete(h, { chars: 80, tokens: 20 });
  assert.equal(h.measurement.basis, 'reported-output'); assert.equal(h.measurement.tokensPerSecond, 20 / 2.1);
  assert.equal(h.tracker.stats().calibrationModels, 1);
});

test('a seeded state binds to one reply and ignores lifecycle events published before its dispatch', () => {
  const h = harness({ remote: true }), earlier = h.time; h.advance(500); h.authorize();
  h.send('execution.interrupted', {}, { created: earlier }); h.send('step.ended', { finish: 'stop', tokens: { output: 9, reasoning: 0 } }, { created: earlier });
  assert.equal(h.measurement.phase, 'waiting');
  h.part(); h.delta(); h.advance(2000); h.delta(); assert.equal(h.measurement.tokensPerSecond, 5);
  h.send('text.delta', { ordinal: 0, delta: 'x', assistantMessageID: 'another-reply' });
  assert.equal(h.measurement, undefined, 'a second reply cannot extend the bound observation');
});

test('a dispatch during a live step keeps that step, its tail and its calibration', () => {
  const h = harness(); h.start(); h.part(); h.delta(); h.advance(1000); h.delta();
  h.authorize(); h.advance(1000); h.delta(); assert.equal(h.measurement.tokensPerSecond, 10);
  complete(h, { chars: 120, tokens: 30 }); assert.equal(h.measurement.basis, 'reported-output');
  assert.equal(h.tracker.stats().calibrationModels, 1);
  // The settled step yields to the next observed dispatch.
  h.advance(100); h.authorize(); assert.equal(h.measurement.phase, 'waiting'); assert.equal(h.measurement.basis, 'estimated-characters');
});

test('a lifecycle boundary before step announcement invalidates unused HTTP or WebSocket proof', () => {
  for (const transport of ['http', 'websocket']) for (const type of ['execution.interrupted', 'execution.failed', 'execution.succeeded',
    'execution.started', 'retry.scheduled', 'model.selected', 'agent.selected', 'deleted', 'moved', 'compaction.started',
    'revert.committed', 'step.failed', 'step.ended', 'step.streamed']) {
    const h = harness({ remote: true });
    if (transport === 'http') h.authorize();
    else h.tracker.authorizeWebSocket({ sessionID: 'ses_private', model: { providerID: 'local', id: 'private-model' }, kind: 'primary', url: 'wss://cloud.example/v1' });
    assert.equal(h.tracker.stats().routes, 1);
    h.send(type); assert.equal(h.tracker.stats().routes, 0, `${transport}: ${type}`);
    h.send('step.started', { started: h.time, model: { providerID: 'local', id: 'private-model' } });
    h.part(); h.delta(); h.advance(2000); h.delta();
    assert.equal(h.measurement, undefined, `${transport}: ${type}`);
  }
});

test('an older delivered boundary does not discard newer dispatch proof', () => {
  const h = harness({ remote: true }), previous = h.time;
  h.advance(1000); h.authorize(); h.send('execution.interrupted', {}, { created: previous });
  assert.equal(h.tracker.stats().routes, 1);
  h.send('step.started', { started: h.time, model: { providerID: 'local', id: 'private-model' } });
  h.part(); h.delta(); h.advance(2000); h.delta();
  assert.equal(h.measurement.tokensPerSecond, 5);
});

test('remote endpoint classification never retains URL paths, query credentials, or headers', () => {
  const remote = observedEndpoint('https://cloud.example/custom/private-path?api_key=PRIVATE');
  assert.deepEqual(remote, { destination: 'remote', endpointKey: key('endpoint', 'https://cloud.example') });
  assert.deepEqual(observedEndpoint('https://cloud.example/v1/chat/completions?api-version=2'), remote);
  assert.ok(!JSON.stringify(remote).match(/PRIVATE|api_key|private-path|cloud\.example/));
  for (const url of ['file:///private', 'https://user:password@cloud.example/v1', 'https://cloud.example/v1#private',
    'http://127.0.0.1:8000/v1?secret=yes']) assert.equal(observedEndpoint(url), null);
  assert.deepEqual(observedEndpoint('http://localhost:8000/v1'), { endpointKey: loopbackEndpoint('http://127.0.0.1:8000/v1') });
});

test('remote calibration stays endpoint-specific and destination changes reset live observations', () => {
  const h = harness({ remote: true });
  for (let i = 0; i < 3; i++) {
    h.start(); h.part(); h.delta(); h.advance(1000); h.delta(); h.advance(1000); h.delta(); complete(h, { tokens: 15 }); h.advance(1000);
  }
  h.start(); h.part(); h.delta(); h.advance(2000); h.delta(); assert.equal(h.measurement.basis, 'calibrated-characters');
  h.authorize({ request: new Request('https://other.example/v1/chat/completions', { method: 'POST' }) });
  assert.equal(h.measurement.tokensPerSecond, undefined); assert.equal(h.measurement.phase, 'waiting');
  assert.equal(h.saved.get(ident().sessionKey).endpointKey, key('endpoint', 'https://other.example'));
  h.send('step.started', { started: h.time, model: { providerID: 'local', id: 'private-model' } });
  h.part(); h.delta(); h.advance(2000); h.delta(); assert.equal(h.measurement.basis, 'estimated-characters');
  assert.equal(h.saved.get(ident().sessionKey).endpointKey, key('endpoint', 'https://other.example'));
  h.send('execution.interrupted'); assert.equal(h.measurement.phase, 'cancelled'); assert.equal(h.measurement.tokensPerSecond, undefined);
  h.tracker.setWatched([ident()]); assert.equal(h.measurement, undefined);
});

test('simultaneous local and remote chats retain their own destination proof and clear on hidden demand', () => {
  const h = harness(), remote = { ...ident('second'), destination: 'remote' };
  h.tracker.setWatched([ident(), remote]); h.start();
  h.authorize({ sessionID: 'second', request: new Request('https://cloud.example/v1/chat/completions', { method: 'POST' }) });
  h.send('step.started', { sessionID: 'second', started: h.time, model: { providerID: 'local', id: 'private-model' } });
  assert.equal(h.saved.size, 2);
  assert.equal(h.saved.get(ident().sessionKey).destination, undefined);
  assert.equal(h.saved.get(remote.sessionKey).destination, 'remote');
  h.tracker.setWatched([]); assert.equal(h.saved.size, 0); assert.equal(h.tracker.stats().routes, 0);
  h.delta(); assert.equal(h.saved.size, 0);
});

test('simultaneous selected chats retain independent observations and switching removes old data', () => {
  const h = harness(); h.tracker.setWatched([ident(), ident('second')]); h.start(); h.part(); h.delta();
  h.authorize({ sessionID: 'second' }); h.send('step.started', { sessionID: 'second', started: h.time, model: { providerID: 'local', id: 'private-model' } });
  assert.equal(h.saved.size, 2); h.tracker.setWatched([ident('second')]); assert.equal(h.saved.size, 1);
  h.tracker.clear(); assert.equal(h.saved.size, 0); h.authorize(); assert.equal(h.tracker.stats().routes, 0);
});

const demand = (now, watched = [ident()]) => ({ schemaVersion: 1, updatedAtMs: now, expiresAtMs: now + 15_000, watched });
test('private demand requires bounded matching identifiers and a short valid lease', () => {
  assert.deepEqual(parseDemand(demand(10), 10), [ident()]);
  for (const invalid of [{ ...demand(10), expiresAtMs: 30_010 }, { ...demand(10), watched: [ident(), { sessionKey: 'raw' }] },
    { ...demand(10), watched: Array(17).fill(ident()) }, { ...demand(10), schemaVersion: 2 }, demand(11)]) assert.deepEqual(parseDemand(invalid, 10), []);
  assert.deepEqual(parseDemand(demand(10), 15_010), []);
  const remote = { ...ident(), destination: 'remote' };
  assert.deepEqual(parseDemand(demand(10, [ident(), remote, remote]), 10), [ident(), remote]);
  assert.deepEqual(parseDemand(demand(10, [{ ...ident(), destination: 'unknown' }]), 10), []);
});

test('chat transport is private, bounded, metadata only, and symlink/oversize reads fail closed', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'scope-chat-'))); const h = harness(); h.start();
  const store = createChatStore({ directory, now: () => h.time, intervalMs: 0, runtimeVersion: '2.0.25' });
  try {
    store.update({ ...h.saved.values().next().value, text: 'PRIVATE', sessionID: 'secret' }); await store.flush();
    const raw = await readFile(store.file, 'utf8'); assert.ok(!raw.match(/PRIVATE|secret|ses_private/));
    const doc = JSON.parse(raw); assert.equal(doc.entries.length, 1); assert.equal(doc.protocol, 'opencode-2.0.25');
    assert.equal((await stat(directory)).mode & 0o777, 0o700); assert.equal((await stat(store.file)).mode & 0o777, 0o600);
    await symlink(store.file, join(directory, 'demand.json')); await assert.rejects(readPrivateJSON(directory, 'demand.json'));
    await rm(join(directory, 'demand.json')); await writeFile(join(directory, 'demand.json'), 'x'.repeat(17_000), { mode: 0o600 });
    assert.equal(await readPrivateJSON(directory, 'demand.json'), null);
    await chmod(join(directory, 'demand.json'), 0o644); assert.equal(await readPrivateJSON(directory, 'demand.json'), null);
    h.advance(5000); store.remove(ident().sessionKey); await store.flush(); assert.ok(!(await readdir(directory)).includes(`${store.writerID}.json`));
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('remote transport publishes only hashes, classification and measurement metadata', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'scope-remote-chat-'))), h = harness({ remote: true }); h.start();
  const store = createChatStore({ directory, now: () => h.time, intervalMs: 0, runtimeVersion: '2.0.25' });
  try {
    store.update({ ...h.saved.values().next().value, url: 'https://cloud.example/v1?api_key=PRIVATE', headers: { authorization: 'PRIVATE' }, content: 'PRIVATE' });
    await store.flush();
    const raw = await readFile(store.file, 'utf8'), entry = JSON.parse(raw).entries[0];
    assert.equal(entry.destination, 'remote'); assert.equal(entry.endpointKey, key('endpoint', 'https://cloud.example'));
    assert.ok(!raw.match(/PRIVATE|cloud\.example|api_key|authorization|ses_private|private-model/));
    h.tracker.setWatched([]); store.remove(ident().sessionKey); await store.flush();
    assert.ok(!(await readdir(directory)).includes(`${store.writerID}.json`));
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('observer shares one subscription, aborts hidden work, handles reconnect and rejects unqualified versions', async () => {
  let now = 100_000, wanted = [], subscriptions = 0, aborts = 0, writes = 0;
  const heartbeats = [], makeContext = version => ({ app: { version }, event: { subscribe({ signal }) {
    subscriptions++;
    return { async *[Symbol.asyncIterator]() { await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => { aborts++; resolve(); }, { once: true }); }); } };
  } } });
  const memory = () => ({ update() { writes++; }, remove() {}, async flush() {}, async close() {} });
  const observer = createChatObserver({ now: () => now, intervalMs: 100_000, storeFactory: memory,
    readDemand: async () => demand(now, wanted), heartbeat: async value => heartbeats.push(value) });
  const ctx = makeContext('2.0.25'), other = makeContext('2.0.25');
  try {
    const detach = await observer.attach(ctx); await observer.attach(other); assert.equal(subscriptions, 0); assert.equal(heartbeats.length, 1);
    wanted = [ident()]; await observer.tick(); assert.equal(subscriptions, 1); assert.equal(heartbeats.length, 2);
    await observer.tick(); assert.equal(subscriptions, 1); detach(); await observer.tick(); assert.equal(subscriptions, 2);
    wanted = []; await observer.tick(); assert.equal(aborts, 2); assert.equal(writes, 0);
  } finally { await observer.close(); }
  const unknown = createChatObserver({ now: () => now, intervalMs: 100_000, storeFactory: memory,
    readDemand: async () => demand(now), heartbeat: async value => heartbeats.push(value) });
  await unknown.attach(makeContext('2.0.26')); assert.equal(subscriptions, 2); assert.equal(heartbeats.at(-1).supported, false); await unknown.close();
});

test('a demand file refused by the private-mode gate is reported once, unlike absent demand', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'scope-demand-'))), warnings = [];
  let now = Date.now(), subscriptions = 0;
  const ctx = { app: { version: '2.0.25' }, event: { subscribe({ signal }) {
    subscriptions++;
    return { async *[Symbol.asyncIterator]() { await new Promise(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true })); } };
  } } };
  const observer = createChatObserver({ directory, now: () => now, intervalMs: 100_000, warn: message => warnings.push(message),
    storeFactory: () => ({ update() {}, remove() {}, async flush() {}, async close() {} }), heartbeat: async () => {} });
  try {
    await observer.attach(ctx); await observer.tick();
    assert.deepEqual(warnings, [], 'no demand file is the normal idle state');
    const file = join(directory, 'demand.json');
    await writeFile(file, JSON.stringify(demand(now))); await chmod(file, 0o644);
    await observer.tick(); await observer.tick();
    assert.equal(subscriptions, 0); assert.equal(warnings.length, 1);
    assert.match(warnings[0], /not private to this account/);
    assert.ok(!warnings[0].includes(directory) && !warnings[0].includes(ident().sessionKey));
    await chmod(file, 0o600); await observer.tick();
    assert.equal(subscriptions, 1); assert.equal(warnings.length, 1);
  } finally { await observer.close(); await rm(directory, { recursive: true, force: true }); }
});

test('promptProgress false leaves chat observer available without installing Splash hooks', async () => {
  const hooks = [], attached = []; let closes = 0;
  const shared = {}, store = { async close() {} };
  const plugin = makePlugin({ shared, storeFactory: () => store, observerFactory: () => ({ attach: async ctx => { attached.push(ctx); return () => {}; }, authorizeHttp() {}, authorizeWebSocket() {}, async close() { closes++; } }) });
  const context = { options: { promptProgress: false }, app: { version: '2.0.25' }, event: { subscribe() {} }, session: { async hook(name, fn, filter) { hooks.push({ name, filter }); } } };
  const dispose = await plugin.setup(context); assert.equal(attached.length, 1); assert.deepEqual(hooks, [
    { name: 'http.request', filter: undefined }, { name: 'experimental.ws.handshake', filter: undefined }]);
  await dispose(); assert.equal(closes, 1);
});


test('unsafe ancestors cannot create child directories and FIFO demand reads never block', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'scope-chat-safe-')));
  try {
    await symlink(base, join(base, 'linked'));
    await assert.rejects(atomicPrivateJSON(join(base, 'linked', 'new-child'), 'file.json', {}));
    assert.ok(!(await readdir(base)).includes('new-child'));
    await chmod(base, 0o700);
    execFileSync('mkfifo', [join(base, 'demand.json')]); await chmod(join(base, 'demand.json'), 0o600);
    const started = performance.now(); assert.equal(await readPrivateJSON(base, 'demand.json'), null);
    assert.ok(performance.now() - started < 1000);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('step announcement before HTTP dispatch still requires later primary local proof', () => {
  const h = harness();
  h.send('step.started', { started: h.time, model: { providerID: 'local', id: 'private-model' } });
  assert.equal(h.measurement, undefined); h.authorize(); assert.equal(h.measurement.phase, 'waiting');
  h.part(); h.delta(); h.advance(2000); h.delta(); assert.equal(h.measurement.tokensPerSecond, 5);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { makePlugin } from './index.js';
import { createChatObserver } from './demand.js';
import { key } from './store.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
function source() {
  let subscriptions = 0, aborts = 0;
  const listeners = new Set();
  return {
    push(event) { for (const receive of listeners) receive(event); },
    subscribe({ signal }) {
      subscriptions++;
      return { async *[Symbol.asyncIterator]() {
        const queue = []; let wake;
        const receive = event => { queue.push(event); wake?.(); wake = undefined; };
        const abort = () => { aborts++; wake?.(); wake = undefined; };
        listeners.add(receive); signal.addEventListener('abort', abort, { once: true });
        try { while (!signal.aborted) { if (!queue.length) await new Promise(resolve => { wake = resolve; });
          while (queue.length && !signal.aborted) yield queue.shift();
        } } finally { listeners.delete(receive); signal.removeEventListener('abort', abort); }
      } };
    },
    stats: () => ({ subscriptions, aborts, active: listeners.size }),
  };
}
async function harness() {
  let time = 100_000, serial = 0, wanted = [], reads = 0; const saved = new Map(), disposals = [], contexts = [];
  const observer = createChatObserver({ now: () => time, intervalMs: 100_000,
    heartbeat: async () => {}, readDemand: async () => { reads++; return {
      schemaVersion: 1, updatedAtMs: time, expiresAtMs: time + 15_000, watched: wanted }; },
    storeFactory: () => ({ update(entry) { saved.set(entry.sessionKey, entry); }, remove(session) { saved.delete(session); }, async flush() {}, async close() {} }) });
  const plugin = makePlugin({ shared: {}, observerFactory: () => observer, storeFactory: () => ({ async close() {} }) });
  async function context(directory = '/fixture/project-a', version = '2.0.25') {
    const events = source(), hooks = new Map();
    const ctx = { app: { version }, location: { directory }, options: { promptProgress: false }, event: events,
      session: { async hook(name, fn) { hooks.set(name, fn); return { dispose() { hooks.delete(name); } }; } } };
    const dispose = await plugin.setup(ctx); disposals.push(dispose);
    const item = { ctx, events, hooks, dispose }; contexts.push(item); return item;
  }
  const identity = (session = 'session-a', remote = true) => ({ sessionKey: key('session', session), providerKey: key('provider', 'openai'),
    modelKey: key('model', 'gpt-6.1-sol'), ...remote ? { destination: 'remote' } : {} });
  const envelope = (type, session = 'session-a', data = {}, assistant = 'assistant-a') => ({
    id: `evt-${++serial}`, type: `session.${type}`, created: time,
    data: { sessionID: session, assistantMessageID: assistant, ...data } });
  async function send(ctx, type, session, data, assistant) { ctx.events.push(envelope(type, session, data, assistant)); await settle(); }
  async function start(ctx, session = 'session-a', assistant = 'assistant-a') {
    await send(ctx, 'step.started', session, { started: time, model: { providerID: 'openai', id: 'gpt-6.1-sol' } }, assistant);
  }
  async function stream(ctx, session = 'session-a', assistant = 'assistant-a') {
    await start(ctx, session, assistant);
    await send(ctx, 'text.started', session, { ordinal: 0 }, assistant);
    await send(ctx, 'text.delta', session, { ordinal: 0, delta: 'x'.repeat(40) }, assistant);
    time += 2_100;
    await send(ctx, 'text.delta', session, { ordinal: 0, delta: 'x'.repeat(40) }, assistant);
  }
  function handshake(session = 'session-a', overrides = {}) {
    return { sessionID: session, model: { providerID: 'openai', id: 'gpt-6.1-sol' }, kind: 'primary',
      url: 'wss://cloud.example/private?api_key=PRIVATE', ...overrides };
  }
  return { context, observer, saved, identity, send, start, stream, handshake,
    watch(items) { wanted = items; }, get reads() { return reads; }, advance(ms) { time += ms; },
    async close() { for (const dispose of disposals) if (contexts[disposals.indexOf(dispose)].hooks.size) await dispose(); } };
}

test('qualified WS hook refreshes newly visible demand before first dispatch; never touches frames or headers', async () => {
  const h = await harness();
  try {
    const ctx = await h.context(); h.watch([h.identity()]);
    assert.deepEqual([...ctx.hooks.keys()], ['http.request', 'experimental.ws.handshake']);
    assert.equal(ctx.events.stats().subscriptions, 0);
    const event = h.handshake();
    Object.defineProperty(event, 'headers', { get() { throw new Error('headers must remain unread'); } });
    Object.defineProperty(event, 'frame', { get() { throw new Error('frames must remain unread'); } });
    Object.freeze(event);
    await ctx.hooks.get('experimental.ws.handshake')(event);
    assert.equal(ctx.events.stats().subscriptions, 1);
    await h.stream(ctx);
    const entry = h.saved.get(h.identity().sessionKey);
    assert.ok(entry.measurement.tokensPerSecond > 0); assert.equal(entry.destination, 'remote');
    assert.equal(entry.endpointKey, key('endpoint', 'wss://cloud.example'));
    assert.ok(!JSON.stringify([...h.saved.values()]).match(/PRIVATE|cloud\.example|session-a|gpt-6.1-sol|xxxxx/));
  } finally { await h.close(); }
});

test('HTTP first dispatch also refreshes demand; aborted primary requests never authorize', async () => {
  for (const aborted of [false, true]) {
    const h = await harness();
    try {
      const ctx = await h.context(); h.watch([h.identity()]);
      const controller = new AbortController(); if (aborted) controller.abort();
      await ctx.hooks.get('http.request')({ ...h.handshake(), request: new Request('https://cloud.example/v1/responses', { method: 'POST', signal: controller.signal }) });
      await h.stream(ctx);
      assert.equal(Boolean(h.saved.get(h.identity().sessionKey)?.measurement.tokensPerSecond), !aborted);
    } finally { await h.close(); }
  }
});

test('auxiliary and unqualified hooks do not start observations or read demand at dispatch', async () => {
  for (const kind of ['title', 'compaction', 'generate', 'control', undefined]) {
    const h = await harness();
    try {
      const ctx = await h.context(); h.watch([h.identity()]); const before = h.reads;
      await ctx.hooks.get('experimental.ws.handshake')(h.handshake('session-a', { kind }));
      assert.equal(h.reads, before); await h.stream(ctx); assert.equal(h.saved.size, 0);
    } finally { await h.close(); }
  }
  const h = await harness();
  try { const ctx = await h.context('/fixture/unsupported', '2.0.26');
    assert.ok(!ctx.hooks.has('experimental.ws.handshake')); h.watch([h.identity()]); await h.observer.tick();
    assert.equal(ctx.events.stats().subscriptions, 0);
  } finally { await h.close(); }
});

test('each dispatch on a cached/reused socket needs fresh proof and interruption clears speed', async () => {
  const h = await harness();
  try {
    const ctx = await h.context(); h.watch([h.identity()]); const hook = ctx.hooks.get('experimental.ws.handshake');
    await hook(h.handshake()); await h.stream(ctx); assert.ok(h.saved.get(h.identity().sessionKey).measurement.tokensPerSecond > 0);
    await h.send(ctx, 'execution.interrupted'); assert.equal(h.saved.get(h.identity().sessionKey).measurement.tokensPerSecond, undefined);
    await h.stream(ctx, 'session-a', 'assistant-unproven'); assert.equal(h.saved.size, 0, 'previous handshake does not prove another step');
    await hook(h.handshake()); await h.stream(ctx, 'session-a', 'assistant-reused');
    assert.ok(h.saved.get(h.identity().sessionKey).measurement.tokensPerSecond > 0);
    assert.equal(ctx.events.stats().subscriptions, 1, 'reuse needs no duplicate event subscription');
  } finally { await h.close(); }
});

test('loopback and cloud WS dispatch must match explicit destination demand', async () => {
  for (const remote of [false, true]) for (const url of ['ws://localhost:7777/v1/responses', 'wss://cloud.example/v1/responses']) {
    const h = await harness();
    try {
      const ctx = await h.context(); h.watch([h.identity('session-a', remote)]);
      await ctx.hooks.get('experimental.ws.handshake')(h.handshake('session-a', { url })); await h.stream(ctx);
      assert.equal(h.saved.size > 0, remote === url.startsWith('wss:'));
    } finally { await h.close(); }
  }
});

test('location-scoped subscriptions share duplicates and keep simultaneous projects isolated', async () => {
  const h = await harness();
  try {
    const a = await h.context(), duplicate = await h.context(), b = await h.context('/fixture/project-b');
    h.watch([h.identity(), h.identity('session-b')]);
    await a.hooks.get('experimental.ws.handshake')(h.handshake());
    await b.hooks.get('experimental.ws.handshake')(h.handshake('session-b'));
    assert.equal(a.events.stats().subscriptions, 1); assert.equal(duplicate.events.stats().subscriptions, 0); assert.equal(b.events.stats().subscriptions, 1);
    await h.stream(a); await h.stream(b, 'session-b'); assert.equal(h.saved.size, 2);
    await a.dispose(); await settle(); await h.observer.tick();
    assert.equal(duplicate.events.stats().subscriptions, 1); assert.ok(h.saved.has(h.identity('session-b').sessionKey), 'one location reconnect preserves the other');
    h.watch([]); await h.observer.tick(); await settle();
    assert.equal(h.saved.size, 0); assert.equal(b.events.stats().active, 0); assert.equal(duplicate.events.stats().active, 0);
    await h.stream(b, 'session-b'); assert.equal(h.saved.size, 0, 'hidden events stay unobserved');
  } finally { await h.close(); }
});

test('a new companion generation never reuses an older live observer holder', async () => {
  let attached = 0, closed = 0, oldTouched = 0;
  const old = { refs: 2, chat: { attach() { oldTouched++; throw new Error('old observer reused'); } }, store: {} };
  const shared = { [Symbol.for('mlx-scope.prompt-progress.v1')]: old };
  const plugin = makePlugin({ shared, storeFactory: () => ({ async close() {} }),
    observerFactory: () => ({ async attach() { attached++; return () => {}; }, async close() { closed++; } }) });
  const context = directory => ({ app: { version: '2.0.25' }, location: { directory }, options: { promptProgress: false },
    event: { subscribe() {} }, session: { async hook() { return { dispose() {} }; } } });
  const a = await plugin.setup(context('/a')), b = await plugin.setup(context('/b'));
  assert.equal(attached, 2); assert.equal(oldTouched, 0); assert.equal(old.refs, 2);
  await a(); assert.equal(closed, 0); await b(); assert.equal(closed, 1);
  assert.equal(shared[Symbol.for('mlx-scope.prompt-progress.v1')], old, 'old generation cleanup remains its own responsibility');
});

test('managed revisions isolate observers even when the package version is unchanged', async () => {
  const shared = {}; let observers = 0, closed = 0;
  const plugin = makePlugin({ shared, storeFactory: () => ({ async close() {} }),
    observerFactory: () => { observers++; return { async attach() { return () => {}; }, async close() { closed++; } }; } });
  const context = revision => ({ app: { version: '2.0.25' }, location: { directory: '/fixture' },
    options: { promptProgress: false, scopeRevision: revision }, event: { subscribe() {} },
    session: { async hook() { return { dispose() {} }; } } });
  const first = await plugin.setup(context('a'.repeat(64)));
  const same = await plugin.setup(context('a'.repeat(64)));
  const replacement = await plugin.setup(context('b'.repeat(64)));
  assert.equal(observers, 2);
  await first(); assert.equal(closed, 0);
  await same(); assert.equal(closed, 1);
  await replacement(); assert.equal(closed, 2);
});

test('aborted dispatch before step output cannot lend socket proof to a later step', async () => {
  const h = await harness();
  try {
    const ctx = await h.context(); h.watch([h.identity()]);
    await ctx.hooks.get('experimental.ws.handshake')(h.handshake());
    await h.send(ctx, 'execution.interrupted');
    await h.stream(ctx, 'session-a', 'assistant-without-dispatch');
    assert.equal(h.saved.size, 0);
  } finally { await h.close(); }
});

test('many loaded projects keep a bounded subscription set and prioritize a dispatching location', async () => {
  const h = await harness();
  try {
    const contexts = [];
    for (let i = 0; i < 17; i++) contexts.push(await h.context(`/fixture/project-${i}`));
    h.watch([h.identity()]); await h.observer.tick();
    assert.equal(contexts.reduce((n, ctx) => n + ctx.events.stats().active, 0), 16);
    const recent = contexts.at(-1); assert.equal(recent.events.stats().active, 0);
    await recent.hooks.get('experimental.ws.handshake')(h.handshake()); await settle(); await h.stream(recent);
    assert.ok(h.saved.get(h.identity().sessionKey).measurement.tokensPerSecond > 0);
    assert.equal(contexts.reduce((n, ctx) => n + ctx.events.stats().active, 0), 16);
    h.watch([]); await h.observer.tick(); await settle();
    assert.equal(contexts.reduce((n, ctx) => n + ctx.events.stats().active, 0), 0);
  } finally { await h.close(); }
});

test('setup registration rejection rolls back the observer and every prior hook; teardown is idempotent', async () => {
  for (const reject of ['http.request', 'experimental.ws.handshake', 'none']) {
    const shared = {}, counts = { attach: 0, detach: 0, dispose: 0, observerClose: 0, storeClose: 0 };
    const plugin = makePlugin({ shared, storeFactory: () => ({ async close() { counts.storeClose++; } }),
      observerFactory: () => ({ async attach() { counts.attach++; return () => { counts.detach++; }; }, async close() { counts.observerClose++; } }) });
    const ctx = { app: { version: '2.0.25' }, location: { directory: '/fixture' }, options: { promptProgress: false },
      event: { subscribe() {} }, session: { async hook(name) {
        if (name === reject) throw new Error('fixture registration rejection');
        return { dispose() { counts.dispose++; throw new Error('fixture disposer failure'); } };
      } } };
    if (reject === 'none') { const dispose = await plugin.setup(ctx); await dispose(); await dispose(); }
    else await assert.rejects(plugin.setup(ctx), /fixture registration rejection/);
    assert.deepEqual(counts, { attach: 1, detach: 1, dispose: reject === 'none' ? 2 : reject === 'http.request' ? 0 : 1, observerClose: 1, storeClose: 1 });
    assert.equal(Object.getOwnPropertySymbols(shared).length, 0, 'no leaked holder reference');
  }
});

test('an observed cloud dispatch reports request start before any output, then observed stream timing', async () => {
  const h = await harness();
  try {
    const ctx = await h.context(); h.watch([h.identity()]);
    await ctx.hooks.get('experimental.ws.handshake')(h.handshake());
    await h.start(ctx);
    const entry = h.saved.get(h.identity().sessionKey);
    assert.ok(entry, 'the observed dispatch publishes its own step');
    assert.equal(entry.destination, 'remote');
    const waiting = entry.measurement;
    assert.equal(waiting.scope, 'chat'); assert.equal(waiting.phase, 'waiting');
    assert.equal(waiting.timingBasis, 'delivery-window'); assert.equal(waiting.freshness, 'live');
    assert.equal(waiting.tokensPerSecond, undefined, 'request start carries no speed');
    // One dispatch proves one step: the next step needs its own handshake proof.
    await ctx.hooks.get('experimental.ws.handshake')(h.handshake());
    await h.stream(ctx, 'session-a', 'assistant-b');
    const live = h.saved.get(h.identity().sessionKey).measurement;
    assert.equal(live.phase, 'generating'); assert.ok(live.tokensPerSecond > 0);
  } finally { await h.close(); }
});

test('cancelling a running cloud step removes live delivery speed immediately', async () => {
  const h = await harness();
  try {
    const ctx = await h.context(); h.watch([h.identity()]);
    await ctx.hooks.get('experimental.ws.handshake')(h.handshake());
    await h.stream(ctx);
    assert.ok(h.saved.get(h.identity().sessionKey).measurement.tokensPerSecond > 0);
    await h.send(ctx, 'execution.interrupted');
    const cancelled = h.saved.get(h.identity().sessionKey).measurement;
    assert.equal(cancelled.phase, 'cancelled'); assert.equal(cancelled.tokensPerSecond, undefined);
    assert.equal(cancelled.freshness, 'live'); assert.equal(cancelled.timingBasis, 'delivery-window');
    // A later delta cannot revive a cancelled step's speed.
    h.advance(200);
    await h.send(ctx, 'text.delta', 'session-a', { ordinal: 0, delta: 'y'.repeat(40) });
    assert.equal(h.saved.get(h.identity().sessionKey).measurement.tokensPerSecond, undefined);
  } finally { await h.close(); }
});

test('an interrupted cloud step never produces a completed-step average', async () => {
  const h = await harness();
  try {
    const ctx = await h.context(); h.watch([h.identity()]);
    await ctx.hooks.get('experimental.ws.handshake')(h.handshake());
    await h.stream(ctx);
    await h.send(ctx, 'execution.interrupted');
    const cancelled = h.saved.get(h.identity().sessionKey).measurement;
    assert.equal(cancelled.phase, 'cancelled'); assert.equal(cancelled.tokensPerSecond, undefined);
    assert.notEqual(cancelled.basis, 'reported-output');
    assert.notEqual(cancelled.timingBasis, 'completed-step');
    // Usage reported afterwards for the interrupted step must not become a completed-step average.
    await h.send(ctx, 'step.ended', 'session-a', { finish: 'stop', tokens: { output: 70, reasoning: 0 } });
    const after = h.saved.get(h.identity().sessionKey)?.measurement;
    assert.ok(!after || (after.phase !== 'complete' && after.tokensPerSecond === undefined
      && after.basis !== 'reported-output' && after.timingBasis !== 'completed-step'));
  } finally { await h.close(); }
});

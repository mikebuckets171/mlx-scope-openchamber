// Optional qualification: node bridge/opencode/protocol-compaction-smoke.mjs /absolute/path/to/opencode
// Starts an isolated OpenCode process and a synthetic loopback SSE provider. No real model, live configuration or
// application process is used. It proves two steps, one compaction and one resumed step, and the 2.1 contract the
// companion relies on: an auxiliary compaction request never opens a delivery window, `session.compaction.started`
// clears the chat, the checkpoint references what it keeps with `metadata.keepID`, and `session.context` materializes
// that text as `metadata.recent`. SCOPE_SMOKE_DEBUG=1 prints the host's own event shapes and heartbeat features when a
// step does not complete. Only shapes and counts are read; no message text is retained or printed.
import assert from 'node:assert/strict';
import { candidateProfile as profileFor } from './qualified.js';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { key } from './store.js';
import { atomicPrivateJSON } from './chat-store.js';

const binary = process.argv[2];
if (!binary) throw new Error('Pass the absolute path to a qualified OpenCode binary.');
const profile = profileFor(execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim().replace(/^opencode v/, ''));
assert.ok(profile, 'This OpenCode version is outside the accepted OpenCode lines (2.0.25 or 2.1.1 or later).');
const bridge = dirname(fileURLToPath(import.meta.url));
const base = await realpath(await mkdtemp(join(tmpdir(), 'scope-compaction-')));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, fixture, fixtureFailure, logs = '', requests = [], fixtureErrors = [];
try {
  for (const dir of ['config/opencode', 'home', 'cache', 'data', 'state', 'workspace', 'plugin', 'tap', 'telemetry', 'progress'])
    await mkdir(join(base, dir), { recursive: true });
  await writeFile(join(base, 'plugin/package.json'), JSON.stringify({ name: 'scope-isolated-smoke', type: 'module', exports: './index.js' }));
  await writeFile(join(base, 'plugin/index.js'), `
    import {makePlugin} from ${JSON.stringify(join(bridge, 'index.js'))};
    import {createChatObserver} from ${JSON.stringify(join(bridge, 'demand.js'))};
    import {createStore} from ${JSON.stringify(join(bridge, 'store.js'))};
    const companion = makePlugin({observerFactory:()=>createChatObserver({directory:${JSON.stringify(join(base, 'telemetry'))}}),
      storeFactory:()=>createStore({directory:${JSON.stringify(join(base, 'progress'))}})});
    export default companion;
  `);
  // A second, isolated plugin records the shape of the same public event feed the companion reads, so a dropped
  // measurement is named from the host's own stream instead of the helper's view. Shapes and counts only.
  await writeFile(join(base, 'tap/package.json'), JSON.stringify({ name: 'scope-event-tap', type: 'module', exports: './index.js' }));
  await writeFile(join(base, 'tap/index.js'), `
    import {appendFileSync} from 'node:fs';
    const path = ${JSON.stringify(join(base, 'events.jsonl'))};
    export default { id: 'scope-event-tap', setup(ctx) {
      // The subscription outlives setup, so nothing here may await it: a plugin whose setup never settles
      // stalls the host's own plugin initialisation.
      void (async () => {
      for await (const event of ctx.event.subscribe({})) {
        const data = event?.properties?.data ?? event?.data ?? {};
        appendFileSync(path, JSON.stringify({ type: event.type, sessionID: data?.sessionID, hasId: typeof event.id === 'string',
          created: typeof event.created, ageMs: typeof event.created === 'number' ? Date.now() - event.created : null,
          assistantMessageID: typeof data.assistantMessageID, part: data.part,
          tokens: data.tokens ? Object.keys(data.tokens).sort() : null, finish: typeof data.finish,
          text: typeof data.text, usage: data.tokens ? Object.keys(data.tokens.output ?? {}) : null }) + '\\n');
      }
      })().catch(() => {});
      return () => {};
    } };
  `);
  fixture = http.createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text || '{}');
    // A compaction request is the one that asks for the structured summary. Classify it, never keep its text.
    const serialized = JSON.stringify(body?.messages ?? []);
    const compaction = serialized.includes('You MUST summarize the conversation above');
    const sessionHeader = request.headers['x-opencode-session-id'];
    requests.push({ compaction, sessionHeaderPresent: typeof sessionHeader === 'string', stream: body?.stream === true, messages: Array.isArray(body?.messages) ? body.messages.length : null });
    try {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (delta, finish = null, usage) => response.write('data: ' + JSON.stringify({ id: 'fixture',
      object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fixture',
      choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) }) + '\n\n');
    frame({ role: 'assistant' });
    const content = compaction
      ? '## Objective\n- Fixture summary for the compaction contract check.\n\n## Next Move\n1. Continue.\n'
      : 'y'.repeat(120);
    // Long enough for the helper's two-second minimum delivery window.
    for (let i = 0; i < 16; i++) { await pause(220); if (response.destroyed) return; frame({ content }); }
    frame({}, 'stop', { prompt_tokens: 10, completion_tokens: compaction ? 30 : 400, total_tokens: 410 });
    response.end('data: [DONE]\n\n');
    } catch (error) { fixtureErrors.push(String(error)); response.destroy(); }
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const loopbackBase = `http://127.0.0.1:${fixture.address().port}/v1`;
  await writeFile(join(base, 'config/opencode/opencode.json'), JSON.stringify({ update: 'disable', share: 'disabled', snapshots: false,
    model: 'scopefixture/fixture', compaction: { auto: true, keep: { tokens: 2000 } },
    providers: { scopefixture: { package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: loopbackBase }, models: { fixture: { name: 'Compaction fixture',
        capabilities: { tools: false, input: ['text'], output: ['text'] }, limit: { context: 262144, output: 8192 } } } } },
    plugins: [{ package: join(base, 'plugin'), options: { promptProgress: false } }, { package: join(base, 'tap') }] }));
  const reservation = net.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: process.env.HOME,
    OPENCODE_TEST_HOME: join(base, 'home'), OPENCODE_CONFIG_DIR: join(base, 'config/opencode'),
    XDG_CONFIG_HOME: join(base, 'config'), XDG_CACHE_HOME: join(base, 'cache'), XDG_DATA_HOME: join(base, 'data'), XDG_STATE_HOME: join(base, 'state') };
  child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: join(base, 'workspace'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  // The generated test-server password stays in memory, is never printed or saved, and dies with this server.
  const collect = bytes => { if (logs.length < 32_768) logs += bytes; };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const headers = () => ({ Authorization: 'Basic ' + Buffer.from('opencode:' + (logs.match(/server password (\S+)/)?.[1] ?? '')).toString('base64') });
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    await pause(250);
    try { ready = (await fetch(`http://127.0.0.1:${port}/api/info`, { headers: headers(), signal: AbortSignal.timeout(1000) })).ok; } catch {}
  }
  assert.ok(ready, 'isolated server became ready');
  const api = async (path, value) => {
    const result = await fetch(`http://127.0.0.1:${port}${path}`, { method: value ? 'POST' : 'GET',
      headers: { ...headers(), 'content-type': 'application/json' }, body: value ? JSON.stringify(value) : undefined, signal: AbortSignal.timeout(60_000) });
    assert.ok(result.ok, `fixture API ${path} returned ${result.status}`); return result.json();
  };
  await api('/api/plugin'); await pause(1500);
  const heartbeat = JSON.parse(await readFile(join(base, 'telemetry/heartbeat.json'), 'utf8'));
  assert.ok(heartbeat.supported, 'the helper reports the accepted runtime as supported');
  assert.equal(heartbeat.runtimeVersion, profile.runtimeVersion);
  const { data: session } = await api('/api/session', { title: 'Scope compaction fixture', model: { providerID: 'scopefixture', id: 'fixture' } });
  const sessionKey = key('session', session.id), endpointKey = key('endpoint', new URL(loopbackBase).origin);
  // A view rewrites its demand file for as long as it watches. This scenario outlives one window, so demand is
  // renewed rather than left to expire: an expired file would stop tracking mid-step and hide the very behaviour checked.
  const demand = async () => { const at = Date.now(); await atomicPrivateJSON(join(base, 'telemetry'), 'demand.json',
    { schemaVersion: 1, updatedAtMs: at, expiresAtMs: at + 15_000,
      watched: [{ sessionKey, providerKey: key('provider', 'scopefixture'), modelKey: key('model', 'fixture') }] }); };
  /** Every measurement the writer published at or after `since`, across every writer file it keeps. */
  const readings = async since => {
    const seen = [];
    for (const file of await readdir(join(base, 'telemetry'))) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
      const document = await readFile(join(base, 'telemetry', file), 'utf8').then(JSON.parse).catch(() => null);
      for (const entry of document?.entries ?? []) {
        if (entry.measurement.observedAtMs < since) continue;
        assert.equal(entry.sessionKey, sessionKey);
        assert.equal(entry.providerKey, key('provider', 'scopefixture'));
        assert.equal(entry.modelKey, key('model', 'fixture'));
        assert.equal(entry.endpointKey, endpointKey);
        seen.push(entry.measurement);
      }
    }
    return seen;
  };
  // The writer keeps one live entry per chat, so every phase is collected as it is published.
  const step = async (since, label) => {
    const collected = [], deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await demand();
      await pause(150);
      if (fixtureFailure) throw fixtureFailure;
      for (const measurement of await readings(since)) collected.push(measurement);
      if (collected.some(value => value.phase === 'complete')) return collected;
    }
    if (process.env.SCOPE_SMOKE_DEBUG) { const m = (await api(`/api/session/${session.id}/message`)).data;
      const heartbeatNow = JSON.parse(await readFile(join(base, 'telemetry/heartbeat.json'), 'utf8'));
      console.log(JSON.stringify({ debug: { label, phases: collected.map(v => v.phase), requests,
        messages: m.map(v => ({ type: v.type, status: v.status, error: v.error?.type, parts: v.content?.length })), fixtureErrors,
        features: heartbeatNow.features,
        events: (await readFile(join(base, 'events.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean)
          .map(line => JSON.parse(line)).filter(entry => entry.sessionID === session.id) } })); }
    assert.fail(`no completed step for ${label}`);
  };
  await demand(); await pause(1300);
  // Two exchanges, so the summary has a newer user turn to keep beside it.
  for (const text of ['Compaction fixture step one.', 'Compaction fixture step two.']) {
    const started = Date.now();
    await api(`/api/session/${session.id}/prompt`, { text });
    const seen = await step(started, text);
    assert.ok(seen.some(value => value.phase === 'generating' && value.tokensPerSecond > 0), `${text} delivers a live estimate`);
    assert.ok(seen.some(value => value.phase === 'complete' && value.basis === 'reported-output'), `${text} completes on reported output`);
  }

  const compacting = Date.now();
  await demand();
  await api(`/api/session/${session.id}/compact`, { id: 'msg_compaction_fixture' });
  await pause(1500);
  assert.ok(requests.some(entry => entry.compaction), 'the fixture served a compaction request');
  assert.ok(requests.filter(entry => entry.compaction).every(entry => entry.sessionHeaderPresent), 'the compaction request carries the session header');
  const during = await readings(compacting);
  assert.equal(during.length, 0, 'an auxiliary compaction request publishes no chat measurement');

  // 2.1 stores what a summary keeps as a reference, not as text on the event. Only shapes are read here.
  const completedCheckpoint = async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await demand();
      const messages = (await api(`/api/session/${session.id}/message`)).data;
      const found = messages.find(message => message.type === 'compaction' && message.status === 'completed');
      if (found) return found;
      await pause(200);
    }
    assert.fail('the compaction finished');
  };
  const checkpoint = await completedCheckpoint();
  assert.equal(typeof checkpoint.metadata?.keepID, 'string', 'the checkpoint references its kept messages by ID');
  assert.equal(checkpoint.metadata?.recent, undefined, 'the checkpoint stores no recent text');
  const context = (await api(`/api/session/${session.id}/context`)).data;
  const kept = context?.find(message => message.type === 'compaction');
  assert.equal(typeof kept?.metadata?.recent, 'string', 'session.context materializes the kept text');
  assert.ok(kept.metadata.recent.length > 0, 'the materialized kept text is not empty');
  assert.ok((await readings(Date.now())).length === 0);

  const resumed = Date.now();
  await demand();
  await api(`/api/session/${session.id}/prompt`, { text: 'Compaction fixture step three.' });
  const second = await step(resumed, 'the resumed step');
  assert.ok(second.some(value => value.phase === 'generating' && value.tokensPerSecond > 0), 'the resumed step delivers a live estimate');
  const complete = second.find(value => value.phase === 'complete');
  assert.ok(complete && complete.basis === 'reported-output', 'the resumed step completes on reported output');
  console.log(JSON.stringify({ result: 'pass', runtimeVersion: heartbeat.runtimeVersion, fixtureRequests: requests.length,
    compactionRequests: requests.filter(entry => entry.compaction).length,
    measurementsDuringCompaction: during.length,
    checkpointKeepReference: typeof checkpoint.metadata.keepID === 'string',
    contextRecentMaterialized: typeof kept?.metadata?.recent === 'string',
    resumed: { basis: complete.basis, tokensPerSecond: complete.tokensPerSecond } }, null, 2));
} finally {
  fixture?.closeAllConnections(); fixture?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM'); await Promise.race([exited, pause(3000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
  await rm(base, { recursive: true, force: true });
}
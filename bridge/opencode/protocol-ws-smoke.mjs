// Optional qualification: node bridge/opencode/protocol-ws-smoke.mjs /absolute/path/to/opencode
// Starts an isolated released OpenCode process with its built-in OpenAI default transport.
// All requests are rerouted to a synthetic loopback Responses server; no credential or real model is used.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { wsServer as WebSocketServer } from 'playwright-core/lib/utilsBundle';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { key } from './store.js';
import { atomicPrivateJSON } from './chat-store.js';

const binary = process.argv[2];
if (!binary) throw new Error('Pass the absolute path to an OpenCode 2.0.25 binary.');
const remote = true;
const remoteBase = 'http://scope-protocol-fixture.invalid/v1';
const remoteWS = 'ws://scope-protocol-fixture.invalid/v1';
assert.equal(execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(), 'opencode v2.0.25');
const bridge = dirname(fileURLToPath(import.meta.url)), repo = resolve(bridge, '../..');
const companionFiles = ['index.js', 'demand.js', 'chat.js', 'chat-store.js', 'store.js', 'stream.js', 'package.json'];
const hashes = async () => Object.fromEntries(await Promise.all(companionFiles.map(async name => [name, createHash('sha256').update(await readFile(join(bridge, name))).digest('hex')])));
const companionSha256 = await hashes();
const cache = join(repo, 'node_modules', '.cache'); await mkdir(cache, { recursive: true });
const base = await mkdtemp(join(cache, 'scope-protocol-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, fixture, sockets, fixtureFailure, logs = '', fixtureRequests = 0, connections = 0;
const dispatches = []; let toolNext = false;
try {
  for (const dir of ['config/opencode', 'home', 'cache', 'data', 'state', 'workspace', 'plugin', 'telemetry', 'progress'])
    await mkdir(join(base, dir), { recursive: true });
  await writeFile(join(base, 'plugin/package.json'), JSON.stringify({ name: 'scope-isolated-smoke', type: 'module', exports: './index.js' }));
  await writeFile(join(base, 'plugin/index.js'), `
    import {makePlugin} from ${JSON.stringify(join(bridge, 'index.js'))};
    import {createChatObserver} from ${JSON.stringify(join(bridge, 'demand.js'))};
    import {createStore} from ${JSON.stringify(join(bridge, 'store.js'))};
    const companion = makePlugin({observerFactory:()=>createChatObserver({directory:${JSON.stringify(join(base, 'telemetry'))}}),
      storeFactory:()=>createStore({directory:${JSON.stringify(join(base, 'progress'))}})});
    export default {...companion, async setup(ctx) {
      const detach = await companion.setup(ctx);
      // Test-only routing runs after the real companion. Synthetic requests never reach DNS or a cloud provider.
      const route = await ctx.session.hook('experimental.ws.handshake', async event => {
        if (!event.url.startsWith(${JSON.stringify(remoteWS)})) throw new Error('Unexpected fixture destination');
        event.url = event.url.replace(${JSON.stringify(remoteWS)}, process.env.SCOPE_PROTOCOL_LOOPBACK.replace('http:', 'ws:'));
      });
      return async () => { await route?.dispose?.(); await detach?.(); };
    }};
  `);
  fixture = http.createServer((request, response) => {
    // A fallback HTTP request is a protocol failure; no upstream destination exists.
    response.writeHead(500); response.end('WebSocket fixture only');
  });
  sockets = new WebSocketServer({ server: fixture });
  sockets.on('connection', socket => {
    connections++;
    socket.on('message', async bytes => {
      try {
      const body = JSON.parse(String(bytes)); fixtureRequests++;
      assert.equal(body.type, 'response.create');
      dispatches.push({ connection: connections, continuation: typeof body.previous_response_id === 'string' });
      const responseID = `resp_fixture_${fixtureRequests}`, itemID = `msg_fixture_${fixtureRequests}`;
      let sequence = 0;
      const frame = (type, data) => socket.send(JSON.stringify({ type, sequence_number: sequence++, ...data }));
      const response = { id: responseID, object: 'response', created_at: Math.floor(Date.now() / 1000),
        model: 'gpt-6.1-sol', status: 'in_progress', output: [] };
      frame('response.created', { response });
      if (toolNext) {
        toolNext = false;
        const tool = body.tools.find(item => item.name === 'read');
        assert.ok(tool, 'native read tool available for fixture-only file');
        const args = JSON.stringify({ filePath: join(base, 'workspace', 'fixture.txt') });
        const item = { id: itemID, type: 'function_call', call_id: 'call_fixture', name: 'read', arguments: '', status: 'in_progress' };
        frame('response.output_item.added', { output_index: 0, item });
        frame('response.function_call_arguments.delta', { item_id: itemID, output_index: 0, delta: args });
        frame('response.function_call_arguments.done', { item_id: itemID, output_index: 0, arguments: args });
        const done = { ...item, arguments: args, status: 'completed' };
        frame('response.output_item.done', { output_index: 0, item: done });
        frame('response.completed', { response: { ...response, status: 'completed', output: [done],
          usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20, output_tokens_details: { reasoning_tokens: 0 } } } });
        return;
      }
      const item = { id: itemID, type: 'message', role: 'assistant', status: 'in_progress', content: [] };
      frame('response.output_item.added', { output_index: 0, item });
      frame('response.content_part.added', { item_id: itemID, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      for (let i = 0; i < 14; i++) { await pause(220); if (socket.readyState !== 1) return;
        frame('response.output_text.delta', { item_id: itemID, output_index: 0, content_index: 0, delta: 'x'.repeat(20) }); }
      const text = 'x'.repeat(280), part = { type: 'output_text', text, annotations: [] };
      frame('response.output_text.done', { item_id: itemID, output_index: 0, content_index: 0, text });
      frame('response.content_part.done', { item_id: itemID, output_index: 0, content_index: 0, part });
      const done = { ...item, status: 'completed', content: [part] };
      frame('response.output_item.done', { output_index: 0, item: done });
      frame('response.completed', { response: { ...response, status: 'completed', output: [done],
        usage: { input_tokens: 10, output_tokens: 70, total_tokens: 80, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
      } catch (error) { fixtureFailure = error; socket.terminate(); }
    });
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const loopbackBase = `http://127.0.0.1:${fixture.address().port}/v1`;
  const providerBase = remote ? remoteBase : loopbackBase;
  await writeFile(join(base, 'workspace/fixture.txt'), 'CPU-only fixture tool result.');
  await writeFile(join(base, 'config/opencode/opencode.json'), JSON.stringify({ update: 'disable', share: 'disabled', snapshots: false,
    model: 'openai/gpt-6.1-sol', providers: { openai: { settings: { baseURL: providerBase, apiKey: 'fixture-only-no-credential' },
      models: { 'gpt-6.1-sol': { name: 'Protocol fixture', capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 262144, output: 8192 } } } } },
    plugins: [{ package: join(base, 'plugin'), options: { promptProgress: false } }] }));
  const reservation = net.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: process.env.HOME,
    OPENCODE_TEST_HOME: join(base, 'home'), OPENCODE_CONFIG_DIR: join(base, 'config/opencode'),
    XDG_CONFIG_HOME: join(base, 'config'), XDG_CACHE_HOME: join(base, 'cache'), XDG_DATA_HOME: join(base, 'data'), XDG_STATE_HOME: join(base, 'state'),
    SCOPE_PROTOCOL_LOOPBACK: loopbackBase };
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
      headers: { ...headers(), 'content-type': 'application/json' }, body: value ? JSON.stringify(value) : undefined, signal: AbortSignal.timeout(15_000) });
    assert.ok(result.ok, `fixture API ${path} returned ${result.status}`); return result.json();
  };
  await api('/api/plugin'); await pause(1500);
  const heartbeat = JSON.parse(await readFile(join(base, 'telemetry/heartbeat.json'), 'utf8'));
  assert.ok(heartbeat.supported); assert.equal(heartbeat.runtimeVersion, '2.0.25');
  const { data: session } = await api('/api/session', { title: 'Scope protocol fixture', model: { providerID: 'openai', id: 'gpt-6.1-sol' } });
  assert.ok(session.id);
  const summaries = [];
  for (let round = 0; round < 5; round++) {
    const started = Date.now();
    await atomicPrivateJSON(join(base, 'telemetry'), 'demand.json', { schemaVersion: 1, updatedAtMs: started, expiresAtMs: started + 15_000,
      watched: [{ sessionKey: key('session', session.id), providerKey: key('provider', 'openai'), modelKey: key('model', 'gpt-6.1-sol'),
        ...remote ? { destination: 'remote' } : {} }] });
    if (round === 4) toolNext = true; // Native tool continuation must reuse the socket and get a fresh handshake proof.
    await api(`/api/session/${session.id}/prompt`, { text: 'Protocol fixture.' });
    const seen = [];
    for (let sample = 0; sample < 65; sample++) {
      await pause(150);
      if (fixtureFailure) throw fixtureFailure;
      for (const file of await readdir(join(base, 'telemetry'))) {
        if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
        let document;
        try { document = JSON.parse(await readFile(join(base, 'telemetry', file), 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        for (const entry of document.entries ?? []) if (entry.measurement.observedAtMs >= started) {
            assert.equal(entry.sessionKey, key('session', session.id));
            assert.equal(entry.providerKey, key('provider', 'openai'));
            assert.equal(entry.modelKey, key('model', 'gpt-6.1-sol'));
            assert.equal(entry.endpointKey, key('endpoint', new URL(remoteWS).origin));
            assert.equal(entry.destination, remote ? 'remote' : undefined);
            seen.push(entry.measurement);
        }
      }
      if (seen.some(value => value.phase === 'complete')) break;
    }
    const active = seen.find(value => value.phase === 'generating' && value.tokensPerSecond > 0);
    const complete = seen.find(value => value.phase === 'complete');
    assert.ok(active, 'actual event stream supplies a live estimate'); assert.ok(complete, 'actual event stream supplies completion');
    assert.equal(active.basis, round < 3 ? 'estimated-characters' : 'calibrated-characters');
    if (round >= 3) assert.equal(active.calibrationSteps, round);
    assert.equal(complete.basis, 'reported-output'); assert.equal(complete.timingBasis, 'completed-step');
    assert.equal(complete.freshness, 'last');
    const duration = complete.observation.endedAtMs - complete.observation.startedAtMs;
    assert.ok(duration > 0 && Number.isFinite(duration), 'completion has a valid observed step duration');
    assert.ok(Number.isFinite(complete.tokensPerSecond) && complete.tokensPerSecond > 0, 'eligible completion has an average');
    assert.ok(Math.abs(complete.tokensPerSecond - 70_000 / duration) < 1e-8, 'completion average uses the known seventy output tokens');
    summaries.push({ basis: active.basis, calibrationSteps: active.calibrationSteps, liveTps: active.tokensPerSecond, completedTps: complete.tokensPerSecond });
  }
  assert.equal(connections, 1, 'all primary steps reuse one native WebSocket');
  assert.equal(fixtureRequests, 6, 'five prompts plus one native tool continuation');
  assert.ok(dispatches.slice(1).some(value => value.continuation), 'native response checkpoint enables continuation');
  await unlink(join(base, 'telemetry/demand.json')); await pause(1300);
  assert.ok(!(await readdir(join(base, 'telemetry'))).some(file => /^[a-f0-9-]{36}\.json$/.test(file)), 'hidden demand removes telemetry writer');
  const hiddenHeartbeat = (await stat(join(base, 'telemetry/heartbeat.json'))).mtimeMs;
  await pause(1300); assert.equal((await stat(join(base, 'telemetry/heartbeat.json'))).mtimeMs, hiddenHeartbeat, 'no hidden heartbeat writes');
  assert.deepEqual(await hashes(), companionSha256, 'Companion changed during qualification');
  console.log(JSON.stringify({ result: 'pass', companionSha256, destination: remote ? 'synthetic-remote-routed-to-loopback' : 'local',
    runtimeVersion: heartbeat.runtimeVersion, companionVersion: heartbeat.companionVersion, fixtureRequests, connections, dispatches, summaries, hiddenWritesStopped: true }, null, 2));
} finally {
  for (const socket of sockets?.clients ?? []) socket.terminate(); sockets?.close();
  fixture?.closeAllConnections(); fixture?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM'); await Promise.race([exited, pause(3000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
  await rm(base, { recursive: true, force: true });
}

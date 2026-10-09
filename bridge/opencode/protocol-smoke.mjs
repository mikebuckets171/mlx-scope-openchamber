// Optional qualification: node bridge/opencode/protocol-smoke.mjs /absolute/path/to/opencode [--remote]
// Starts an isolated released OpenCode process and a synthetic loopback SSE provider. No real model is used.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { key } from './store.js';
import { atomicPrivateJSON } from './chat-store.js';

const binary = process.argv[2];
if (!binary) throw new Error('Pass the absolute path to an OpenCode 2.0.25 binary.');
const remote = process.argv.includes('--remote');
const remoteBase = 'http://scope-protocol-fixture.invalid/v1';
assert.equal(execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(), 'opencode v2.0.25');
const bridge = dirname(fileURLToPath(import.meta.url)), repo = resolve(bridge, '../..');
const cache = join(repo, 'node_modules', '.cache'); await mkdir(cache, { recursive: true });
const base = await mkdtemp(join(cache, 'scope-protocol-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, fixture, logs = '', fixtureRequests = 0;
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
      // Test-only routing follows Scope's primary-request observer. OpenCode still produces every public event.
      // The synthetic remote URL never reaches DNS or a cloud provider; its receiver is the loopback SSE fixture.
      const route = ${remote} ? await ctx.session.hook('http.request', event => {
        if (event.kind !== 'primary' || !event.request.url.startsWith(${JSON.stringify(remoteBase)})) return;
        const url = event.request.url.replace(${JSON.stringify(remoteBase)}, process.env.SCOPE_PROTOCOL_LOOPBACK);
        event.request = new Request(url, {method:event.request.method, headers:event.request.headers,
          body:event.request.body, signal:event.request.signal, duplex:'half'});
      }) : null;
      return async () => { await route?.dispose?.(); await detach?.(); };
    }};
  `);
  fixture = http.createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text || '{}'); fixtureRequests++;
    if (!body.stream) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: 'fixture',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Protocol fixture' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 70, total_tokens: 80 } })); return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (delta, finish = null, usage) => response.write('data: ' + JSON.stringify({ id: 'fixture',
      object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fixture',
      choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) }) + '\n\n');
    frame({ role: 'assistant' });
    for (let i = 0; i < 14; i++) { await pause(220); if (response.destroyed) return; frame({ content: 'x'.repeat(20) }); }
    frame({}, 'stop', { prompt_tokens: 10, completion_tokens: 70, total_tokens: 80 }); response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const loopbackBase = `http://127.0.0.1:${fixture.address().port}/v1`;
  const providerBase = remote ? remoteBase : loopbackBase;
  await writeFile(join(base, 'config/opencode/opencode.json'), JSON.stringify({ update: 'disable', share: 'disabled', snapshots: false,
    model: 'scopefixture/fixture', providers: { scopefixture: { package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: providerBase }, models: { fixture: { name: 'Protocol fixture',
        capabilities: { tools: false, input: ['text'], output: ['text'] }, limit: { context: 262144, output: 8192 } } } } },
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
  const { data: session } = await api('/api/session', { title: 'Scope protocol fixture', model: { providerID: 'scopefixture', id: 'fixture' } });
  assert.ok(session.id);
  const summaries = [];
  for (let round = 0; round < 4; round++) {
    const started = Date.now();
    await atomicPrivateJSON(join(base, 'telemetry'), 'demand.json', { schemaVersion: 1, updatedAtMs: started, expiresAtMs: started + 15_000,
      watched: [{ sessionKey: key('session', session.id), providerKey: key('provider', 'scopefixture'), modelKey: key('model', 'fixture'),
        ...remote ? { destination: 'remote' } : {} }] });
    if (round === 0) await pause(1300);
    await api(`/api/session/${session.id}/prompt`, { text: 'Protocol fixture: no tools.' });
    const seen = [];
    for (let sample = 0; sample < 65; sample++) {
      await pause(150);
      for (const file of await readdir(join(base, 'telemetry'))) {
        if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
        let document;
        try { document = JSON.parse(await readFile(join(base, 'telemetry', file), 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        for (const entry of document.entries ?? []) if (entry.measurement.observedAtMs >= started) {
            assert.equal(entry.sessionKey, key('session', session.id));
            assert.equal(entry.providerKey, key('provider', 'scopefixture'));
            assert.equal(entry.modelKey, key('model', 'fixture'));
            assert.equal(entry.endpointKey, key('endpoint', new URL(providerBase).origin));
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
    if (round === 3) assert.equal(active.calibrationSteps, 3);
    assert.equal(complete.basis, 'reported-output'); assert.equal(complete.timingBasis, 'completed-step');
    assert.equal(complete.freshness, 'last');
    const duration = complete.observation.endedAtMs - complete.observation.startedAtMs;
    assert.ok(duration > 0 && Number.isFinite(duration), 'completion has a valid observed step duration');
    assert.ok(Number.isFinite(complete.tokensPerSecond) && complete.tokensPerSecond > 0, 'eligible completion has an average');
    assert.ok(Math.abs(complete.tokensPerSecond - 70_000 / duration) < 1e-8, 'completion average uses the known seventy output tokens');
    summaries.push({ basis: active.basis, calibrationSteps: active.calibrationSteps, liveTps: active.tokensPerSecond, completedTps: complete.tokensPerSecond });
  }
  await unlink(join(base, 'telemetry/demand.json')); await pause(1300);
  assert.ok(!(await readdir(join(base, 'telemetry'))).some(file => /^[a-f0-9-]{36}\.json$/.test(file)), 'hidden demand removes telemetry writer');
  const hiddenHeartbeat = (await stat(join(base, 'telemetry/heartbeat.json'))).mtimeMs;
  await pause(1300); assert.equal((await stat(join(base, 'telemetry/heartbeat.json'))).mtimeMs, hiddenHeartbeat, 'no hidden heartbeat writes');
  console.log(JSON.stringify({ result: 'pass', destination: remote ? 'synthetic-remote-routed-to-loopback' : 'local',
    runtimeVersion: heartbeat.runtimeVersion, fixtureRequests, summaries, hiddenWritesStopped: true }, null, 2));
} finally {
  fixture?.closeAllConnections(); fixture?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM'); await Promise.race([exited, pause(3000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
  await rm(base, { recursive: true, force: true });
}

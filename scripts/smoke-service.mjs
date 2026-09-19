import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as createHTTPServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Test the extracted install, not TypeScript or a checkout with node_modules.
assert(process.argv[2], 'Pass the extracted extension directory.');
const root = resolve(process.argv[2]);
const home = await mkdtemp(join(tmpdir(), 'mlx-scope-smoke-'));
const token = randomBytes(24).toString('hex');
const children = [];
let mockRuntime = null;

function start(port, overrides = {}) {
  const child = spawn(process.execPath, [join(root, 'service/main.js')], {
    cwd: root,
    // Never inherit credentials, NODE_PATH, NODE_OPTIONS or the real home.
    env: {
      PATH: process.env.PATH ?? '', HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
      TMPDIR: home, TMP: home, TEMP: home,
      OPENCHAMBER_SERVICE_PORT: String(port), OPENCHAMBER_SERVICE_TOKEN: token,
      ...overrides,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const state = { child, log: '', closed: false, result: null, done: null };
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text) => { state.log = (state.log + text).slice(-16_384); });
  state.done = new Promise((resolveDone) => {
    child.once('error', (error) => { state.log += String(error); });
    child.once('close', (code, signal) => {
      state.closed = true;
      state.result = { code, signal };
      resolveDone(state.result);
    });
  });
  children.push(state);
  return state;
}

async function stop(state) {
  if (!state.closed) {
    state.child.kill('SIGTERM');
    const killTimer = setTimeout(() => state.child.kill('SIGKILL'), 2_500);
    try { await state.done; } finally { clearTimeout(killTimer); }
  }
}

function assertHostReadings(snapshot) {
  assert(snapshot.system && typeof snapshot.system === 'object', 'Host readings must survive an unavailable runtime.');
  if (process.platform !== 'darwin') return;
  const readings = snapshot.system.macOS;
  assert(readings, 'The packaged Node service must return native Mac readings.');
  for (const key of ['wiredGB', 'compressedGB', 'swapUsedGB']) {
    assert.equal(typeof readings[key], 'number', `${key} was not read from macOS.`);
    assert(Number.isFinite(readings[key]) && readings[key] >= 0, `${key} must be finite and nonnegative.`);
  }
}

async function unusedPort() {
  const probe = createServer();
  await new Promise((resolveListen, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolveListen);
  });
  const { port } = probe.address();
  await new Promise((resolveClose, reject) => probe.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

try {
  const config = join(home, '.config/opencode');
  await mkdir(config, { recursive: true });
  // Exercise the bundled JSONC parser against a closed, isolated endpoint.
  await writeFile(join(config, 'opencode.jsonc'), `// isolated smoke fixture
{
  "provider": { "omlx": { "options": { "baseURL": "http://127.0.0.1:1/v1" } } },
  "model": "omlx/smoke",
}
`);
  const port = await unusedPort();
  const service = start(port);
  const url = `http://127.0.0.1:${port}`;
  const get = (path, authorized = true) => fetch(url + path, {
    headers: authorized ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(3_000),
  });
  let healthy = false;
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    assert(!service.closed, `Bundled service exited before readiness:\n${service.log}`);
    try {
      const response = await get('/health');
      healthy = response.status === 200 && (await response.json()).status === 'healthy';
      if (healthy) break;
    } catch { /* The child may still be binding its listener. */ }
    await delay(50);
  }
  assert(healthy, `Bundled service did not become ready:\n${service.log}`);
  assert.equal((await get('/health', false)).status, 401);
  assert.equal((await get('/snapshot', false)).status, 401);
  assert.equal((await fetch(url + '/snapshot', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3_000) })).status, 405);
  const response = await get('/snapshot');
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.reason, 'runtime_unreachable');
  assert.equal(snapshot.connection?.selected, 'omlx', 'JSONC must select the configured provider.');
  assert.equal(snapshot.connection?.runtime, 'omlx');
  assert.equal(snapshot.connection?.diagnostic, 'offline');
  assert.equal(typeof snapshot.message, 'string');
  assert(snapshot.message.trim(), 'An unavailable connection needs an explanation.');
  assertHostReadings(snapshot);

  // A real bind failure must exit and retain its actionable cause in stderr.
  const collision = start(port);
  const failureDeadline = performance.now() + 3_000;
  while (!collision.closed && performance.now() < failureDeadline) await delay(25);
  assert(collision.closed, 'Service did not exit after a port conflict.');
  assert.equal(collision.result.code, 1);
  assert.match(collision.log, /EADDRINUSE/);
  assert(!collision.log.includes(token), 'Startup diagnostics exposed the service token.');
  await stop(service);
  assert.equal(service.result.code, 0, 'Service did not stop cleanly.');
  // Exercise real HTTP collection through the extracted, minified Node bundle.
  let flight = { request_id: 'private-smoke-request', processed: 64, total: 100, speed: 184, eta: 0.2 };
  let primary = false;
  let runtimeKind = 'omlx';
  let outputTokens = 10;
  const runtimeCalls = [];
  const authFailures = [];
  const runtimeKey = 'isolated-smoke-key';
  mockRuntime = createHTTPServer(async (request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    runtimeCalls.push({ runtime: runtimeKind, path, method: request.method });
    const rejectAuth = (reason) => {
      authFailures.push(reason); response.writeHead(401); response.end('{}');
    };
    let body;
    if (path === '/health') {
      if (request.headers.authorization || request.headers.cookie) { rejectAuth('Health must be anonymous.'); return; }
      body = runtimeKind === 'mlx-lm' ? { status: 'ok' } : runtimeKind === 'vllm-mlx'
        ? { status: 'healthy', model_loaded: true, model_name: 'fixture', available_models: ['fixture'], engine_type: 'batched', model_type: 'llm' }
        : { status: 'healthy', engine_pool: { model_count: 1 } };
    } else if (runtimeKind === 'lmstudio' && path === '/api/v1/models') {
      if (request.headers.authorization !== 'Bearer studio-smoke-key') { rejectAuth('LM Studio must use its configured key.'); return; }
      body = { models: [{ key: '/private/models/studio-fixture', type: 'llm', format: 'mlx', max_context_length: 32768,
        loaded_instances: [{ id: 'studio-instance', config: { context_length: 8192 } }] }] };
    } else if (runtimeKind === 'mlx-lm' && path === '/v1/models') {
      if (request.headers.authorization || request.headers.cookie) { rejectAuth('Key-free mlx-lm must not borrow another provider key.'); return; }
      body = { object: 'list', data: [{ id: '/private/models/downloaded-fixture', object: 'model' }] };
    } else if (runtimeKind === 'vllm-mlx' && path === '/v1/status') {
      if (request.headers.authorization !== 'Bearer vllm-smoke-key') { rejectAuth('vllm-mlx must use its configured key.'); return; }
      body = { status: 'running', model: 'fixture', num_running: 1, num_waiting: 0, requests: [{
        request_id: 'private-vllm-request', status: 'running', phase: 'generation', prompt_tokens: 100,
        completion_tokens: outputTokens, tokens_per_second: 40, cached_tokens: 50, cache_hit_type: 'prefix',
      }] };
    } else if (runtimeKind === 'omlx' && path === '/admin/api/login') {
      if (request.method !== 'POST') { rejectAuth('oMLX login must use POST.'); return; }
      let bytes = 0;
      const chunks = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 4096) { rejectAuth('Login body exceeded its fixture bound.'); return; }
        chunks.push(chunk);
      }
      let login;
      try { login = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { rejectAuth('Login needs JSON.'); return; }
      if (login.api_key !== runtimeKey || login.remember !== false) { rejectAuth('The saved provider key must reach oMLX login.'); return; }
      response.setHeader('Set-Cookie', 'omlx_admin_session=smoke; HttpOnly'); body = {};
    } else if (runtimeKind === 'omlx' && path === '/v1/models/status') {
      if (request.headers.authorization !== `Bearer ${runtimeKey}`) { rejectAuth('Model metadata must use the configured key.'); return; }
      body = { models: [] };
    } else if (runtimeKind === 'omlx' && (path === '/admin/api/activity' || path === '/admin/api/stats')) {
      if (request.headers.cookie !== 'omlx_admin_session=smoke') { rejectAuth('Monitoring requires the authenticated oMLX session.'); return; }
      body = { engines: {}, active_models: { models: [{ id: 'fixture', active_requests: 1, prefilling: primary ? [] : [flight], activities: primary ? [flight] : [] }] } };
    } else { response.writeHead(404); response.end(); return; }
    if (path !== '/admin/api/login' && request.method !== 'GET') { response.writeHead(405); response.end(); return; }
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(body));
  });
  await new Promise((resolveListen, reject) => { mockRuntime.once('error', reject); mockRuntime.listen(0, '127.0.0.1', resolveListen); });
  const runtimeBase = `http://127.0.0.1:${mockRuntime.address().port}/v1`;
  await writeFile(join(config, 'opencode.jsonc'), `// packaged JSONC fixture\n{"provider":{"omlx":{"options":{"baseURL":"${runtimeBase}","apiKey":"${runtimeKey}",},},},}`);
  const activeService = start(port);
  let ready = false;
  const nextDeadline = performance.now() + 5000;
  while (performance.now() < nextDeadline && !activeService.closed) {
    try { ready = (await get('/health')).status === 200; if (ready) break; } catch {}
    await delay(50);
  }
  assert(ready, `Packaged service did not restart: ${activeService.log}`);
  const activeSnapshot = await (await get('/snapshot')).json();
  assert.equal(activeSnapshot.available, true);
  assertHostReadings(activeSnapshot);
  assert.equal(activeSnapshot.prefillProgress, 0.64);
  assert.equal(activeSnapshot.prefillETASeconds, 0.2);
  assert.equal(activeSnapshot.residentModelCount, 1);
  assert.equal(activeSnapshot.residentModels[0].prefillProgress, 0.64);
  assert.equal(activeSnapshot.prefillProcessedTokens, 64);
  assert.equal(activeSnapshot.prefillTotalTokens, 100);
  assert.equal(activeSnapshot.prefillProgressStale, false);
  assert(!JSON.stringify(activeSnapshot).includes('private-smoke-request'));
  assert(!JSON.stringify(activeSnapshot).includes('isolated-smoke-key'));
  flight = { ...flight, processed: 101 };
  await delay(550);
  const invalid = await (await get('/snapshot')).json();
  assert.equal(invalid.prefillProgress, null, 'Malformed progress must not become 100% complete.');
  assert.equal(invalid.prefillETASeconds, null);
  assert.equal(invalid.residentModels[0].prefillProgress, null);
  primary = true;
  flight = {request_id: 'private-primary-request', kind: 'generate', detail: 'generating', token_count: 64, elapsed_seconds: 30, last_activity_age_seconds: 0.1};
  await delay(550);
  const dflash = await (await get('/snapshot')).json();
  assert.equal(dflash.available, true);
  assert.equal(dflash.phase, 'decode');
  assert.equal(dflash.completionTokens, 64);
  assert.equal(dflash.liveDecodeTPS, null, 'Activity elapsed time is not a decode average.');
  assert.equal(dflash.prefillProgress, null, 'Primary DFlash has no reported prefill fraction.');
  assert(Number.isFinite(dflash.traceEpoch));
  assert(!JSON.stringify(dflash).includes('private-primary-request'));
  primary = false;
  flight = {request_id: 'private-fallback', processed: 25, total: 100, speed: 100, eta: 0.75};
  await delay(550);
  const fallback = await (await get('/snapshot')).json();
  assert.equal(fallback.phase, 'prefill');
  assert.equal(fallback.prefillProgress, 0.25);
  assert.notEqual(fallback.traceEpoch, dflash.traceEpoch);
  assert.deepEqual(authFailures, []);
  assert.equal(runtimeCalls.filter(call => call.path === '/admin/api/login').length, 1, 'The package must authenticate once and reuse its session.');
  for (const path of ['/health', '/v1/models/status', '/admin/api/activity', '/admin/api/stats']) {
    assert(runtimeCalls.some(call => call.path === path), `The package did not exercise ${path}.`);
  }
  await stop(activeService);

  // Use only isolated HTTP fixtures; this checks that every adapter ships in the ZIP.
  await writeFile(join(config, 'opencode.jsonc'), JSON.stringify({ provider: {
    studio: { name: 'LM Studio', options: { baseURL: runtimeBase, apiKey: 'studio-smoke-key' } },
    'mlx-lm': { options: { baseURL: runtimeBase } },
    'vllm-mlx': { options: { baseURL: runtimeBase, apiKey: 'vllm-smoke-key' } },
  } }));
  const multiService = start(port);
  ready = false;
  const multiDeadline = performance.now() + 5000;
  while (performance.now() < multiDeadline && !multiService.closed) {
    try { ready = (await get('/health')).status === 200; if (ready) break; } catch {}
    await delay(50);
  }
  assert(ready, `Packaged multi-runtime service did not become ready: ${multiService.log}`);
  runtimeKind = 'lmstudio';
  const studio = await (await get('/snapshot?provider=studio')).json();
  assert.equal(studio.available, true);
  assert.equal(studio.runtime, 'lmstudio');
  assert.equal(studio.connection?.coverage, 'inventory');
  assert.equal(studio.catalog[0].name, 'studio-fixture');
  assert.equal(studio.catalog[0].contextWindow, 8192);
  assert.equal(studio.residentModelCount, 1);
  assert.equal(studio.activeRequests, null);
  assert.equal(studio.liveDecodeTPS, null);
  runtimeKind = 'mlx-lm';
  const mlx = await (await get('/snapshot?provider=mlx-lm')).json();
  assert.equal(mlx.available, true);
  assert.equal(mlx.runtime, 'mlx-lm');
  assert.equal(mlx.catalog[0].name, 'downloaded-fixture');
  assert.equal(mlx.catalog[0].loaded, null, 'A downloaded model is not a resident model.');
  assert.equal(mlx.activeRequests, null);
  assert.equal(mlx.prefillProgress, null);
  runtimeKind = 'vllm-mlx';
  const pending = await (await get('/snapshot?provider=vllm-mlx')).json();
  assert.equal(pending.available, true);
  assert.equal(pending.runtime, 'vllm-mlx');
  assert.equal(pending.liveDecodeTPS, null, 'The first output counter does not prove fresh generation.');
  outputTokens = 20;
  await delay(550);
  const vllm = await (await get('/snapshot?provider=vllm-mlx')).json();
  assert.equal(vllm.phase, 'decode');
  assert.equal(vllm.liveDecodeTPS, 40);
  assert.equal(vllm.completionTokens, 20);
  assert.equal(vllm.cachedTokens, 50);
  assert.equal(vllm.prefillProgress, null);
  assert.equal(vllm.connection?.coverage, 'requests');
  assert.deepEqual(authFailures, []);
  for (const result of [studio, mlx, pending, vllm]) {
    const encoded = JSON.stringify(result);
    for (const forbidden of ['/private/', 'private-vllm-request', 'studio-smoke-key', 'vllm-smoke-key']) {
      assert(!encoded.includes(forbidden), 'Private fixture data crossed the service boundary.');
    }
  }
  assert(runtimeCalls.filter(call => call.runtime !== 'omlx').every(call => call.method === 'GET'));
  await stop(multiService);
  if (process.platform === 'darwin') {
    console.log('PASS: packaged Node service returned real macOS wired, compressed, and swap readings.');
  }
  console.log('PASS: packaged DFlash output and fallback transition use reported counters without inventing speed or prefill.');
  console.log('PASS: packaged prefill counters and invalid-progress rejection verified against loopback fixture.');
  console.log('PASS: packaged LM Studio, mlx-lm, and vllm-mlx adapters preserve credentials, telemetry boundaries, and output freshness with synthetic fixtures.');
  console.log('PASS: packaged Node service starts without node_modules; /health, /snapshot, JSONC, authentication, startup errors, and shutdown verified.');
} finally {
  await Promise.all(children.map(stop));
  if (mockRuntime) { mockRuntime.closeAllConnections(); await new Promise(resolveClose => mockRuntime.close(resolveClose)); }
  await rm(home, { recursive: true, force: true });
}

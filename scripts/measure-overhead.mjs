import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { arch, cpus, platform, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Development measurement only. This script never connects to the real runtime.
const seconds = Number(process.argv[2] ?? 30);
assert(Number.isInteger(seconds) && seconds >= 10 && seconds <= 60, 'Duration must be 10–60 seconds per phase.');
assert(['darwin', 'linux'].includes(platform()), 'This measurement uses macOS/Linux ps.');
const serviceFile = resolve(process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), '../service/main.js'));
const sandbox = await mkdtemp(join(tmpdir(), 'mlx-scope-overhead-'));
const token = randomBytes(24).toString('hex');
let child;
let closed;
let stderr = '';
let running = true;
let active = true;
let runtimeRequests = {};
const began = performance.now();
const runtime = createServer((request, response) => {
  request.resume();
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  runtimeRequests[path] = (runtimeRequests[path] ?? 0) + 1;
  const body = path === '/health' ? { status: 'healthy', engine_pool: { model_count: 1 } }
    : path === '/v1/models/status' ? { models: [] }
    : path === '/admin/api/stats' || path === '/admin/api/activity' ? {
      engines: {}, active_models: { models: [{ id: 'synthetic-model', active_requests: active ? 1 : 0,
        activities: active ? [{ request_id: 'synthetic-request', kind: 'generate', detail: 'generating',
          token_count: Math.floor((performance.now() - began) / 1000 * 32), last_activity_age_seconds: 0.1 }] : [] }] },
    } : null;
  response.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body ?? { error: 'not_found' }));
});
const listen = server => new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolveListen(server.address().port));
});

function processReading() {
  const result = spawnSync('ps', ['-p', String(child.pid), '-o', 'time=', '-o', 'rss='], {
    encoding: 'utf8', timeout: 2_000, maxBuffer: 4_096,
  });
  assert.equal(result.status, 0, 'Could not read the measured service process.');
  const values = result.stdout.trim().split(/\s+/);
  assert.equal(values.length, 2, 'Unexpected ps response.');
  const [dayPrefix, clock] = values[0].includes('-') ? values[0].split('-') : ['0', values[0]];
  const cpuSeconds = Number(dayPrefix) * 86400 + clock.split(':').reverse().reduce((total, value, index) => total + Number(value) * 60 ** index, 0);
  const rssMiB = Number(values[1]) / 1024;
  assert(Number.isFinite(cpuSeconds) && Number.isFinite(rssMiB), 'Invalid process measurement.');
  return { cpuSeconds, rssMiB, at: performance.now() };
}

try {
  const runtimePort = await listen(runtime);
  const probe = createServer();
  const servicePort = await listen(probe);
  await new Promise(resolveClose => probe.close(resolveClose));
  child = spawn(process.execPath, [serviceFile], {
    cwd: sandbox, stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '', HOME: sandbox,
      XDG_CONFIG_HOME: join(sandbox, 'config'), XDG_DATA_HOME: join(sandbox, 'data'),
      TMPDIR: sandbox, TMP: sandbox, TEMP: sandbox,
      OPENCHAMBER_SERVICE_PORT: String(servicePort), OPENCHAMBER_SERVICE_TOKEN: token,
      MLX_SCOPE_BASE_URL: `http://127.0.0.1:${runtimePort}`,
    },
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8_192); });
  closed = new Promise(resolveClose => {
    child.once('error', error => { stderr = String(error); });
    child.once('close', () => { running = false; resolveClose(); });
  });
  const get = async path => {
    assert(running, `Service stopped unexpectedly: ${stderr}`);
    const response = await fetch(`http://127.0.0.1:${servicePort}${path}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4_000),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  let ready = false;
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    try { ready = (await get('/health')).status === 'healthy'; if (ready) break; } catch {}
    await delay(50);
  }
  assert(ready, `Service did not become ready: ${stderr}`);
  const warmup = performance.now() + 5_000;
  while (performance.now() < warmup) {
    assert.equal((await get('/snapshot')).available, true);
    await delay(500);
  }
  const phases = [];
  for (const phase of ['active', 'idle', 'paused']) {
    active = phase === 'active';
    // One transition read keeps the preceding phase out of the measurement.
    if (phase !== 'paused') { assert.equal((await get('/snapshot')).available, true); await delay(500); }
    runtimeRequests = {};
    const readings = [processReading()];
    const start = performance.now();
    const until = start + seconds * 1000;
    const interval = phase === 'active' ? 500 : 2_000;
    let nextPoll = start;
    let nextResource = start + 2_000;
    const latencies = [];
    while (performance.now() < until) {
      const now = performance.now();
      if (phase !== 'paused' && now >= nextPoll) {
        const requestStart = performance.now();
        assert.equal((await get('/snapshot')).available, true);
        latencies.push(performance.now() - requestStart);
        nextPoll = performance.now() + interval;
      }
      if (performance.now() >= nextResource) { readings.push(processReading()); nextResource = performance.now() + 2_000; }
      await delay(Math.max(1, Math.min(until - performance.now(), nextResource - performance.now(), phase === 'paused' ? Infinity : nextPoll - performance.now())));
    }
    readings.push(processReading());
    const first = readings[0], last = readings.at(-1);
    const wallSeconds = (last.at - first.at) / 1000;
    const ordered = [...latencies].sort((a, b) => a - b);
    if (phase === 'paused') assert.equal(Object.values(runtimeRequests).reduce((sum, count) => sum + count, 0), 0, 'Paused service made autonomous runtime requests.');
    phases.push({
      phase, wallSeconds: Number(wallSeconds.toFixed(3)), requestedCadenceMs: phase === 'paused' ? null : interval,
      serviceCPUPercentOfOneCore: Number(((last.cpuSeconds - first.cpuSeconds) / wallSeconds * 100).toFixed(3)),
      sampledRSSMiB: { first: Number(first.rssMiB.toFixed(2)), last: Number(last.rssMiB.toFixed(2)), peak: Number(Math.max(...readings.map(reading => reading.rssMiB)).toFixed(2)), samples: readings.length },
      snapshotRequests: latencies.length,
      snapshotLatencyMs: latencies.length ? { mean: Number((latencies.reduce((sum, n) => sum + n, 0) / latencies.length).toFixed(2)), p95: Number(ordered[Math.ceil(ordered.length * 0.95) - 1].toFixed(2)) } : null,
      runtimeRequests,
    });
  }
  console.log(JSON.stringify({
    measurement: 'MLX Scope service-only synthetic observation',
    recordedAt: new Date().toISOString(), node: process.version,
    host: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model ?? null, logicalCores: cpus().length },
    warmupSeconds: 5, requestedSecondsPerPhase: seconds,
    limitations: [
      'Synthetic loopback responses; no inference was started or measured.',
      'CPU is cumulative service-process time divided by wall time, relative to one core; excludes diagnostic child-process CPU.',
      'ps CPU-time resolution is platform-dependent; very small differences may round to zero.',
      'RSS includes shared pages and reflects sampled peaks only.',
      'Browser rendering, OpenChamber overhead, battery use, and inference throughput impact are not measured.',
    ], phases,
  }, null, 2));
} finally {
  if (child && running) {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2_500);
    try { await closed; } finally { clearTimeout(timer); }
  }
  runtime.closeAllConnections();
  await new Promise(resolveClose => runtime.close(resolveClose));
  await rm(sandbox, { recursive: true, force: true });
}

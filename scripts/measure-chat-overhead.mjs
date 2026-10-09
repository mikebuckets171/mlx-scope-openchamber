// node scripts/measure-chat-overhead.mjs --service /absolute/service.mjs --out /absolute/evidence.json
// Separate service-boundary probe: fake oMLX + a private synthetic companion file; never live inference/configuration.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { cpus, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createFakeRuntime } from './lib/fake-runtimes.mjs';

const { values } = parseArgs({ options: { service: { type: 'string' }, out: { type: 'string' } } });
assert.ok(values.service && values.out, 'Pass --service and --out absolute paths.');
const serviceFile = resolve(values.service), output = resolve(values.out), here = dirname(fileURLToPath(import.meta.url));
const serviceDigest = () => createHash('sha256').update(readFileSync(serviceFile)).digest('hex');
const measuredDigest = serviceDigest();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = (kind, value) => createHash('sha256').update(`mlx-scope-${kind}-v1\0${value}`).digest('hex');
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
async function freePort() { const server = createServer(), port = await listen(server); await new Promise(resolve => server.close(resolve)); return port; }
const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
const percentile = (values, ratio) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * ratio) - 1];
const sameTarget = (left, right) => Object.keys(left).length === Object.keys(right).length
  && Object.entries(left).every(([key, value]) => right[key] === value);
await mkdir(dirname(output), { recursive: true });

async function run(plan) {
  assert.equal(serviceDigest(), measuredDigest, 'Freeze the service bundle before measuring.');
  const chatCount = plan.destinations.length;
  const withChat = chatCount > 0;
  const taskRoot = await mkdtemp(join(dirname(output), '.service-chat-overhead-'));
  const isolatedRoot = join(taskRoot, 'isolated'), telemetry = join(isolatedRoot, '.cache/mlx-scope/chat-telemetry');
  const log = join(taskRoot, 'usage.jsonl'), preload = join(taskRoot, 'isolation.mjs');
  await mkdir(isolatedRoot, { recursive: true });
  // Keep HOME untouched: a measurement-only os.homedir stub gives all service path resolution an isolated root.
  await writeFile(preload, `import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module';
    os.homedir=()=>${JSON.stringify(isolatedRoot)}; syncBuiltinESMExports();`);
  const runtimeCalls = [], runtime = createFakeRuntime('omlx', { active: true, began: Date.now() }, path => runtimeCalls.push({ at: Date.now(), path }));
  let child, writer, writerBusy = false, childPID, childEnded, stderr = '', demandChanges = 0, demandStamp, maxWriterBytes = 0;
  const usage = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  try {
    const runtimePort = await listen(runtime), port = await freePort(), token = randomBytes(24).toString('hex'), writerID = randomUUID();
    const destinations = chatCount ? plan.destinations : ['local'];
    const providers = destinations.map(destination => destination === 'remote' ? 'cloud-fixture' : 'omlx');
    const identities = destinations.map((destination, index) => ({
      sessionKey: digest('session', `ses_fixture_${index}`), modelKey: digest('model', 'synthetic-model'),
      providerKey: digest('provider', providers[index]),
      ...destination === 'remote' ? { destination: 'remote' }
        : { endpointKey: digest('endpoint', `http://127.0.0.1:${runtimePort}`) } }));
    const remoteEndpoint = digest('endpoint', 'https://cloud-fixture.invalid');
    async function updateWriter() {
      if (writerBusy) return; writerBusy = true;
      try {
        const now = Date.now(), file = join(telemetry, `${writerID}.json`), temp = join(telemetry, '.writer.tmp');
        const document = { schemaVersion: 1, writerID, companionVersion: '3.0.0', protocol: 'opencode-2.0.25', runtimeVersion: '2.0.25',
          updatedAtMs: now, expiresAtMs: now + 15_000, entries: identities.map((identity, index) => ({ ...identity,
            ...identity.destination === 'remote' ? { endpointKey: remoteEndpoint } : {}, measurement: {
            scope: 'chat', basis: 'estimated-characters', timingBasis: 'delivery-window', phase: 'generating',
            tokensPerSecond: 42 + index, freshness: 'live', observation: { startedAtMs: now - 5000, endedAtMs: now },
            observedAtMs: now, expiresAtMs: now + 5000 } })) };
        const text = JSON.stringify(document); maxWriterBytes = Math.max(maxWriterBytes, Buffer.byteLength(text));
        await writeFile(temp, text, { mode: 0o600 }); await rename(temp, file);
      } finally { writerBusy = false; }
    }
    if (withChat) {
      await mkdir(telemetry, { recursive: true, mode: 0o700 }); await chmod(telemetry, 0o700);
      await writeFile(join(telemetry, 'heartbeat.json'), JSON.stringify({ schemaVersion: 1, companionVersion: '3.0.0', protocol: 'opencode-2.0.25',
        runtimeVersion: '2.0.25', loadedAtMs: Date.now(), supported: true }), { mode: 0o600 });
      await updateWriter(); writer = setInterval(() => void updateWriter(), 200);
    }
    const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: isolatedRoot,
      XDG_CONFIG_HOME: join(isolatedRoot, 'config'), XDG_DATA_HOME: join(isolatedRoot, 'data'),
      OPENCHAMBER_SERVICE_PORT: String(port), OPENCHAMBER_SERVICE_TOKEN: token,
      MLX_SCOPE_BASE_URL: `http://127.0.0.1:${runtimePort}`, MLX_SCOPE_MEASURE_LOG: log };
    const args = ['--import', pathToFileURL(preload).href, '--import', pathToFileURL(join(here, 'lib/spawn-log-preload.mjs')).href, serviceFile];
    child = spawn(process.execPath, args, { cwd: isolatedRoot, env, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    childEnded = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    for (let i = 0; i < 250 && !childPID; i++) { childPID = usage().find(record => record.kind === 'start')?.pid; if (!childPID) await pause(20); }
    assert.ok(childPID, 'isolated service starts');
    const get = async path => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000) });
      assert.equal(response.status, 200, `response status for ${path}`); return response.json();
    };
    for (let i = 0; i < 100; i++) { try { if ((await get('/health')).ok) break; } catch {} await pause(50); }
    const probe = async () => {
      const count = usage().filter(record => record.kind === 'usage').length; process.kill(childPID, 'SIGUSR2');
      for (let i = 0; i < 400; i++) { const values = usage().filter(record => record.kind === 'usage'); if (values.length > count) return values.at(-1); await pause(5); }
      throw new Error('Service usage probe timed out');
    };
    const route = (surface, tier, frame, index = 0) => {
      const identity = identities[index];
      const suffix = withChat ? `&chat=${identity.sessionKey}&chatModel=${identity.modelKey}&chatBusy=1` : '';
      // Remote views deliberately omit chatOnly: exercise production config-only classification on the first poll.
      return `/v2/snapshot?frame=${frame}&surface=${surface}&tier=${tier}&provider=${providers[index]}${suffix}`;
    };
    const full = route('panel', 'full', '1234abcd'), glance = route('status', 'glance', '4321dcba');
    let matched = 0;
    const poll = async (duration, interval, path, index = 0) => {
      const latencies = [], until = performance.now() + duration;
      while (performance.now() < until) {
        const at = performance.now(), snapshot = await get(path);
        assert.equal(snapshot.status.state, 'ready'); assert.equal(snapshot.connection.id, providers[index]);
        if (destinations[index] === 'remote') {
          assert.equal(snapshot.connection.runtime, null); assert.equal(snapshot.host, null);
          assert.deepEqual(snapshot.capabilities, {}); assert.deepEqual(snapshot.completions.items, []);
          assert.deepEqual(snapshot.alerts, []); assert.deepEqual(snapshot.alertLog, []); assert.equal(snapshot.marksHead, 0);
          assert.equal(snapshot.runtime.request, null); assert.equal(snapshot.runtime.phase, 'unknown');
          assert.deepEqual(snapshot.runtime.memory, {}); assert.deepEqual(snapshot.runtime.residency, []);
        }
        if (withChat) {
          assert.equal(snapshot.chat?.tokensPerSecond, 42 + index, 'fresh private writer is returned on every poll');
          assert.equal(snapshot.chat?.scope, 'chat'); assert.equal(snapshot.chat?.basis, 'estimated-characters');
          assert.ok(snapshot.chat.observedAtMs <= snapshot.serverNow, 'response clock includes asynchronously read chat observation'); matched++;
          const info = await stat(join(telemetry, 'demand.json'));
          if (info.mtimeMs !== demandStamp) { demandStamp = info.mtimeMs; demandChanges++; }
          const document = JSON.parse(await readFile(join(telemetry, 'demand.json'), 'utf8'));
          assert.equal(document.schemaVersion, 1); assert.ok(document.expiresAtMs > Date.now());
          assert.ok(document.expiresAtMs - document.updatedAtMs <= 15_000);
          assert.ok(document.watched.some(target => sameTarget(target, identities[index])), 'demand includes this chat');
          assert.ok(document.watched.length <= chatCount, 'demand stays bounded by visible chats');
          assert.ok(document.watched.every(target => identities.some(identity => sameTarget(target, identity))), 'demand includes only known chats');
          assert.equal(info.mode & 0o777, 0o600);
          assert.ok(snapshot.nextPollMs <= (path.includes('surface=status') ? 1000 : 500), 'fresh visible chat keeps active presentation cadence');
        } else assert.equal(snapshot.chat, undefined);
        latencies.push(performance.now() - at);
        await pause(Math.max(1, Math.min(interval - (performance.now() - at), until - performance.now())));
      }
      return { polls: latencies.length, meanLatencyMs: mean(latencies), p95LatencyMs: percentile(latencies, .95) };
    };
    // Exclude initial heap trim and first-use runtime/host discovery in both conditions.
    await pause(15_000); await poll(5000, 500, full);
    const phase = async (name, duration, interval, path) => {
      const start = await probe(), requests = runtimeCalls.length, demands = demandChanges, result = await poll(duration, interval, path), end = await probe();
      const cpu = (end.cpuMicros - start.cpuMicros) / (end.at - start.at) / 10;
      const children = usage().filter(record => record.kind === 'spawn' && record.at >= start.at && record.at <= end.at);
      return { name, pollMs: interval, ...result, serviceCPUPercentOneCore: cpu, wallMs: end.at - start.at,
        serviceCPUms: (end.cpuMicros - start.cpuMicros) / 1000, serviceRSSMiBAtEdges: [start.rssBytes, end.rssBytes].map(n => n / 1048576),
        runtimeRequests: runtimeCalls.length - requests, demandChanges: demandChanges - demands,
        spawns: children.reduce((total, record) => ({ ...total, [record.file]: (total[record.file] ?? 0) + 1 }), {}) };
    };
    const active = await phase('full', 15_000, 500, full);
    await get(glance); await pause(1000);
    const status = await phase('glance', 15_000, 1000, glance);
    let simultaneous;
    if (chatCount > 1) {
      const second = route('page', 'full', 'aabbccdd', 1);
      await get(second); await pause(1000);
      const start = await probe(), requests = runtimeCalls.length, demands = demandChanges;
      const views = await Promise.all([poll(20_000, 1000, glance, 0), poll(20_000, 500, second, 1)]);
      const end = await probe(), document = JSON.parse(await readFile(join(telemetry, 'demand.json'), 'utf8'));
      assert.equal(document.watched.length, chatCount, 'shared demand includes both simultaneous chats');
      simultaneous = { name: 'simultaneous', views: [{ surface: 'status', pollMs: 1000, ...views[0] },
        { surface: 'page', pollMs: 500, ...views[1] }], serviceCPUPercentOneCore: (end.cpuMicros - start.cpuMicros) / (end.at - start.at) / 10,
        wallMs: end.at - start.at, serviceRSSMiBAtEdges: [start.rssBytes, end.rssBytes].map(n => n / 1048576),
        runtimeRequests: runtimeCalls.length - requests, demandChanges: demandChanges - demands, watchedChats: document.watched.length };
    }
    clearInterval(writer); while (writerBusy) await pause(5);
    const hiddenStart = await probe(), callsBefore = runtimeCalls.length;
    const demandBefore = withChat ? await stat(join(telemetry, 'demand.json')) : null;
    await pause(17_000); const hiddenEnd = await probe();
    assert.equal(runtimeCalls.length, callsBefore, 'hidden service makes no runtime calls');
    if (withChat) {
      const demandAfter = await stat(join(telemetry, 'demand.json')), document = JSON.parse(await readFile(join(telemetry, 'demand.json'), 'utf8'));
      assert.equal(demandAfter.mtimeMs, demandBefore.mtimeMs, 'hidden service renews no demand'); assert.ok(document.expiresAtMs <= Date.now());
    }
    const hidden = { wallMs: hiddenEnd.at - hiddenStart.at, runtimeRequests: runtimeCalls.length - callsBefore,
      serviceCPUPercentOneCore: (hiddenEnd.cpuMicros - hiddenStart.cpuMicros) / (hiddenEnd.at - hiddenStart.at) / 10,
      demandExpiredWithoutRenewal: withChat, serviceRSSMiBAtEdges: [hiddenStart.rssBytes, hiddenEnd.rssBytes].map(n => n / 1048576) };
    const limits = { fullServiceCPUPercent: 1.9, glanceServiceCPUPercent: .68, serviceRSSMiB: 132 };
    const checks = { fullServiceCPU: active.serviceCPUPercentOneCore <= limits.fullServiceCPUPercent,
      glanceServiceCPU: status.serviceCPUPercentOneCore <= limits.glanceServiceCPUPercent,
      serviceRSS: Math.max(...active.serviceRSSMiBAtEdges, ...status.serviceRSSMiBAtEdges, ...hidden.serviceRSSMiBAtEdges,
        ...simultaneous?.serviceRSSMiBAtEdges ?? []) <= limits.serviceRSSMiB,
      hiddenRuntimeRequests: hidden.runtimeRequests === 0,
      ...simultaneous ? { simultaneousServiceCPU: simultaneous.serviceCPUPercentOneCore <= limits.fullServiceCPUPercent } : {},
      ...destinations.every(destination => destination === 'remote') ? {
        remoteOnlyRuntimeRequests: runtimeCalls.length === 0,
        remoteOnlyCollectorSpawns: usage().filter(record => record.kind === 'spawn').length === 0 } : {} };
    const record = { name: plan.name, destinations: plan.destinations, withChat, chatCount, active, glance: status, hidden,
      ...simultaneous ? { simultaneous } : {},
      matchedPolls: matched, maxWriterBytes, limits, checks,
      attribution: 'service process only; child spawn counts reported but child CPU is covered by the separate whole-service benchmark' };
    console.log(JSON.stringify(record)); return record;
  } finally {
    clearInterval(writer); while (writerBusy) await pause(5);
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM'); await Promise.race([childEnded, pause(2500)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await childEnded; }
    }
    runtime.closeAllConnections(); await new Promise(resolve => runtime.close(resolve));
    await rm(taskRoot, { recursive: true, force: true });
  }
}
const runs = [];
const plans = [{ name: 'zero-chat', destinations: [] }, { name: 'one-local', destinations: ['local'] },
  { name: 'two-local', destinations: ['local', 'local'] }, { name: 'one-remote', destinations: ['remote'] },
  { name: 'two-remote', destinations: ['remote', 'remote'] }, { name: 'local-and-remote', destinations: ['local', 'remote'] }];
for (const plan of plans) {
  runs.push(await run(plan));
  assert.equal(serviceDigest(), measuredDigest, 'Service changed during measurement; repeat with a frozen build.');
  await writeFile(output, JSON.stringify({ recordedAt: new Date().toISOString(), environment: { node: process.version, platform: platform(), release: release(), cpu: cpus()[0]?.model },
    serviceSha256: measuredDigest,
    method: 'same immutable Node service binary, isolated roots, loopback fake oMLX; zero chats, one/two local, one/two remote and mixed local/remote chats from one private writer refreshed at 200ms; remote classification uses configuration metadata on the first poll and proves no runtime/host/history readings or collector spawns; 500ms full and 1000ms glance polling; two-chat cases add concurrent 500ms page and 1000ms status polling; 17s hidden lease expiry; no real inference or cloud requests',
    pass: runs.every(run => Object.values(run.checks).every(Boolean)), runs }, null, 2));
}
if (!runs.every(run => Object.values(run.checks).every(Boolean))) process.exitCode = 1;

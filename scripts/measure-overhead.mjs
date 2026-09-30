import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { lstat, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { arch, cpus, homedir, platform, release, tmpdir, totalmem } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { FAKE_RUNTIMES, createFakeRuntime, installFakeLMStudio } from './lib/fake-runtimes.mjs';

// Development measurement only. The measured service reads loopback fake runtimes; no real runtime or lms is used.
// Usage: node scripts/measure-overhead.mjs [--runtime all|omlx|lmstudio] [--cold s] [--active s] [--idle s] [--tail s]
//   [--service file] [--out receipt.json] [--<budget> value …]. Legacy form: [seconds per phase] [service file].
// Budgets come from docs/2.0/SPIKES.md S13; CPU is % of one core over the service and all of its descendants.
const BUDGETS = {
  'no-view-cpu': 0.07, 'idle-cpu': 0.68, 'active-cpu': 1.9, 'active-cpu-max': 3,
  'rss-mib': 132, 'idle-spawns': 24, 'active-spawns': 36, 'children-gone-s': 65,
};
const SAMPLE_MS = 500, BUCKET_S = 5, QUIET_AFTER_S = 60;
const here = dirname(fileURLToPath(import.meta.url));
const { values: flags, positionals } = parseArgs({ allowPositionals: true, options: {
  runtime: { type: 'string', default: 'all' }, cold: { type: 'string', default: '30' }, active: { type: 'string' },
  idle: { type: 'string' }, tail: { type: 'string', default: '75' }, service: { type: 'string' }, out: { type: 'string' },
  ...Object.fromEntries(Object.keys(BUDGETS).map(name => [name, { type: 'string' }])),
} });
const number = (name, value, min, max) => {
  const parsed = Number(value);
  assert(Number.isFinite(parsed) && parsed >= min && parsed <= max, `--${name} must be ${min}–${max}.`);
  return parsed;
};
const seconds = {
  settle: 15, cold: number('cold', flags.cold, 10, 600), warmup: 5,
  active: number('active', flags.active ?? positionals[0] ?? 30, 10, 600),
  idle: number('idle', flags.idle ?? positionals[0] ?? 30, 10, 600),
  paused: number('tail', flags.tail, 70, 600),
};
const budgets = Object.fromEntries(Object.entries(BUDGETS).map(([name, value]) => [name, number(name, flags[name] ?? value, 0, 1e6)]));
const runtimes = flags.runtime === 'all' ? FAKE_RUNTIMES : [flags.runtime];
assert(runtimes.every(kind => FAKE_RUNTIMES.includes(kind)), `--runtime must be all or one of ${FAKE_RUNTIMES.join(', ')}.`);
assert(['darwin', 'linux'].includes(platform()), 'This measurement uses macOS/Linux ps.');
const serviceFile = resolve(flags.service ?? positionals[1] ?? join(here, '../service/main.js'));
const preload = pathToFileURL(join(here, 'lib/spawn-log-preload.mjs')).href;
const timeWrapper = platform() === 'darwin' && existsSync('/usr/bin/time');

const round = (value, digits = 3) => value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
const listen = server => new Promise((ok, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => ok(server.address().port));
});
const freePort = async () => {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise(ok => probe.close(ok));
  return port;
};
const cpuSeconds = text => {
  const [days, clock] = text.includes('-') ? text.split('-') : ['0', text];
  return Number(days) * 86_400 + clock.split(':').reverse().reduce((sum, part, index) => sum + Number(part) * 60 ** index, 0);
};
const psTable = () => new Promise(ok => execFile('ps', ['-A', '-o', 'pid=,ppid=,time=,rss=,comm='],
  { encoding: 'utf8', timeout: 3_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => ok(error ? null : stdout)));
/** One `ps -A` table → the measured service row and every live descendant (children, grandchildren, …). */
const processTree = (table, root) => {
  const rows = new Map(), children = new Map();
  for (const line of table.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const row = { pid: Number(match[1]), ppid: Number(match[2]), cpu: cpuSeconds(match[3]), rssKiB: Number(match[4]), comm: basename(match[5].trim()) };
    rows.set(row.pid, row);
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row);
  }
  const descendants = [], stack = [...(children.get(root) ?? [])];
  while (stack.length) { const row = stack.pop(); descendants.push(row); stack.push(...(children.get(row.pid) ?? [])); }
  return { service: rows.get(root) ?? null, descendants, rows };
};
/** Every file and folder under `root` with its size and mtime, to prove the service wrote nothing there. */
const listing = async (root, entries = new Map(), dir = root) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name), info = await lstat(path);
    entries.set(relative(root, path), `${info.size}:${info.mtimeMs}`);
    if (entry.isDirectory()) await listing(root, entries, path);
  }
  return entries;
};
const rusage = text => {
  const value = pattern => { const match = pattern.exec(text); return match ? Number(match[1]) : null; };
  const user = value(/([\d.]+)\s+user/), sys = value(/([\d.]+)\s+sys/);
  return user === null || sys === null ? null : { cpuSeconds: user + sys, maxRssBytes: value(/(\d+)\s+maximum resident set size/) };
};

async function measure(kind) {
  const sandbox = await mkdtemp(join(tmpdir(), 'mlx-scope-overhead-home-'));
  const scratch = await mkdtemp(join(tmpdir(), 'mlx-scope-overhead-log-'));
  const log = join(scratch, 'service.jsonl'), lmsLog = join(scratch, 'lms.log');
  const state = { active: true, began: Date.now() };
  const requests = [], readings = [];
  const runtime = createFakeRuntime(kind, state, path => requests.push({ at: Date.now(), path }));
  let child, closed, running = true, stderr = '', servicePid = null, sampling = false, sampler = null, lastRead = null;
  const records = () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').slice(0, -1).map(line => JSON.parse(line)) : [];
  try {
    const runtimePort = await listen(runtime);
    const servicePort = await freePort();
    if (kind === 'lmstudio') await installFakeLMStudio(sandbox, runtimePort, lmsLog);
    const before = await listing(sandbox);
    const token = randomBytes(24).toString('hex');
    const env = {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: sandbox,
      XDG_CONFIG_HOME: join(sandbox, 'config'), XDG_DATA_HOME: join(sandbox, 'data'),
      TMPDIR: sandbox, TMP: sandbox, TEMP: sandbox,
      OPENCHAMBER_SERVICE_PORT: String(servicePort), OPENCHAMBER_SERVICE_TOKEN: token,
      MLX_SCOPE_BASE_URL: `http://127.0.0.1:${runtimePort}`, MLX_SCOPE_MEASURE_LOG: log,
      ...(kind === 'lmstudio' ? { MLX_SCOPE_RUNTIME: 'lmstudio' } : {}),
    };
    const argv = [process.execPath, '--import', preload, serviceFile];
    // /usr/bin/time -l adds the whole-run rusage of the service and every child it reaped.
    child = spawn(timeWrapper ? '/usr/bin/time' : argv[0], timeWrapper ? ['-l', ...argv] : argv.slice(1),
      { cwd: sandbox, stdio: ['ignore', 'ignore', 'pipe'], env });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16_384); });
    closed = new Promise(ok => {
      child.once('error', error => { stderr = String(error); });
      child.once('close', () => { running = false; ok(); });
    });
    for (let tries = 0; tries < 250 && servicePid === null && running; tries += 1) {
      servicePid = records().find(record => record.kind === 'start')?.pid ?? null;
      if (servicePid === null) await delay(20);
    }
    assert(servicePid !== null, `Service did not start: ${stderr}`);
    sampling = true;
    sampler = (async () => {
      while (sampling) {
        const at = Date.now(), table = await psTable();
        if (table) { const { service, descendants } = processTree(table, servicePid); readings.push({ at, service, descendants }); }
        await delay(Math.max(0, SAMPLE_MS - (Date.now() - at)));
      }
    })();
    const get = async path => {
      assert(running, `Service stopped unexpectedly: ${stderr}`);
      const response = await fetch(`http://127.0.0.1:${servicePort}${path}`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4_000),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    /** The service's own CPU time (µs) and RSS, read in-process at a phase edge. */
    const probe = async () => {
      const seen = records().filter(record => record.kind === 'usage').length;
      process.kill(servicePid, 'SIGUSR2');
      for (let tries = 0; tries < 400; tries += 1) {
        const usage = records().filter(record => record.kind === 'usage');
        if (usage.length > seen) return usage.at(-1);
        await delay(5);
      }
      throw new Error('The service did not report its CPU time.');
    };
    const poll = async (duration, interval) => {
      const until = performance.now() + duration * 1000, latencies = [];
      while (performance.now() < until) {
        const start = performance.now();
        assert.equal((await get('/v2/snapshot')).status.state, 'ready');
        latencies.push(performance.now() - start);
        lastRead = Date.now();
        await delay(Math.max(1, Math.min(interval - (performance.now() - start), until - performance.now())));
      }
      const ordered = [...latencies].sort((a, b) => a - b);
      return { requests: latencies.length, meanMs: round(latencies.reduce((sum, n) => sum + n, 0) / latencies.length, 2),
        p95Ms: round(ordered[Math.ceil(ordered.length * 0.95) - 1], 2) };
    };
    let ready = false;
    for (const deadline = performance.now() + 5_000; !ready && performance.now() < deadline;) {
      try { ready = (await get('/health')).ok === true; } catch {}
      if (!ready) await delay(50);
    }
    assert(ready, `Service did not become ready: ${stderr}`);
    // V8 trims the fresh heap once, about 8 s after startup; that one-off cost is reported apart from the no-view rate.
    const edges = { settle: await probe() };
    await delay(seconds.settle * 1000);
    edges.noView = await probe();
    await delay(seconds.cold * 1000);
    edges.noViewEnd = await probe();
    await poll(seconds.warmup, 500);
    edges.active = await probe();
    const activeLatency = await poll(seconds.active, 500);
    edges.activeEnd = await probe();
    // One transition read keeps the active runtime state out of the idle measurement.
    state.active = false;
    assert.equal((await get('/v2/snapshot')).status.state, 'ready');
    await delay(500);
    edges.idle = await probe();
    const idleLatency = await poll(seconds.idle, 2_000), lastRequestAt = lastRead;
    edges.idleEnd = edges.paused = await probe();
    await delay(seconds.paused * 1000);
    edges.pausedEnd = await probe();
    sampling = false;
    await sampler;
    const changed = [...(await listing(sandbox))].filter(([path, value]) => before.get(path) !== value).map(([path]) => path);
    process.kill(servicePid, 'SIGTERM');
    const timer = setTimeout(() => { try { process.kill(servicePid, 'SIGKILL'); } catch {} }, 2_500);
    try { await closed; } finally { clearTimeout(timer); }
    if (changed.length) console.error(`${kind}: the service wrote to its sandbox HOME: ${changed.slice(0, 10).join(', ')}`);
    return summarize(kind, { records: records(), readings, requests, edges, lastRequestAt, activeLatency, idleLatency,
      changed: changed.length, whole: timeWrapper ? rusage(stderr) : null, lmsLog: existsSync(lmsLog) ? readFileSync(lmsLog, 'utf8') : '' });
  } finally {
    sampling = false;
    await sampler;
    const leftover = readings.at(-1)?.descendants ?? [];
    if (running && child) {
      try { process.kill(servicePid ?? child.pid, 'SIGTERM'); } catch {}
      const timer = setTimeout(() => { try { process.kill(servicePid ?? child.pid, 'SIGKILL'); } catch {} }, 2_500);
      try { await closed; } finally { clearTimeout(timer); }
    }
    // Only the measured service's own (fake) children, if its shutdown left any behind and they are still the same process.
    const alive = leftover.length ? processTree(await psTable() ?? '', -1) : null;
    for (const row of leftover) {
      if (alive?.rows.get(row.pid)?.comm === row.comm) { try { process.kill(row.pid, 'SIGKILL'); } catch {} }
    }
    runtime.closeAllConnections();
    await new Promise(ok => runtime.close(ok));
    await rm(sandbox, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
}

function summarize(kind, run) {
  const spawns = run.records.filter(record => record.kind === 'spawn');
  const exits = new Map(run.records.filter(record => record.kind === 'exit').map(record => [record.id, record]));
  const final = run.records.find(record => record.kind === 'final');
  const seenCpu = new Map();
  for (const reading of run.readings) for (const row of reading.descendants) seenCpu.set(row.pid, Math.max(seenCpu.get(row.pid) ?? 0, row.cpu));
  // Children too short-lived for ps share the whole-run rusage left after the service and the children ps saw.
  const unseen = spawns.filter(record => record.pid === null || !seenCpu.has(record.pid));
  const reaped = run.whole && final
    ? Math.max(0, run.whole.cpuSeconds - final.cpuMicros / 1e6 - [...seenCpu.values()].reduce((sum, n) => sum + n, 0)) : null;
  const perUnseenSpawn = reaped === null ? null : unseen.length ? reaped / unseen.length : 0;

  const phase = (from, to, extra = {}) => {
    const wall = (to.at - from.at) / 1000;
    const inside = run.readings.filter(reading => reading.at >= from.at && reading.at <= to.at && reading.service);
    const baseline = new Map((inside[0]?.descendants ?? []).map(row => [row.pid, row.cpu]));
    const last = new Map(), kinds = {};
    let childRss = 0, treeRss = 0;
    for (const reading of inside) {
      const sum = reading.descendants.reduce((total, row) => total + row.rssKiB, 0);
      childRss = Math.max(childRss, sum);
      treeRss = Math.max(treeRss, sum + reading.service.rssKiB);
      for (const row of reading.descendants) {
        last.set(row.pid, row.cpu);
        kinds[row.comm] = Math.max(kinds[row.comm] ?? 0, round(row.rssKiB / 1024, 1));
      }
    }
    const childSeen = [...last].reduce((sum, [pid, cpu]) => sum + cpu - (baseline.get(pid) ?? 0), 0);
    const ended = unseen.filter(record => { const exit = exits.get(record.id); return exit && exit.at >= from.at && exit.at < to.at; });
    const childReaped = perUnseenSpawn === null ? null : ended.length * perUnseenSpawn;
    const service = (to.cpuMicros - from.cpuMicros) / 1e6;
    const servicePs = inside.length > 1 ? inside.at(-1).service.cpu - inside[0].service.cpu : null;
    const started = spawns.filter(record => record.at >= from.at && record.at < to.at);
    const byFile = {};
    for (const record of started) {
      const entry = byFile[record.file] ??= { count: 0, wallMs: [] };
      entry.count += 1;
      const exit = exits.get(record.id);
      if (exit) entry.wallMs.push(exit.at - record.at);
    }
    for (const entry of Object.values(byFile)) {
      entry.meanWallMs = entry.wallMs.length ? round(entry.wallMs.reduce((sum, n) => sum + n, 0) / entry.wallMs.length, 1) : null;
      entry.running = entry.count - entry.wallMs.length;
      delete entry.wallMs;
    }
    const inWindow = run.requests.filter(request => request.at >= from.at && request.at < to.at);
    const byPath = {};
    for (const request of inWindow) byPath[request.path] = (byPath[request.path] ?? 0) + 1;
    const rss = inside.map(reading => reading.service.rssKiB / 1024);
    const total = service + childSeen + (childReaped ?? 0);
    return {
      wallSeconds: round(wall, 2), psSamples: inside.length,
      cpu: {
        totalPercent: round(total / wall * 100), servicePercent: round(service / wall * 100),
        childPercent: round((childSeen + (childReaped ?? 0)) / wall * 100),
        seconds: { service: round(service, 4), servicePs: round(servicePs, 2), childrenSeenByPs: round(childSeen, 2), childrenReapedEstimate: round(childReaped, 4) },
      },
      serviceRssMiB: rss.length ? { first: round(rss[0], 1), last: round(rss.at(-1), 1), peak: round(Math.max(...rss), 1) } : null,
      peakTreeRssMiB: round(treeRss / 1024, 1),
      children: { distinct: last.size, maxLive: Math.max(0, ...inside.map(reading => reading.descendants.length)), peakRssMiBByKind: kinds, peakSummedRssMiB: round(childRss / 1024, 1) },
      spawns: { total: started.length, perMinute: round(started.length / wall * 60, 2), byFile },
      runtimeRequests: { total: inWindow.length, perSecond: round(inWindow.length / wall, 2), byPath },
      ...extra,
    };
  };

  const { edges, lastRequestAt } = run;
  const phases = {
    noView: phase(edges.noView, edges.noViewEnd),
    active: phase(edges.active, edges.activeEnd, { pollMs: 500, snapshotLatency: run.activeLatency }),
    idle: phase(edges.idle, edges.idleEnd, { pollMs: 2_000, snapshotLatency: run.idleLatency }),
    paused: phase(edges.paused, edges.pausedEnd),
  };
  const after = at => at - lastRequestAt;
  const tailReadings = run.readings.filter(reading => reading.at >= lastRequestAt);
  const buckets = [];
  for (let start = 0; start + BUCKET_S <= seconds.paused; start += BUCKET_S) {
    const inBucket = at => after(at) >= start * 1000 && after(at) < (start + BUCKET_S) * 1000;
    const bucketReadings = tailReadings.filter(reading => inBucket(reading.at) && reading.service);
    buckets.push({ fromS: start, toS: start + BUCKET_S,
      runtimeRequests: run.requests.filter(request => inBucket(request.at)).length,
      spawns: spawns.filter(record => inBucket(record.at)).length,
      maxLiveChildren: Math.max(0, ...bucketReadings.map(reading => reading.descendants.length)),
      serviceCpuSecondsPs: bucketReadings.length > 1 ? round(bucketReadings.at(-1).service.cpu - bucketReadings[0].service.cpu, 2) : null });
  }
  const lastSeen = tailReadings.findLast(reading => reading.descendants.length > 0);
  const tailExits = [...exits.values()].filter(exit => exit.at >= lastRequestAt);
  const open = spawns.filter(record => !exits.has(record.id)).length;
  const goneMs = Math.max(0, lastSeen ? after(lastSeen.at) : 0, ...tailExits.map(exit => after(exit.at)));
  const paused = {
    runtimeRequests: run.requests.filter(request => request.at >= lastRequestAt).length,
    spawns: spawns.filter(record => record.at >= lastRequestAt).length,
    spawnsAfterQuietS: spawns.filter(record => after(record.at) >= QUIET_AFTER_S * 1000).length,
    lastChildSeenAfterMs: lastSeen ? after(lastSeen.at) : null,
    lastChildExitAfterMs: tailExits.length ? Math.max(...tailExits.map(exit => after(exit.at))) : null,
    childrenGoneSeconds: round(goneMs / 1000, 1),
    childrenAtEnd: (tailReadings.at(-1)?.descendants.length ?? 0) + open,
    buckets,
  };
  const lmsSpawns = spawns.filter(record => record.file === 'lms');
  const lmsCalls = run.lmsLog.split('\n').filter(Boolean);
  const lms = kind === 'lmstudio' ? {
    spawns: lmsSpawns.length, fakeInvocations: lmsCalls.length,
    argv: [...new Set(lmsCalls.map(line => line.split('|')[0].replace(/\b\d+\b/g, '<port>')))],
    serverInfoPathSet: lmsCalls.every(line => line.endsWith('|set')),
  } : undefined;
  const peakRss = Math.max(...run.readings.filter(reading => reading.service).map(reading => reading.service.rssKiB / 1024));
  const check = (id, value, limit) => ({ id, value, limit, pass: value !== null && value <= limit });
  const checks = [
    check('noView.cpuPercent', phases.noView.cpu.totalPercent, budgets['no-view-cpu']),
    check('noView.spawns', phases.noView.spawns.total, 0),
    check('noView.runtimeRequests', phases.noView.runtimeRequests.total, 0),
    check('active.cpuPercent', phases.active.cpu.totalPercent, budgets['active-cpu']),
    check('active.cpuPercentAbsolute', phases.active.cpu.totalPercent, budgets['active-cpu-max']),
    check('active.spawnsPerMinute', phases.active.spawns.perMinute, budgets['active-spawns']),
    check('idle.cpuPercent', phases.idle.cpu.totalPercent, budgets['idle-cpu']),
    check('idle.spawnsPerMinute', phases.idle.spawns.perMinute, budgets['idle-spawns']),
    check('service.peakRssMiB', round(peakRss, 1), budgets['rss-mib']),
    check('paused.runtimeRequests', paused.runtimeRequests, 0),
    check(`paused.spawnsAfter${QUIET_AFTER_S}s`, paused.spawnsAfterQuietS, 0),
    check('paused.childrenGoneSeconds', paused.childrenGoneSeconds, budgets['children-gone-s']),
    check('paused.childrenAtEnd', paused.childrenAtEnd, 0),
    check('sandboxHome.filesWritten', run.changed, 0),
    ...(lms ? [check('lms.unverifiedSpawns', Math.abs(lms.spawns - lms.fakeInvocations) + lmsSpawns.filter(record => !record.underHome).length, 0),
      check('lms.withoutServerInfoPath', lms.serverInfoPathSet ? 0 : 1, 0)] : []),
  ];
  return {
    runtime: kind, pass: checks.every(item => item.pass), checks,
    startupSettle: { wallSeconds: round((edges.noView.at - edges.settle.at) / 1000, 2), serviceCpuSeconds: round((edges.noView.cpuMicros - edges.settle.cpuMicros) / 1e6, 4) },
    phases, paused, ...(lms ? { lms } : {}),
    wholeRun: {
      spawnsByFile: spawns.reduce((all, record) => ({ ...all, [record.file]: (all[record.file] ?? 0) + 1 }), {}),
      serviceCpuSeconds: final ? round(final.cpuMicros / 1e6, 4) : null,
      rusageCpuSeconds: round(run.whole?.cpuSeconds ?? null, 2),
      reapedChildCpuSecondsEstimate: round(reaped, 4), childrenUnseenByPs: unseen.length,
      rusageMaxRssMiB: run.whole?.maxRssBytes ? round(run.whole.maxRssBytes / 2 ** 20, 1) : null,
    },
  };
}

const packageFile = join(dirname(serviceFile), '../package.json');
const runs = [];
for (const kind of runtimes) runs.push(await measure(kind));
const receipt = {
  measurement: 'MLX Scope service overhead: service process plus all descendants, synthetic loopback runtimes',
  recordedAt: new Date().toISOString(),
  service: {
    version: existsSync(packageFile) ? JSON.parse(readFileSync(packageFile, 'utf8')).version ?? null : null,
    bundleSha256: createHash('sha256').update(readFileSync(serviceFile)).digest('hex'),
  },
  node: process.version,
  host: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model ?? null, logicalCores: cpus().length, memGiB: Math.round(totalmem() / 2 ** 30) },
  method: {
    psSampleMs: SAMPLE_MS, tailBucketSeconds: BUCKET_S, seconds,
    phases: 'settle: 15 s after the service is ready, no reads (not measured; startup heap trim) · noView: no reads · warmup: 5 s at 500 ms (not measured) · active: 500 ms polls, runtime generating · idle: 2 s polls, runtime idle · paused: no reads',
    cpu: 'Percent of one core. Service: its own cpuUsage() at phase edges (each read costs it about 0.2 ms). Children: ps -A every 500 ms, plus children too short-lived for ps, which share the whole-run wait4 rusage (/usr/bin/time -l) evenly per spawn.',
    spawns: 'Counted in-process by a --import preload that wraps child_process; runtime requests are counted by the fake runtime.',
  },
  budgets,
  pass: runs.every(run => run.pass),
  runs,
  limitations: [
    'Synthetic loopback runtimes; no inference was started or measured.',
    'The fake lms is a shell stand-in that idles like lms log stream; real lms CPU and RSS (docs/2.0/SPIKES.md S8) are not reproduced.',
    'The service runs under Node, not OpenChamber\'s Electron runtime, where RSS reads higher (S13: 89–92 MiB live).',
    'ps CPU time has 10 ms resolution; RSS includes shared pages and is sampled every 500 ms.',
    'Browser rendering, the OpenChamber server, battery use and inference throughput impact are not measured.',
  ],
};
const text = JSON.stringify(receipt, null, 2);
for (const privateText of [tmpdir(), homedir(), '/Users/', serviceFile].filter(item => item.length > 4)) assert(!text.includes(privateText), 'The receipt must not contain local paths.');
if (flags.out) await writeFile(resolve(flags.out), `${text}\n`);
console.log(text);
for (const run of runs) for (const item of run.checks) if (!item.pass) console.error(`FAIL ${run.runtime} ${item.id}: ${item.value} > ${item.limit}`);
if (!receipt.pass) process.exitCode = 1;

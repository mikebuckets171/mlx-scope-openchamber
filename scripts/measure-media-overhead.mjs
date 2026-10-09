// Development-only CPU fixtures. No real inference endpoint, generation, model download or cancellation.
// Measures the frozen production service with LLM + media views, all service descendants, and passive helper work.
// Usage: node scripts/measure-media-overhead.mjs --service /frozen/service/main.js --out receipt.json [--seconds 30]
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { arch, cpus, platform, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { createFakeRuntime } from './lib/fake-runtimes.mjs';

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '..');
const { values: flags } = parseArgs({ options: {
  service: { type: 'string', default: join(root, 'service/main.js') }, out: { type: 'string' },
  seconds: { type: 'string', default: '30' }, 'helper-python': { type: 'string', default: 'python3' },
  'child-rusage-wrapper': { type: 'string' },
} });
const seconds = Number(flags.seconds);
assert(Number.isFinite(seconds) && seconds >= 10 && seconds <= 120, '--seconds must be 10–120.');
assert(['darwin', 'linux'].includes(platform()), 'macOS or Linux required.');
const serviceFile = resolve(flags.service), digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const serviceSha256 = digest(serviceFile), round = (n, digits = 3) => Number(n.toFixed(digits));
const listen = server => new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', () => ok(server.address().port)); });
const close = async server => { server.closeAllConnections(); await new Promise(ok => server.close(ok)); };
const execute = (file, args, options = {}) => new Promise((ok, fail) => execFile(file, args,
  { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024, ...options }, (error, stdout, stderr) => error ? fail(error) : ok({ stdout, stderr })));
const cpuTime = value => {
  const [days, clock] = value.includes('-') ? value.split('-') : ['0', value];
  return Number(days) * 86400 + clock.split(':').reverse().reduce((total, n, i) => total + Number(n) * 60 ** i, 0);
};
const tree = async pid => {
  const { stdout } = await execute('ps', ['-A', '-o', 'pid=,ppid=,time=,rss=,comm=']);
  const rows = stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: +match[1], ppid: +match[2], cpuSeconds: cpuTime(match[3]), rssMiB: +match[4] / 1024, name: basename(match[5].trim()) }] : [];
  });
  const children = [], pending = [pid];
  while (pending.length) {
    const parent = pending.pop();
    for (const row of rows.filter(row => row.ppid === parent)) { children.push(row); pending.push(row.pid); }
  }
  return { at: Date.now(), service: rows.find(row => row.pid === pid), children };
};
const allFiles = async (path, out = []) => {
  for (const item of await readdir(path, { withFileTypes: true })) {
    const file = join(path, item.name); if (item.isDirectory()) await allFiles(file, out); else out.push(file);
  }
  return out;
};

async function measureService() {
  const scratch = await mkdtemp(join(tmpdir(), 'scope-media-receipt-')), home = join(scratch, 'home'), log = join(scratch, 'usage.jsonl');
  await mkdir(home);
  const mediaRequests = [], runtimeRequests = [], samples = [], liveRequests = new Map(), peakRequests = new Map();
  const fixture = { active: true, began: Date.now(), step: 1 };
  const secret = randomBytes(32).toString('hex'), auth = randomBytes(24).toString('hex');
  const fake = createFakeRuntime('omlx', fixture, path => runtimeRequests.push({ at: Date.now(), path }));
  const media = createServer((request, response) => {
    request.resume(); const path = new URL(request.url, 'http://127.0.0.1').pathname;
    assert.equal(request.method, 'GET', 'No mutation is part of a performance measurement.');
    mediaRequests.push({ at: Date.now(), path });
    liveRequests.set(path, (liveRequests.get(path) ?? 0) + 1);
    peakRequests.set(path, Math.max(peakRequests.get(path) ?? 0, liveRequests.get(path)));
    const now = Date.now(), status = fixture.active ? 'in_progress' : 'completed';
    let body;
    if (path === '/system_stats') body = { system: { comfyui_version: '0.38.0' } };
    else if (path === '/api/jobs') body = { jobs: Array.from({ length: 8 }, (_, i) => ({ id: `comfy-${i}`, status: i ? 'completed' : status,
      create_time: fixture.began - 1000, execution_start_time: fixture.began, ...i || !fixture.active ? { execution_end_time: now } : {} })) };
    else if (path === '/mlx-scope/v1/progress') {
      assert.equal(request.headers.authorization, `Bearer ${secret}`);
      body = { schemaVersion: 1, helperVersion: '1.0.0', comfyVersion: '0.38.0', supported: true, observedAtMs: now,
        jobs: fixture.active ? [{ promptId: 'comfy-0', nodeId: '12', phase: 'sampling', progress: { value: fixture.step, total: 100, unit: 'steps' } }] : [] };
    } else if (path === '/mlx-scope/v1/media') {
      assert.equal(request.headers.authorization, `Bearer ${secret}`);
      body = { schemaVersion: 1, producer: 'qwen-image', observedAtMs: now, jobs: [{ jobId: 'qwen-fixture', promptId: 'comfy-0', sessionId: 'fixture-session',
        kind: 'image', state: fixture.active ? 'running' : 'completed', phase: fixture.active ? 'unknown' : 'completed', createdAtMs: fixture.began,
        updatedAtMs: now, canCancel: false }] };
    }
    // A small fixture delay makes overlapping views exercise the in-flight sharing path.
    setTimeout(() => {
      response.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body ?? {}));
      liveRequests.set(path, liveRequests.get(path) - 1);
    }, 12);
  });
  let child, closed, servicePid, sampler, sampling = false, stderr = '', dead = false;
  const records = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  try {
    const runtimePort = await listen(fake), mediaPort = await listen(media);
    const probe = createServer(), servicePort = await listen(probe); await close(probe);
    const config = join(home, '.config/mlx-scope'), video = join(home, '.config/opencode/state/video-queue'), feed = join(config, 'media-feeds');
    await mkdir(config, { recursive: true }); await mkdir(feed, { recursive: true });
    for (const folder of ['running', 'pending', 'done', 'failed', 'cancelled']) await mkdir(join(video, folder), { recursive: true });
    const tokenPath = join(config, 'fixture-token'); await writeFile(tokenPath, secret, { mode: 0o600 });
    await writeFile(join(config, 'media.json'), JSON.stringify({ schemaVersion: 1, sources: [
      { id: 'comfy', kind: 'comfyui', label: 'Fixture ComfyUI', origin: `http://127.0.0.1:${mediaPort}`, helperTokenPath: tokenPath },
      // A separate origin is unnecessary here: explicit private source configuration permits the two independent routes.
      { id: 'qwen', kind: 'qwen-image', label: 'Fixture Qwen', origin: `http://127.0.0.1:${mediaPort}`, tokenPath },
      { id: 'video', kind: 'local-video', label: 'Fixture video', directory: video },
      { id: 'feed', kind: 'feed', label: 'Fixture feed', directory: feed },
    ] }));
    const updateFiles = async () => {
      fixture.step = fixture.step % 99 + 1;
      const now = Date.now();
      await rm(join(video, fixture.active ? 'done' : 'running', 'video-active.json'), { force: true });
      await writeFile(join(video, fixture.active ? 'running' : 'done', 'video-active.json'), JSON.stringify({ id: 'video-active', state: fixture.active ? 'running' : 'done', session_id: 'fixture-session',
        queued_at: new Date(fixture.began - 1000).toISOString(), started_at: new Date(fixture.began).toISOString(),
        ...fixture.active ? {} : { finished_at: new Date(now).toISOString() },
        progress: { phase: 'sampling', completed_units: fixture.step, total_units: 100, unit: 'blocks', observed_at: new Date(now).toISOString() } }));
      for (let i = 0; i < 31; i++) await writeFile(join(video, 'done', `video-${String(i).padStart(2, '0')}.json`), JSON.stringify({ id: `video-${String(i).padStart(2, '0')}`,
        state: 'done', queued_at: new Date(fixture.began - 2000).toISOString(), finished_at: new Date(now).toISOString() }));
      await writeFile(join(feed, 'fixture.json'), JSON.stringify({ schemaVersion: 1, observedAtMs: now, expiresAtMs: now + 30000,
        jobs: Array.from({ length: 32 }, (_, i) => ({ id: `feed-${i}`, sourceId: 'ignored', kind: 'image', name: 'Fixture', state: 'completed', phase: 'completed',
          sampledAtMs: now, observedAtMs: now, finishedAtMs: now, freshness: 'last', progress: null, ownership: {}, cancel: { supported: false } })) }), { mode: 0o600 });
      await chmod(join(feed, 'fixture.json'), 0o600);
    };
    await updateFiles(); const allowedFiles = new Set(await allFiles(home)); allowedFiles.add(join(video, 'done', 'video-active.json'));
    const exactLog = join(scratch, 'children.jsonl'), wrapperImports = [];
    if (flags['child-rusage-wrapper']) {
      const wrapperFile = resolve(flags['child-rusage-wrapper']), preload = join(scratch, 'exact-children.mjs');
      assert(existsSync(wrapperFile), 'Missing measurement-only child wrapper.');
      // Load before the existing logger so it records the original command and the wrapper PID.
      await writeFile(preload, `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
const wrapper=${JSON.stringify(wrapperFile)}, log=${JSON.stringify(exactLog)};
for(const method of ['spawn','execFile','spawnSync','execFileSync']) {
 const original=cp[method]; cp[method]=function(file,...rest) {
  const args=Array.isArray(rest[0])?rest.shift():[];
  return original.call(this,wrapper,[log,String(file),...args],...rest);
 };
}
syncBuiltinESMExports();
`);
      wrapperImports.push('--import', pathToFileURL(preload).href);
    }
    const argv = [process.execPath, ...wrapperImports, '--import', pathToFileURL(join(here, 'lib/spawn-log-preload.mjs')).href, serviceFile];
    const timeWrapper = platform() === 'darwin';
    child = spawn(timeWrapper ? '/usr/bin/time' : argv[0], timeWrapper ? ['-l', ...argv] : argv.slice(1), {
      cwd: home, stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: home, TMP: home, TEMP: home,
        XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, 'data'), OPENCHAMBER_SERVICE_PORT: String(servicePort), OPENCHAMBER_SERVICE_TOKEN: auth,
        MLX_SCOPE_BASE_URL: `http://127.0.0.1:${runtimePort}`, MLX_SCOPE_MEASURE_LOG: log },
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384); });
    closed = new Promise(ok => { child.once('error', error => { stderr += String(error); }); child.once('close', () => { dead = true; ok(); }); });
    for (let i = 0; i < 250 && !servicePid && !dead; i++) { servicePid = records().find(row => row.kind === 'start')?.pid; if (!servicePid) await delay(20); }
    assert(servicePid && !dead, `Service failed to start: ${stderr}`);
    const get = async path => {
      const response = await fetch(`http://127.0.0.1:${servicePort}${path}`, { headers: { Authorization: `Bearer ${auth}` }, signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200, path); return response.json();
    };
    let ready = false;
    for (let i = 0; i < 100 && !ready && !dead; i++) {
      try { ready = (await get('/health')).ok === true; } catch { await delay(50); }
    }
    assert(ready, `Service did not become ready: ${stderr}`);
    const usage = async () => {
      const count = records().filter(row => row.kind === 'usage').length; process.kill(servicePid, 'SIGUSR2');
      for (let i = 0; i < 400; i++) { const rows = records().filter(row => row.kind === 'usage'); if (rows.length > count) return rows.at(-1); await delay(5); }
      throw new Error('Missing service CPU probe.');
    };
    sampling = true;
    sampler = (async () => { while (sampling) { samples.push(await tree(servicePid)); await delay(500); } })();
    const phases = {}, panel = '/v2/snapshot?frame=aabb0011&surface=panel&tier=full', status = '/v2/snapshot?frame=aabb0022&surface=status&tier=glance';
    const phase = async (name, duration, tier) => {
      console.error(`Measuring ${name} (${duration}s).`);
      const start = await usage(), began = performance.now(), latencies = []; let runtimeDue = 0, mediaDue = 0, views = 0, maxJobs = 0;
      while (performance.now() - began < duration * 1000) {
        const elapsed = performance.now() - began, calls = [];
        if (tier && elapsed >= runtimeDue) {
          runtimeDue = elapsed + (name === 'idle' ? 2000 : tier === 'glance' ? 1000 : 500);
          calls.push(() => get(tier === 'glance' ? status : panel).then(body => assert.equal(body.status.state, 'ready')));
        }
        if (tier && elapsed >= mediaDue) {
          mediaDue = elapsed + (name === 'idle' ? 5000 : 2000); await updateFiles();
          // Four simultaneous media surfaces share one in-flight collection per source.
          for (let i = 0; i < 4; i++) { views++; const at = performance.now(); calls.push(() => get('/v2/media').then(body => {
            assert.equal(body.schemaVersion, 1); assert.equal(body.sources.length, 4); assert(body.jobs.length <= 64);
            maxJobs = Math.max(maxJobs, body.jobs.length); latencies.push(performance.now() - at);
          })); }
        }
        await Promise.all(calls.map(call => call())); await delay(Math.min(50, Math.max(1, duration * 1000 - (performance.now() - began))));
      }
      phases[name] = { start, end: await usage(), mediaViewRequests: views, maxJobs,
        mediaLatencyP95Ms: latencies.length ? round(latencies.sort((a, b) => a - b)[Math.ceil(latencies.length * .95) - 1]) : null };
    };
    // Keep startup/V8 trimming outside the steady-state windows.
    await delay(15000); await phase('noView', 10, null);
    await phase('warmup', 5, 'full'); await phase('active', seconds, 'full');
    fixture.active = false; await phase('idleWarmup', 3, 'full'); await phase('idle', seconds, 'full');
    fixture.active = true; await phase('glanceWarmup', 5, 'glance'); await phase('glance', seconds, 'glance');
    await phase('hidden', 75, null);
    sampling = false; await sampler;
    const unexpectedFiles = (await allFiles(home)).filter(file => !allowedFiles.has(file)).map(file => file.slice(home.length + 1));
    process.kill(servicePid, 'SIGTERM'); await closed;
    const rows = records(), spawns = rows.filter(row => row.kind === 'spawn'), exits = new Map(rows.filter(row => row.kind === 'exit').map(row => [row.id, row]));
    const final = rows.find(row => row.kind === 'final');
    const childCpu = new Map(); for (const sample of samples) for (const row of sample.children) childCpu.set(row.pid, Math.max(childCpu.get(row.pid) ?? 0, row.cpuSeconds));
    const time = /([\d.]+)\s+user\s+([\d.]+)\s+sys/.exec(stderr), totalCpu = time ? +time[1] + +time[2] : null;
    const unseen = spawns.filter(row => !row.pid || !childCpu.has(row.pid));
    const reaped = totalCpu === null ? null : Math.max(0, totalCpu - final.cpuMicros / 1e6 - [...childCpu.values()].reduce((a, b) => a + b, 0));
    const exactRows = flags['child-rusage-wrapper'] ? readFileSync(exactLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : null;
    if (exactRows) {
      assert.equal(exactRows.length, spawns.length, 'Every service child must have exact CPU accounting.');
      assert(exactRows.length > 0 && exactRows.every(row => row.kind === 'child-usage' && Number.isInteger(row.pid) && row.pid > 0
        && ['at', 'startedAt', 'childCpuMicros', 'wrapperCpuMicros'].every(key => Number.isFinite(row[key]) && row[key] >= 0) && row.at >= row.startedAt), 'Invalid native child CPU accounting.');
      assert.equal(new Set(exactRows.map(row => row.pid)).size, exactRows.length, 'Duplicate child accounting.');
      assert(exactRows.every(row => spawns.some(spawn => spawn.pid === row.pid)), 'Unmatched child wrapper.');
      assert.notEqual(totalCpu, null, 'Whole-run rusage is required to include residual wrapper overhead.');
    }
    const recordedChildSeconds = exactRows?.reduce((sum, row) => sum + (row.childCpuMicros + row.wrapperCpuMicros) / 1e6, 0) ?? 0;
    // Include all measured wrapper CPU, then conservatively apportion any nonnegative whole-run remainder
    // (final wrapper write/exit, time-tool rounding and service final-log overhead) across wrappers.
    const wrapperResidual = exactRows ? Math.max(0, totalCpu - final.cpuMicros / 1e6 - recordedChildSeconds) : 0;
    const summaries = {};
    for (const [name, item] of Object.entries(phases)) {
      const inside = samples.filter(row => row.at >= item.start.at && row.at <= item.end.at), wall = (item.end.at - item.start.at) / 1000;
      const startCpu = new Map((inside[0]?.children ?? []).map(row => [row.pid, row.cpuSeconds])), lastCpu = new Map();
      for (const row of inside) for (const child of row.children) lastCpu.set(child.pid, child.cpuSeconds);
      const seen = [...lastCpu].reduce((n, [pid, cpu]) => n + cpu - (startCpu.get(pid) ?? 0), 0);
      const endedUnseen = unseen.filter(row => { const end = exits.get(row.id); return end && end.at >= item.start.at && end.at < item.end.at; }).length;
      const exactInWindow = exactRows?.filter(row => row.at >= item.start.at && row.at < item.end.at);
      const childSeconds = exactInWindow ? exactInWindow.reduce((sum, row) => sum + (row.childCpuMicros + row.wrapperCpuMicros) / 1e6, 0) + wrapperResidual * exactInWindow.length / exactRows.length
        : seen + (unseen.length ? endedUnseen / unseen.length * (reaped ?? 0) : 0);
      const serviceSeconds = (item.end.cpuMicros - item.start.cpuMicros) / 1e6;
      const inWindow = row => row.at >= item.start.at && row.at < item.end.at;
      summaries[name] = { wallSeconds: round(wall), serviceCpuPercent: round(serviceSeconds / wall * 100),
        childrenCpuPercent: round(childSeconds / wall * 100), totalCpuPercent: round((serviceSeconds + childSeconds) / wall * 100),
        servicePeakRssMiB: round(Math.max(item.start.rssBytes / 2 ** 20, item.end.rssBytes / 2 ** 20, ...inside.map(row => row.service?.rssMiB ?? 0))),
        peakTreeRssMiB: round(Math.max(0, ...inside.map(row => (row.service?.rssMiB ?? 0) + row.children.reduce((n, child) => n + child.rssMiB, 0)))),
        mediaRequests: mediaRequests.filter(inWindow).length, runtimeRequests: runtimeRequests.filter(inWindow).length,
        spawns: spawns.filter(inWindow).length, spawnsByFile: Object.fromEntries([...new Set(spawns.filter(inWindow).map(row => row.file))].map(file => [file, spawns.filter(row => inWindow(row) && row.file === file).length])),
        maxLiveChildren: Math.max(0, ...inside.map(row => row.children.length)),
        mediaViewRequests: item.mediaViewRequests, maxJobs: item.maxJobs, mediaLatencyP95Ms: item.mediaLatencyP95Ms };
    }
    const checks = [], check = (name, value, limit) => checks.push({ name, value, limit, pass: value <= limit });
    if (exactRows) {
      check('childAccounting.phaseBoundaryChildren', exactRows.filter(row => Object.values(phases).some(phase => row.startedAt < phase.start.at && row.at >= phase.start.at)).length, 0);
      check('childAccounting.wholeRunDiscrepancySeconds', Math.abs(totalCpu - final.cpuMicros / 1e6 - recordedChildSeconds), .025);
      check('childAccounting.wrapperLoggedAsCommand', spawns.filter(row => row.file === basename(flags['child-rusage-wrapper'])).length, 0);
    }
    check('active.cpuPercent', summaries.active.totalCpuPercent, 1.9);
    check('idle.cpuPercent', summaries.idle.totalCpuPercent, .68);
    check('glance.cpuPercent', summaries.glance.totalCpuPercent, .68);
    check('noView.cpuPercent', summaries.noView.totalCpuPercent, .07);
    check('service.peakRssMiB', Math.max(...Object.values(summaries).map(row => row.servicePeakRssMiB)), 132);
    check('noView.runtimeRequests', summaries.noView.runtimeRequests, 0); check('noView.mediaRequests', summaries.noView.mediaRequests, 0);
    check('hidden.runtimeRequests', summaries.hidden.runtimeRequests, 0); check('hidden.mediaRequests', summaries.hidden.mediaRequests, 0);
    check('media.maxConcurrentRequestsPerEndpoint', Math.max(0, ...peakRequests.values()), 1);
    check('media.snapshotJobLimit', Math.max(...Object.values(summaries).map(row => row.maxJobs)), 64);
    check('hidden.childrenAtEnd', samples.at(-1).children.length, 0);
    check('hidden.spawnsAfter60Seconds', spawns.filter(row => row.at >= phases.hidden.start.at + 60000).length, 0);
    check('unexpectedFilesInHome', unexpectedFiles.length, 0);
    assert.equal(digest(serviceFile), serviceSha256, 'Measured service changed during the run.');
    return { pass: checks.every(row => row.pass), checks, phases: summaries, peakConcurrentRequests: Object.fromEntries(peakRequests),
      method: { servicePlusDescendants: true, syntheticSources: ['oMLX', 'ComfyUI', 'Qwen image', 'LocalVideo spool', 'private feed'],
        simultaneousMediaViews: 4, configuredMediaSources: 4, fixtureJobCountBeforeBound: 73, psSampleMs: 500,
        childrenCpu: exactRows ? 'Exact wait4 CPU per original command, assigned to its completion phase; includes measured native wrapper CPU and a conservative share of nonnegative whole-run residual CPU' : 'ps CPU deltas plus whole-run reaped CPU apportioned across short-lived child spawns, matching the existing service harness',
        sourceFixtureCpuExcluded: true, disabledViewBehavior: 'No media or runtime request after last view read', startupSettlingSeconds: 15 },
      childAccounting: exactRows ? { mode: 'wait4', children: exactRows.length,
        childCpuSeconds: exactRows.reduce((sum, row) => sum + row.childCpuMicros / 1e6, 0),
        measuredWrapperCpuSeconds: exactRows.reduce((sum, row) => sum + row.wrapperCpuMicros / 1e6, 0), residualCpuSecondsIncluded: wrapperResidual,
        wholeRunDifferenceSeconds: totalCpu - final.cpuMicros / 1e6 - recordedChildSeconds,
        phaseBoundaryChildren: exactRows.filter(row => Object.values(phases).some(phase => row.startedAt < phase.start.at && row.at >= phase.start.at)).length,
        wrapperSha256: digest(resolve(flags['child-rusage-wrapper'])) } : { mode: 'pooled-estimate' },
      reapedChildCpuSecondsEstimate: reaped === null ? null : round(reaped), unexpectedFiles };
  } finally {
    sampling = false; await sampler;
    if (child && !dead) { try { process.kill(servicePid ?? child.pid, 'SIGTERM'); } catch {} const timer = setTimeout(() => { try { process.kill(servicePid ?? child.pid, 'SIGKILL'); } catch {} }, 2500); await closed; clearTimeout(timer); }
    await close(fake); await close(media); await rm(scratch, { recursive: true, force: true });
  }
}

async function measureHelper() {
  const helper = join(root, 'bridge/comfyui/snapshot.py'), before = digest(helper);
  const program = `import importlib.util,json,sys,time,threading,resource\nfrom types import SimpleNamespace\nspec=importlib.util.spec_from_file_location('snapshot',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nnodes={str(i):{'state':'finished','value':1,'max':1} for i in range(1000)}\nnodes['1000']={'state':'running','value':3,'max':20}\nr=SimpleNamespace(prompt_id='fixture',nodes=nodes,dynprompt=SimpleNamespace(get_node=lambda _: {'class_type':'KSampler'}))\nmodule=SimpleNamespace(global_progress_registry=r);q=SimpleNamespace(mutex=threading.RLock(),currently_running={0:(0,'fixture')})\nstart=time.process_time_ns();wall=time.monotonic();calls=0\nfor i in range(10):\n result=m.snapshot(module,q,'0.38.0',round(time.time()*1000));assert len(result['jobs'])==1;calls+=1;time.sleep(2)\ncpu=(time.process_time_ns()-start)/1e9;elapsed=time.monotonic()-wall\nprint(json.dumps({'calls':calls,'wallSeconds':elapsed,'cpuSeconds':cpu,'cpuPercentOneCore':cpu/elapsed*100,'fixtureProcessMaxRssBytes':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss${platform() === 'linux' ? '*1024' : ''},'observedRegistryEntries':1001,'mutationsOrBackgroundTasks':0}))`;
  const { stdout } = await execute(flags['helper-python'], ['-c', program, helper], { timeout: 30000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(digest(helper), before, 'Helper changed during measurement.');
  return { ...JSON.parse(stdout), sourceSha256: before,
    method: '10 real snapshot function calls at a two-second visible cadence, CPU-only registry/queue stubs, no ComfyUI process or GPU imports',
    limitation: 'Incremental helper function cost; fixture Python RSS is not additional ComfyUI RSS. Existing ComfyUI resource use is excluded.' };
}

const service = await measureService(), helper = await measureHelper();
const receipt = { recordedAt: new Date().toISOString(), serviceSha256, node: process.version,
  host: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, logicalCores: cpus().length }, service, helper,
  limits: 'Synthetic service/children and passive helper CPU only. Renderer and real inference impact require separate evidence.' };
if (flags.out) await writeFile(resolve(flags.out), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt, null, 2));
if (!service.pass) process.exitCode = 1;

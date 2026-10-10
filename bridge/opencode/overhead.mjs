// node bridge/opencode/overhead.mjs /absolute/evidence/directory [absolute frozen companion directory]
// Measures this companion inside an isolated Node worker, never a whole OpenCode process or real inference.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = (kind, value) => createHash('sha256').update(`mlx-scope-${kind}-v1\0${value}`).digest('hex');
const CHATS = 4, IDLE_MS = 6_000, VISIBLE_MS = 10_000, HIDDEN_MS = 6_000, DELTA_MS = 100;
const UUID_FILE = /^[a-f0-9-]{36}\.json$/;
const watched = Array.from({ length: CHATS }, (_, i) => ({ sessionKey: digest('session', `ses_fixture_${i}`),
  providerKey: digest('provider', 'fixture'), modelKey: digest('model', 'fixture'), ...i % 2 ? { destination: 'remote' } : {} }));
const companionFiles = ['index.js', 'chat.js', 'demand.js', 'chat-store.js', 'store.js', 'stream.js', 'package.json'];
const companionDigests = async directory => Object.fromEntries(await Promise.all(companionFiles.map(async name =>
  [name, createHash('sha256').update(await readFile(join(directory, name))).digest('hex')])));
async function demand(directory, ttl = 15_000) {
  const now = Date.now(), temp = join(directory, `.${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify({ schemaVersion: 1, updatedAtMs: now, expiresAtMs: now + ttl, watched }), { mode: 0o600 });
  await rename(temp, join(directory, 'demand.json'));
}
function source() {
  let subscriptions = 0, active = 0, maxActive = 0, delivered = 0; const listeners = new Set();
  return {
    publish(event) { for (const listener of listeners) listener(event); },
    subscribe({ signal }) {
      subscriptions++; active++; maxActive = Math.max(maxActive, active);
      return { async *[Symbol.asyncIterator]() {
        const queue = []; let wake;
        const receive = event => { queue.push(event); wake?.(); wake = undefined; };
        const aborted = () => { wake?.(); wake = undefined; };
        listeners.add(receive); signal.addEventListener('abort', aborted, { once: true });
        try {
          while (!signal.aborted) {
            if (!queue.length) await new Promise(resolve => { wake = resolve; });
            while (queue.length && !signal.aborted) { delivered++; yield queue.shift(); }
          }
        } finally { listeners.delete(receive); signal.removeEventListener('abort', aborted); active--; }
      } };
    },
    stats() { return { subscriptions, active, maxActive, delivered }; },
  };
}

async function worker(enabled, directory, companionDirectory) {
  const events = [source(), source()], hooks = [new Map(), new Map()], disposals = []; let generation = 0, serial = 0, emitted = 0, deltas = 0;
  let phase = 'setup'; process.send({ type: 'phase', phase });
  if (enabled) {
    const { makePlugin } = await import(pathToFileURL(join(companionDirectory, 'index.js')).href),
      { createChatObserver } = await import(pathToFileURL(join(companionDirectory, 'demand.js')).href),
      { createStore } = await import(pathToFileURL(join(companionDirectory, 'store.js')).href);
    const plugin = makePlugin({ shared: {}, observerFactory: () => createChatObserver({ directory }),
      storeFactory: () => createStore({ directory: join(directory, 'progress') }) });
    for (let location = 0; location < 2; location++) disposals.push(await plugin.setup({ app: { version: '2.0.25' }, options: { promptProgress: false }, location: { directory: `/fixture/project-${location}` },
      event: events[location], session: { hook: async (name, callback) => { hooks[location].set(name, callback); return { dispose() {} }; } } }));
  }
  const emit = (i, type, data = {}) => {
    emitted++; events[i % 2].publish({ id: `evt_${++serial}`, type: `session.${type}`, created: Date.now(),
      data: { sessionID: `ses_fixture_${i}`, assistantMessageID: `msg_fixture_${i}_${generation}`, ...data } });
  };
  let counts = Array(CHATS).fill(0), roundTicks = 0;
  async function begin() {
    generation++; roundTicks = 0; counts = Array(CHATS).fill(0);
    for (let i = 0; i < CHATS; i++) {
      const request = { kind: 'primary', sessionID: `ses_fixture_${i}`, model: { providerID: 'fixture', id: 'fixture' },
        request: new Request(i % 2 ? 'https://fixture.invalid/v1/chat/completions' : 'http://127.0.0.1:7777/v1/chat/completions',
          { method: 'POST' }) };
      const websocket = i % 2 === 1;
      const callback = hooks[i % 2].get(websocket ? 'experimental.ws.handshake' : 'http.request');
      await callback?.(websocket ? { kind: request.kind, sessionID: request.sessionID, model: request.model, url: 'wss://fixture.invalid/v1/responses' } : request);
      emit(i, 'step.started', { started: Date.now(), model: request.model }); emit(i, 'text.started', { ordinal: 0 });
    }
  }
  const content = 'synthetic output only '.repeat(2); // 44 Unicode code points, 110 estimated tokens/sec per chat.
  function finish() {
    for (let i = 0; i < CHATS; i++) {
      emit(i, 'text.ended', { ordinal: 0, text: content.repeat(counts[i]) }); emit(i, 'step.streamed');
      emit(i, 'step.ended', { finish: 'stop', tokens: { output: counts[i] * content.length / 4, reasoning: 0 } });
    }
  }
  let producing = false;
  async function produce() {
    if (producing) return; producing = true;
    try {
      if (roundTicks === 40) { finish(); await begin(); }
      for (let i = 0; i < CHATS; i++) { counts[i]++; deltas++; emit(i, 'text.delta', { ordinal: 0, delta: content }); }
      roundTicks++;
    } finally { producing = false; }
  }
  const eventStats = () => events.map(item => item.stats()).reduce((total, item) => { for (const key in item) total[key] = (total[key] ?? 0) + item[key]; return total; }, {});
  const measure = async (name, duration) => {
    phase = name; process.send({ type: 'phase', phase });
    const at = performance.now(), startCPU = process.cpuUsage(), before = eventStats(), emittedStart = emitted, deltaStart = deltas;
    const rss = [process.memoryUsage().rss], timer = setInterval(() => rss.push(process.memoryUsage().rss), 500);
    await pause(duration); clearInterval(timer); rss.push(process.memoryUsage().rss);
    const cpu = process.cpuUsage(startCPU), elapsedMs = performance.now() - at, after = eventStats();
    const result = { phase, wallMs: elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000,
      cpuPercentOneCore: (cpu.user + cpu.system) / elapsedMs / 10, userCPUms: cpu.user / 1000, systemCPUms: cpu.system / 1000,
      rssBytes: rss, maxRSSBytes: process.resourceUsage().maxRSS * 1024,
      producedEvents: emitted - emittedStart, producedDeltas: deltas - deltaStart,
      deliveredEvents: after.delivered - before.delivered, activeSubscriptions: after.active, maxSubscriptions: after.maxActive };
    process.send({ type: 'measurement', result }); return result;
  };
  let producer, renew;
  try {
    await pause(1000); const idle = await measure('idle', IDLE_MS);
    await demand(directory); await begin();
    producer = setInterval(() => void produce(), DELTA_MS); renew = setInterval(() => void demand(directory), 5000);
    const visible = await measure('visible', VISIBLE_MS); clearInterval(renew);
    // Simulate a view that disappears without explicit cleanup: its final short lease expires naturally.
    await demand(directory, 1000); phase = 'expiry-settle'; process.send({ type: 'phase', phase }); await pause(2300);
    const hidden = await measure('hidden', HIDDEN_MS); clearInterval(producer);
    assert.equal(hidden.activeSubscriptions, 0); assert.equal(hidden.deliveredEvents, 0);
    if (enabled) { assert.equal(visible.maxSubscriptions, 2); assert.ok(visible.deliveredEvents > 300); }
    process.send({ type: 'result', result: { enabled, idle, visible, hidden } });
  } finally { clearInterval(producer); clearInterval(renew); for (const dispose of disposals) await dispose(); process.disconnect(); }
}

if (process.argv[2] === '--worker') {
  await worker(process.argv[3] === 'on', process.argv[4], process.argv[5]);
} else {
  const output = process.argv[2];
  if (!output || !output.startsWith('/')) throw new Error('Pass an absolute evidence output directory.');
  await mkdir(output, { recursive: true });
  const file = fileURLToPath(import.meta.url), runs = [], startedAt = new Date().toISOString();
  const companionDirectory = resolve(process.argv[3] ?? dirname(file));
  const measuredDigests = await companionDigests(companionDirectory);
  // Alternating order balances warm caches and background load; all six workers run sequentially.
  for (let pair = 0; pair < 3; pair++) for (const enabled of pair === 1 ? [true, false] : [false, true]) {
    assert.deepEqual(await companionDigests(companionDirectory), measuredDigests, 'Freeze the companion before measuring.');
    const directory = await mkdtemp(join(output, '.companion-overhead-')); await chmod(directory, 0o700);
    let phase = 'setup', result, maxWriterBytes = 0, maxWriters = 0, maxDirectoryBytes = 0, samples = 0;
    const files = new Map(), changes = {}, warnings = [], liveSessions = new Set();
    const child = fork(file, ['--worker', enabled ? 'on' : 'off', directory, companionDirectory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    child.stderr.on('data', chunk => { if (warnings.length < 10) warnings.push(String(chunk).slice(0, 500)); });
    let scanning = false;
    const inspect = async () => {
      if (scanning) return; scanning = true;
      try {
        const names = await readdir(directory); let writers = 0, bytes = 0;
        for (const name of names) {
          if (!UUID_FILE.test(name) && name !== 'heartbeat.json') continue;
          let info; try { info = await stat(join(directory, name)); } catch { continue; }
          if (!info.isFile()) continue;
          bytes += info.size;
          if (UUID_FILE.test(name)) {
            writers++; maxWriterBytes = Math.max(maxWriterBytes, info.size);
            try { const document = JSON.parse(await readFile(join(directory, name), 'utf8'));
              for (const entry of document.entries ?? []) if (entry.measurement?.freshness === 'live' && entry.measurement?.tokensPerSecond > 0) liveSessions.add(entry.sessionKey);
            } catch { /* Atomic writer replacement may race this independent measurement sample. */ }
          }
          const previous = files.get(name), stamp = `${info.mtimeMs}:${info.size}`;
          if (stamp !== previous) { files.set(name, stamp); changes[phase] ??= { writerChanges: 0, heartbeatChanges: 0 };
            changes[phase][name === 'heartbeat.json' ? 'heartbeatChanges' : 'writerChanges']++; }
        }
        maxWriters = Math.max(maxWriters, writers); maxDirectoryBytes = Math.max(maxDirectoryBytes, bytes); samples++;
      } finally { scanning = false; }
    };
    const watcher = watch(directory, () => void inspect()), poll = setInterval(() => void inspect(), 250);
    child.on('message', message => {
      if (message.type === 'phase') phase = message.phase;
      if (message.type === 'result') result = message.result;
    });
    const exit = await new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    clearInterval(poll); watcher.close(); await inspect();
    try {
      assert.equal(exit.code, 0, JSON.stringify({ exit, warnings })); assert.ok(result);
      assert.equal(changes.hidden?.writerChanges ?? 0, 0); assert.equal(changes.hidden?.heartbeatChanges ?? 0, 0);
      if (enabled) { assert.equal(maxWriters, 1); assert.ok(maxWriterBytes < 65_536); assert.equal(liveSessions.size, CHATS, 'every location/chat produced a live reading'); }
      const record = { pair, ...result, filesystem: { samples, maxWriters, maxWriterBytes, maxDirectoryBytes, liveChatsObserved: liveSessions.size, changes }, warnings };
      runs.push(record); console.log(JSON.stringify({ pair, enabled, idleCPU: result.idle.cpuPercentOneCore,
        visibleCPU: result.visible.cpuPercentOneCore, hiddenCPU: result.hidden.cpuPercentOneCore, maxWriterBytes }));
      assert.deepEqual(await companionDigests(companionDirectory), measuredDigests, 'Companion changed during measurement.');
      await writeFile(join(output, 'companion-overhead.json'), JSON.stringify({ startedAt, recordedAt: new Date().toISOString(),
        companionSha256: measuredDigests,
        environment: { node: process.version, platform: platform(), release: release(), cpu: cpus()[0]?.model, logicalCPUs: cpus().length },
        method: { chats: CHATS, localChats: 2, remoteChats: 2, deltaCadenceMs: DELTA_MS, locations: 2,
          phasesMs: { idle: IDLE_MS, visible: VISIBLE_MS, hidden: HIDDEN_MS },
          attribution: 'isolated Node worker process; enabled-minus-disabled incremental companion including event subscription and filesystem work; not whole OpenCode',
          runtimeProtocol: 'released OpenCode 2.0.25 shapes; HTTP and WebSocket requests awaited before output, with two location-scoped subscriptions; qualified separately by protocol-smoke.mjs and protocol-ws-smoke.mjs' }, runs }, null, 2));
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}

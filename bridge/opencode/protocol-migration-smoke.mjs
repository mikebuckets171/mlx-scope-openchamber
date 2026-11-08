// Optional qualification: bun bridge/opencode/protocol-migration-smoke.mjs /absolute/path/to/opencode [v5.4.0]
// The move from Scope 5's helper to the one the extension delivers, against an isolated released OpenCode process:
//   1. the helper Scope 5 installed (the files of a release tag, a plugin entry with options, an owner marker) is loaded from
//      OpenCode's global configuration, and the extension's helper (this folder, no options) is listed in the configuration
//      OpenChamber manages through OPENCODE_CONFIG; OpenCode loads only the first of one plugin id, so the older one runs;
//   2. the service's own retire() removes the entry and its files, once, with no reply running;
//   3. OpenCode reloads its plugin list from the replaced file and the extension's helper takes over, without a restart.
// No model, no inference and no network are involved; HOME, XDG and OpenCode's own folders are temporary.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatTelemetry } from '../../service/chat-telemetry.ts';
import { createCompanionSetup, COMPANION_ID } from '../../service/companion-setup.ts';
import { version as currentVersion } from './package.json' with { type: 'json' };

const binary = process.argv[2], tag = process.argv[3] ?? 'v5.4.0';
if (!binary) throw new Error('Pass the absolute path to an OpenCode binary.');
const bridge = dirname(fileURLToPath(import.meta.url)), repo = join(bridge, '../..');
const LEGACY_FILES = ['package.json', 'README.md', 'index.js', 'store.js', 'stream.js', 'chat.js', 'demand.js', 'chat-store.js', 'compatibility.js'];
const base = await realpath(await mkdtemp(join(tmpdir(), 'scope-migration-')));
const home = join(base, 'home'), root = join(home, '.config', 'opencode'), addon = join(root, 'addons', COMPANION_ID);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = text => createHash('sha256').update(text).digest('hex');
let child, logs = '';
try {
  for (const dir of [root, join(base, 'cache'), join(base, 'data'), join(base, 'state'), join(base, 'workspace'), addon]) await mkdir(dir, { recursive: true });
  const files = {};
  for (const name of LEGACY_FILES) {
    files[name] = execFileSync('git', ['show', `${tag}:bridge/opencode/${name}`], { cwd: repo, encoding: 'utf8' });
    await writeFile(join(addon, name), files[name], { mode: 0o600 });
  }
  const legacyVersion = JSON.parse(files['package.json']).version;
  assert.notEqual(legacyVersion, currentVersion, 'the tag must hold an older helper than this checkout');
  await writeFile(join(addon, '.mlx-scope-owner.json'), JSON.stringify({ schemaVersion: 1, owner: COMPANION_ID, installedAtMs: 1,
    files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, sha(text)])) }), { mode: 0o600 });
  await writeFile(join(root, 'opencode.json'), JSON.stringify({ update: 'disable', share: 'disabled', snapshots: false,
    plugins: [{ package: addon, options: { promptProgress: false, scopeRevision: 'a'.repeat(64) } }] }));
  // OpenChamber's managed file lists an extension's plugin as a bare folder.
  await writeFile(join(base, 'managed.json'), JSON.stringify({ plugins: [bridge] }));
  const reservation = net.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: home, OPENCODE_TEST_HOME: home, OPENCODE_CONFIG_DIR: root, OPENCODE_CONFIG: join(base, 'managed.json'),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(base, 'cache'), XDG_DATA_HOME: join(base, 'data'), XDG_STATE_HOME: join(base, 'state') };
  child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: join(base, 'workspace'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const collect = bytes => { if (logs.length < 32_768) logs += bytes; };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const headers = () => ({ Authorization: 'Basic ' + Buffer.from('opencode:' + (logs.match(/server password (\S+)/)?.[1] ?? '')).toString('base64') });
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) { await pause(250); try { ready = (await fetch(`http://127.0.0.1:${port}/api/info`, { headers: headers(), signal: AbortSignal.timeout(1000) })).ok; } catch {} }
  assert.ok(ready, 'isolated server became ready');
  await fetch(`http://127.0.0.1:${port}/api/plugin`, { headers: headers() });
  const telemetry = new ChatTelemetry(home);
  const loaded = async (version, within) => {
    for (let i = 0; i < within / 250; i++) { const probe = await telemetry.probe(); if (probe?.companionVersion === version) return probe; await pause(250); }
    return null;
  };
  assert.ok(await loaded(legacyVersion, 8_000), `the helper Scope 5 installed (${legacyVersion}) loads first`);
  await pause(1500);
  assert.equal((await telemetry.probe()).companionVersion, legacyVersion, 'the extension\'s helper does not load beside it: one plugin id, one copy');
  const setup = createCompanionSetup({ home, env: {}, probe: () => telemetry.probe(), idle: () => telemetry.idle() });
  assert.equal((await setup.status()).state, 'pending');
  assert.match((await setup.status()).message, /older chat-speed helper/);
  const started = Date.now();
  assert.equal(await setup.retire(), 'removed');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'opencode.json'), 'utf8')).plugins, []);
  assert.deepEqual(await readdir(join(root, 'addons')), []);
  const takeover = await loaded(currentVersion, 10_000);
  assert.ok(takeover, `OpenCode loads the extension's helper (${currentVersion}) in its place, without a restart`);
  assert.ok(takeover.loadedAtMs >= started - 1_000, 'the heartbeat is the new helper\'s, written after the removal');
  assert.equal(child.exitCode, null, 'the OpenCode process kept running');
  assert.equal((await setup.status()).state, 'ready');
  console.log(JSON.stringify({ result: 'pass', runtime: takeover.runtimeVersion, legacyHelper: legacyVersion, extensionHelper: currentVersion,
    swappedWithinMs: takeover.loadedAtMs - started, restarted: false }, null, 2));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM'); await Promise.race([exited, pause(3000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
  await rm(base, { recursive: true, force: true });
}

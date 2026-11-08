// On demand, before a release that changes the manifest, permissions or how the chat-speed helper is delivered:
//   node scripts/host-smoke.mjs [--zip dist/mlx-scope-openchamber-<version>.zip] [--migrate v5.4.0] [--keep]
// Runs the installed OpenChamber desktop app's own web server (on its bundled Node) in a throwaway profile (HOME, data folder, OpenCode
// folders and a random UI password all temporary), installs the release ZIP through Settings → Extensions, approves it, and checks what
// the host actually does with it: the helper folder reaches the OpenCode it runs, the helper loads, Connections says it is ready, and
// the panel, its tabs and the full page open. With --migrate it first plants Scope 5's helper (the files of a release tag) in that
// profile's OpenCode settings and checks that Scope 6's service retires it and OpenCode swaps to the extension's helper.
// No model is used and no prompt is sent. Your own OpenCode settings and your running OpenChamber are never touched: the script hashes
// the former before and after, and fails if they differ.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), flag = name => args.includes(name), value = name => flag(name) ? args[args.indexOf(name) + 1] : undefined;
const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
const helperVersion = JSON.parse(await readFile(join(repo, 'bridge/opencode/package.json'), 'utf8')).version;
const zip = resolve(repo, value('--zip') ?? `dist/${pkg.name}-${pkg.version}.zip`);
const migrate = flag('--migrate') ? value('--migrate') : null;
const APP = `${process.env.OPENCHAMBER_APP ?? '/Applications/OpenChamber.app'}/Contents`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, ...detail ? { detail } : {} }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` · ${detail}` : ''}`); };
const until = async (read, ok, ms = 12_000) => { for (let waited = 0; waited < ms; waited += 250) { const got = await read(); if (ok(got)) return got; await pause(250); } return await read(); };

const realRoot = join(homedir(), '.config', 'opencode');
const fingerprint = async () => ({ settings: await readFile(join(realRoot, 'opencode.json')).then(text => createHash('sha256').update(text).digest('hex'), () => null),
  addons: (await readdir(join(realRoot, 'addons')).catch(() => [])).sort() });
const before = await fingerprint();
const base = await realpath(await mkdtemp(join(tmpdir(), 'scope-host-')));
const home = join(base, 'home'), data = join(base, 'data'), root = join(home, '.config', 'opencode'), addon = join(root, 'addons', 'mlx-scope-prompt-progress');
const heartbeat = join(home, '.cache', 'mlx-scope', 'chat-telemetry', 'heartbeat.json');
for (const dir of [home, data, root, join(base, 'workspace')]) await mkdir(dir, { recursive: true });
const reservation = net.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const password = randomBytes(9).toString('base64url');
let server, browser, page, logs = '';
const helper = async () => JSON.parse(await readFile(heartbeat, 'utf8').catch(() => 'null'))?.companionVersion ?? null;
try {
  await readFile(zip).catch(() => { throw new Error(`No ZIP at ${zip}. Run "bun run check" first.`); });
  server = spawn(`${APP}/MacOS/OpenChamber`, [`${APP}/Resources/app.asar/node_modules/@openchamber/web/bin/cli.js`, 'serve', '--foreground', '--port', String(port)], {
    cwd: join(base, 'workspace'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin', TMPDIR: process.env.TMPDIR, HOME: home,
      OPENCHAMBER_DATA_DIR: data, OPENCHAMBER_UI_PASSWORD: password, OPENCHAMBER_DIST_DIR: `${APP}/Resources/web-dist`, OPENCODE_BINARY: `${APP}/Resources/opencode-cli/opencode`,
      OPENCODE_CONFIG_DIR: root, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local/share'), XDG_STATE_HOME: join(home, '.local/state') } });
  const collect = bytes => { logs += bytes; if (logs.length > 100_000) logs = logs.slice(-50_000); };
  server.stdout.on('data', collect); server.stderr.on('data', collect);
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { await pause(500); try { up = (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).status < 500; } catch {} }
  check('an isolated OpenChamber starts', up, `port ${port}, its own HOME and data folder`);
  if (!up) throw new Error('the isolated OpenChamber did not start');

  if (migrate) {
    const names = ['package.json', 'README.md', 'index.js', 'store.js', 'stream.js', 'chat.js', 'demand.js', 'chat-store.js', 'compatibility.js'], files = {};
    await mkdir(addon, { recursive: true, mode: 0o700 });
    for (const name of names) { files[name] = execFileSync('git', ['show', `${migrate}:bridge/opencode/${name}`], { cwd: repo, encoding: 'utf8' }); await writeFile(join(addon, name), files[name], { mode: 0o600 }); }
    await writeFile(join(addon, '.mlx-scope-owner.json'), JSON.stringify({ schemaVersion: 1, owner: 'mlx-scope-prompt-progress', installedAtMs: 1,
      files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, createHash('sha256').update(text).digest('hex')])) }), { mode: 0o600 });
    await writeFile(join(root, 'opencode.json.tmp'), JSON.stringify({ plugins: [{ package: addon, options: { promptProgress: false, scopeRevision: 'b'.repeat(64) } }] }));
    await rename(join(root, 'opencode.json.tmp'), join(root, 'opencode.json'));
  }

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/`); await pause(2500);
  const lock = page.locator('input[type=password]').first();
  if (await lock.count()) { await lock.fill(password); await lock.press('Enter'); await pause(3500); }
  // Scope 5's helper is the only one OpenCode knows about until the extension is approved. OpenCode loads plugins once the UI opens it.
  const oldHelper = migrate ? await until(helper, version => version !== null, 15_000) : null;
  if (migrate) check(`Scope 5's helper (${migrate}) is loaded by OpenCode before the extension is approved`, oldHelper && oldHelper !== helperVersion, `helper ${oldHelper}`);
  const openExtensions = async () => { await page.getByRole('button', { name: /^settings$/i }).first().click(); await pause(1200); await page.getByText('Extensions', { exact: true }).first().click(); await pause(1200); };

  await openExtensions();
  await page.getByText('Add extension').first().click(); await pause(800);
  await page.locator('input[placeholder*="/path/to/panel"]').fill(zip);
  await page.locator('button', { hasText: /^\s*Add\s*$/ }).last().click(); await pause(3500);
  const approval = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  check('OpenChamber accepts the release ZIP and asks to approve it', /Allow MLX Scope\?/.test(approval) && new RegExp(`v${pkg.version.replace(/\./g, '\\.')}`).test(approval));
  check('the approval lists "Add a plugin to OpenCode"', /Add a plugin to OpenCode/.test(approval));
  check('the approval lists the service and its commands', /Run a local service/.test(approval) && /\/usr\/bin\/top/.test(approval));
  await page.getByText('Allow and enable', { exact: true }).first().click().catch(async () => {
    await openExtensions(); await page.getByText('MLX Scope', { exact: true }).first().click(); await pause(800);
    await page.getByText('Review permissions').locator('visible=true').first().click(); await pause(1000); await page.getByText('Allow and enable', { exact: true }).first().click();
  });
  await pause(4000);

  const managed = (await readdir(join(data, 'run', 'instances'), { recursive: true }).catch(() => [])).find(name => name.endsWith('opencode.managed.json'));
  const plugins = managed ? JSON.parse(await readFile(join(data, 'run', 'instances', managed), 'utf8')).plugins : [];
  check('OpenChamber adds the extension\'s helper folder to the OpenCode it runs', plugins.some(entry => entry === join(data, 'extensions', 'mlx-scope', 'bridge', 'opencode')));

  await page.keyboard.press('Escape'); await pause(600); await page.keyboard.press('Escape'); await pause(800);
  // "MLX Scope" also names the Work Status section's header; the rail icon is the one at the far right.
  for (const candidate of await page.getByRole('button', { name: 'MLX Scope', exact: true }).all()) if ((await candidate.boundingBox())?.x > 1100) { await candidate.click(); break; }
  await pause(3500);
  const panel = page.frames().find(frame => frame.url().includes('/panel/index.html'));
  check('the Scope panel opens', !!panel);
  const text = async () => (await panel.locator('body').innerText()).replace(/\s+/g, ' ');
  check('the panel starts without a startup failure', !/could not start|Reload MLX Scope/.test(await text()));
  await panel.getByRole('button', { name: 'Connections', exact: true }).click(); await pause(2500);
  const status = panel.locator('#companion-setup [data-companion-status]');
  const ready = await until(async () => (await status.innerText()).trim(), value => /ready for your next reply/.test(value), 10_000);
  check('Connections → Chat speed says the helper is ready', /ready for your next reply/.test(ready), ready);
  await panel.locator('#companion-setup .setup-versions > summary').click(); await pause(600);
  check(`the loaded helper is ${helperVersion}`, (await panel.locator('#companion-setup [data-companion-version]').innerText()).includes(`Companion ${helperVersion}`));
  check('Chat speed offers a status check and no switch', (await panel.locator('#companion-setup button').allInnerTexts()).join('|') === 'Check status');
  const beat = JSON.parse(await readFile(heartbeat, 'utf8'));
  check('the helper in OpenCode reports delivery and Splash prompt progress armed', ['http-delivery', 'prompt-progress'].every(id => beat.features?.[id]?.available === true) && beat.companionVersion === helperVersion);
  for (const tab of ['Engine room', 'History', 'Live']) {
    await panel.getByRole('button', { name: tab, exact: true }).click(); await pause(1500);
    check(`the ${tab} tab opens`, !/could not start|Reload MLX Scope/.test(await text()) && (await text()).length > 80);
  }
  if (migrate) {
    check('Scope 6 removed the Scope 5 entry from OpenCode\'s settings', JSON.stringify(JSON.parse(await readFile(join(root, 'opencode.json'), 'utf8')).plugins) === '[]');
    check('Scope 6 removed the Scope 5 helper files', (await readdir(join(root, 'addons')).catch(() => [])).length === 0);
    check('OpenCode swapped to the extension\'s helper without a restart', (await until(helper, version => version === helperVersion, 8_000)) === helperVersion);
  }
  // Extension pages live in the sidebar's "…" menu. A fresh browser context shows the sidebar as a person first sees it (an open panel collapses it).
  page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await page.goto(`http://127.0.0.1:${port}/`); await pause(2500);
  const again = page.locator('input[type=password]').first();
  if (await again.count()) { await again.fill(password); await again.press('Enter'); await pause(3500); }
  await page.mouse.click(115, 68); await pause(1000);
  await page.getByRole('menuitem', { name: /MLX Scope/ }).first().click(); await pause(4000);
  const surfaces = [];
  for (const frame of page.frames().filter(candidate => candidate !== page.mainFrame())) surfaces.push(await frame.evaluate(() => document.documentElement.dataset.surface || document.body.dataset.surface || document.querySelector('[data-surface]')?.getAttribute('data-surface')).catch(() => null));
  check('the full page opens', surfaces.includes('page'), `surfaces ${surfaces.join(', ')}`);
} catch (error) {
  check('the run completed', false, String(error?.message ?? error).split('\n')[0]);
  if (flag('--keep')) await page?.screenshot({ path: join(base, 'failure.png') }).catch(() => {});
} finally {
  await browser?.close().catch(() => {});
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(5000)]); if (server.exitCode === null) server.kill('SIGKILL'); }
  const after = await fingerprint();
  check('your own OpenCode settings were not touched', JSON.stringify(before) === JSON.stringify(after));
  if (flag('--keep')) { console.log(`kept: ${base}`); await writeFile(join(base, 'server.log'), logs.replace(new RegExp(password, 'g'), '[pw]')); } else await rm(base, { recursive: true, force: true });
}
const failed = checks.filter(item => !item.ok);
console.log(`\n${failed.length ? 'FAIL' : 'PASS'}: ${checks.length - failed.length} of ${checks.length} host checks${migrate ? ` (including the move from ${migrate})` : ''}`);
process.exit(failed.length ? 1 : 0);

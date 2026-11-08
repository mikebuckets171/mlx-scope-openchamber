import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser/lib/esm/main.js';
import { COMPANION_ID, createCompanionSetup, type CompanionProbe, type CompanionSetupOptions } from './companion-setup.ts';
import { version as companionVersion } from '../bridge/opencode/package.json';

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
// The nine files Scope 5's guided setup copied into OpenCode's own configuration folder, with its owner marker.
const LEGACY = ['package.json', 'README.md', 'index.js', 'store.js', 'stream.js', 'chat.js', 'demand.js', 'chat-store.js', 'compatibility.js'];
const REVISION = 'a'.repeat(64);

async function fixture(extra: Partial<CompanionSetupOptions> = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'mlx-scope-setup-'))); homes.push(home);
  const root = join(home, '.config', 'opencode'), config = join(root, 'opencode.json'), addon = join(root, 'addons', COMPANION_ID);
  await mkdir(root, { recursive: true });
  const options = { home, env: {}, ...extra };
  const entry = (extraOptions = {}) => JSON.stringify({ package: addon, options: { providerID: 'splash', baseURL: 'http://127.0.0.1:18181/v1', scopeRevision: REVISION, ...extraOptions } });
  /** What `Enable chat speed` used to leave behind. */
  const installLegacy = async (names: string[] = LEGACY, directory = addon) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const files: Record<string, string> = {};
    for (const name of names) {
      const text = name === 'package.json' ? JSON.stringify({ name: COMPANION_ID, version: '3.6.0', type: 'module' }) : `// legacy ${name}\n`;
      await writeFile(join(directory, name), text, { mode: 0o600 }); files[name] = sha(text);
    }
    await writeFile(join(directory, '.mlx-scope-owner.json'), JSON.stringify({ schemaVersion: 1, owner: COMPANION_ID, installedAtMs: 1, files }), { mode: 0o600 });
  };
  const retired = async () => (await readdir(join(root, 'addons')).catch(() => [])).length === 0;
  return { home, root, config, addon, options, entry, installLegacy, retired, setup: createCompanionSetup(options) };
}
const receipt = (at: number, extra: Partial<CompanionProbe> = {}): CompanionProbe => ({ companionVersion, protocol: 'opencode-2.0.25', runtimeVersion: '2.2.6', supported: true, loadedAtMs: at, ...extra });

describe('the chat-speed helper that comes with the extension', () => {
  it('reports what the helper says and creates nothing', async () => {
    const f = await fixture();
    expect(await f.setup.status()).toMatchObject({ state: 'pending', configured: false, managed: false, canEnable: false, canDisable: false, live: false,
      message: expect.stringContaining('this extension’s helper') });
    expect(await readdir(f.root)).toEqual([]);
    const at = Date.now();
    const ready = (extra: Partial<CompanionProbe> = {}) => createCompanionSetup({ ...f.options, now: () => at, probe: async () => receipt(at - 1_000, extra) });
    expect(await ready().status()).toMatchObject({ state: 'ready', configured: true, live: false, companionVersion, runtimeVersion: '2.2.6',
      message: 'Chat tracking is ready for your next reply.', compatibility: { activity: 'awaiting-demand' } });
    expect(await ready({ updatedAtMs: at, expiresAtMs: at + 15_000 }).status()).toMatchObject({ state: 'ready', live: true, compatibility: { activity: 'listening' } });
    expect(await ready({ runtimeVersion: '2.0.24' }).status()).toMatchObject({ state: 'incompatible', configured: false });
    expect(await ready({ supported: false }).status()).toMatchObject({ state: 'error', message: expect.stringContaining('hooks are unavailable') });
  });

  it('knows an older helper from Scope 5 is the one loaded, and says it will be replaced', async () => {
    const f = await fixture(); await f.installLegacy(); await writeFile(f.config, `{"plugins":[${f.entry()}]}`);
    const at = Date.now();
    const setup = createCompanionSetup({ ...f.options, now: () => at, idle: async () => false, probe: async () => receipt(at - 1_000, { companionVersion: '3.6.0' }) });
    expect(await setup.status()).toMatchObject({ state: 'pending', managed: true, configured: false, message: expect.stringContaining('older chat-speed helper from MLX Scope 5 is still loaded') });
  });
});

describe('retiring the helper Scope 5 installed', () => {
  it('removes its entry and files, keeping comments, other plugins and every other setting', async () => {
    const f = await fixture(); await f.installLegacy();
    const original = `{
  // Keep this private configuration comment.
  "plugins": [
    "another-plugin", // keep its entry
    ${f.entry()}, /* keep this note */
    "-opencode.browser"
  ],
  "theme": "unchanged",
}\n`;
    await writeFile(f.config, original);
    expect(await f.setup.retire()).toBe('removed');
    const changed = await readFile(f.config, 'utf8');
    expect(changed).toContain('// Keep this private configuration comment.'); expect(changed).toContain('// keep its entry'); expect(changed).toContain('/* keep this note */');
    expect(parse(changed)).toEqual({ plugins: ['another-plugin', '-opencode.browser'], theme: 'unchanged' });
    expect(await f.retired()).toBe(true);
    expect(await f.setup.retire()).toBe('none');
    expect(await readFile(f.config, 'utf8')).toBe(changed);
    expect(await f.setup.status()).toMatchObject({ state: 'pending', managed: false, message: expect.stringContaining('this extension’s helper') });
  });

  it('keeps compact plugin lists valid whichever position the entry held', async () => {
    for (const lists of [(e: string) => `["first"/* keep A */,${e}]`, (e: string) => `[${e}/* keep B */, "last"]`, (e: string) => `[/* keep C */${e}]`, (e: string) => `["a",${e},"b"]`]) {
      const f = await fixture(); await f.installLegacy();
      const before = lists(f.entry()), text = `{"plugins":${before},"setting":true}`;
      await writeFile(f.config, text);
      expect(await f.setup.retire()).toBe('removed');
      const after = await readFile(f.config, 'utf8');
      expect(parse(after).plugins).toEqual(parse(before).filter((value: unknown) => typeof value === 'string'));
      expect(parse(after).setting).toBe(true);
      for (const comment of before.match(/\/\*.*?\*\//g) ?? []) expect(after).toContain(comment);
    }
  });

  it('uses opencode.jsonc when that is where the entry lives, and honors the explicit configuration folder', async () => {
    const f = await fixture(); await f.installLegacy();
    const jsonc = join(f.root, 'opencode.jsonc');
    await writeFile(jsonc, `{\n// provider notes\n"plugins":["x", ${f.entry()}],\n}\n`);
    expect(await f.setup.retire()).toBe('removed');
    expect(parse(await readFile(jsonc, 'utf8')).plugins).toEqual(['x']); expect(await readFile(jsonc, 'utf8')).toContain('// provider notes');
    const g = await fixture(), custom = join(g.home, 'custom-opencode'), addon = join(custom, 'addons', COMPANION_ID);
    await g.installLegacy(LEGACY, addon);
    await writeFile(join(custom, 'opencode.json'), `{"plugins":[${JSON.stringify({ package: addon, options: { scopeRevision: REVISION } })}]}`);
    const other = createCompanionSetup({ ...g.options, env: { OPENCODE_CONFIG_DIR: custom } });
    expect(await other.retire()).toBe('removed');
    expect(parse(await readFile(join(custom, 'opencode.json'), 'utf8')).plugins).toEqual([]); expect(await readdir(join(custom, 'addons'))).toEqual([]);
    expect(await readdir(g.root)).toEqual([]);
  });

  it('waits while a reply is running, then acts; a check that fails counts as running', async () => {
    const f = await fixture(); await f.installLegacy(); const text = `{"plugins":[${f.entry()}]}`; await writeFile(f.config, text);
    let idle = false, asked = 0;
    const setup = createCompanionSetup({ ...f.options, idle: async () => { asked++; return idle; } });
    expect(await setup.retire()).toBe('waiting'); expect(await readFile(f.config, 'utf8')).toBe(text); expect(await readdir(f.addon)).toHaveLength(LEGACY.length + 1);
    const failing = createCompanionSetup({ ...f.options, idle: async () => { throw new Error('unreadable'); } });
    expect(await failing.retire()).toBe('waiting'); expect(await readFile(f.config, 'utf8')).toBe(text);
    idle = true; expect(await setup.retire()).toBe('removed'); expect(asked).toBe(2);
    expect(parse(await readFile(f.config, 'utf8')).plugins).toEqual([]);
  });

  it('leaves an edited or enlarged installation exactly as it is', async () => {
    for (const change of [
      async (f: Awaited<ReturnType<typeof fixture>>) => writeFile(join(f.addon, 'index.js'), '// the owner changed this\n'),
      async (f: Awaited<ReturnType<typeof fixture>>) => writeFile(join(f.addon, 'notes.txt'), 'mine'),
      async (f: Awaited<ReturnType<typeof fixture>>) => rm(join(f.addon, 'stream.js')),
    ]) {
      const f = await fixture(); await f.installLegacy(); const text = `{"plugins":[${f.entry()}]}`; await writeFile(f.config, text);
      await change(f); const names = (await readdir(f.addon)).sort();
      expect(await f.setup.retire()).toBe('manual');
      expect(await readFile(f.config, 'utf8')).toBe(text); expect((await readdir(f.addon)).sort()).toEqual(names);
      expect(await f.setup.status()).toMatchObject({ state: 'manual', managed: true, message: expect.stringContaining('files were edited') });
    }
  });

  it('never follows a marker that names a path outside its own folder', async () => {
    const f = await fixture(); await f.installLegacy();
    const outside = join(f.home, 'outside.txt'); await writeFile(outside, 'keep');
    await writeFile(join(f.addon, '.mlx-scope-owner.json'), JSON.stringify({ schemaVersion: 1, owner: COMPANION_ID, installedAtMs: 1, files: { '../../../../outside.txt': sha('keep') } }));
    const text = `{"plugins":[${f.entry()}]}`; await writeFile(f.config, text);
    expect(await f.setup.retire()).toBe('manual'); expect(await readFile(outside, 'utf8')).toBe('keep'); expect(await readFile(f.config, 'utf8')).toBe(text);
  });

  it('does not act where OpenChamber does not configure OpenCode', async () => {
    const environments = [(root: string) => ({ OPENCODE_CONFIG: join(root, 'own.json') }), () => ({ OPENCODE_HOST: 'http://127.0.0.1:4096' }), () => ({ OPENCODE_SKIP_START: 'true' })];
    for (const environment of environments) {
      const f = await fixture(); await f.installLegacy(); const text = `{"plugins":[${f.entry()}]}`; await writeFile(f.config, text);
      const setup = createCompanionSetup({ ...f.options, env: environment(f.root) });
      expect(await setup.retire()).toBe('blocked'); expect(await readFile(f.config, 'utf8')).toBe(text); expect(await readdir(f.addon)).toHaveLength(LEGACY.length + 1);
      expect(await setup.status()).toMatchObject({ state: 'manual', message: expect.stringContaining('does not configure') });
    }
    // A configuration file outside OpenCode's own folder is not read at all.
    const outside = await fixture({ env: { OPENCODE_CONFIG: '/anywhere/opencode.json' } }); await outside.installLegacy(); await writeFile(outside.config, `{"plugins":[${outside.entry()}]}`);
    expect(await outside.setup.retire()).toBe('none'); expect(await readdir(outside.addon)).toHaveLength(LEGACY.length + 1);
  });

  it('leaves a helper someone set up by hand alone: no owner marker, a different location, or an inline configuration', async () => {
    const manual = await fixture(); await manual.installLegacy(); await rm(join(manual.addon, '.mlx-scope-owner.json'));
    const text = `{"plugins":[${manual.entry()}]}`; await writeFile(manual.config, text);
    expect(await manual.setup.retire()).toBe('none'); expect(await readFile(manual.config, 'utf8')).toBe(text); expect(await readdir(manual.addon)).toHaveLength(LEGACY.length);
    const elsewhere = await fixture(); await elsewhere.installLegacy(); await writeFile(elsewhere.config, `{"plugins":[{"package":"/somewhere/else/${COMPANION_ID}"}]}`);
    expect(await elsewhere.setup.retire()).toBe('none'); expect(await readdir(elsewhere.addon)).toHaveLength(LEGACY.length + 1);
    const inline = await fixture({ env: { OPENCODE_CONFIG_CONTENT: '{}' } }); await inline.installLegacy(); await writeFile(inline.config, `{"plugins":[${inline.entry()}]}`);
    expect(await inline.setup.retire()).toBe('none'); expect(await readdir(inline.addon)).toHaveLength(LEGACY.length + 1);
  });

  it('does not follow a linked configuration folder', async () => {
    const f = await fixture(); const real = join(f.home, 'real-opencode'); await mkdir(real, { recursive: true });
    await rm(f.root, { recursive: true }); await symlink(real, f.root);
    await writeFile(join(real, 'opencode.json'), `{"plugins":[${f.entry()}]}`);
    expect(await f.setup.retire()).toBe('none'); expect(await readFile(join(real, 'opencode.json'), 'utf8')).toContain(COMPANION_ID);
  });

  it('refuses while another setup holds the lock, or when the configuration changes underneath it', async () => {
    const f = await fixture(); await f.installLegacy(); const text = `{"plugins":[${f.entry()}]}`; await writeFile(f.config, text);
    await writeFile(join(f.root, '.mlx-scope-setup.lock'), JSON.stringify({ owner: COMPANION_ID, pid: process.pid }));
    expect(await f.setup.retire()).toBe('waiting'); expect(await readFile(f.config, 'utf8')).toBe(text);
    await rm(join(f.root, '.mlx-scope-setup.lock'));
    const racing = createCompanionSetup({ ...f.options, beforeConfigCommit: async () => { await writeFile(f.config, `${text}\n`); } });
    expect(await racing.retire()).toBe('waiting'); expect(await readFile(f.config, 'utf8')).toBe(`${text}\n`); expect(await readdir(f.addon)).toHaveLength(LEGACY.length + 1);
    expect(await readdir(f.root)).not.toContain('.mlx-scope-setup.lock');
    expect(await f.setup.retire()).toBe('removed');
  });

  it('runs once for concurrent calls, and a removal that waited is tried again as a view polls, no faster than every 30 seconds', async () => {
    const f = await fixture(); await f.installLegacy(); await writeFile(f.config, `{"plugins":[${f.entry()}]}`);
    const [first, second] = await Promise.all([f.setup.retire(), f.setup.retire()]);
    expect([first, second].sort()).toEqual(['none', 'removed']);
    const g = await fixture(); await g.installLegacy(); const text = `{"plugins":[${g.entry()}]}`; await writeFile(g.config, text);
    let at = 1_000_000, asked = 0, idle = false;
    const setup = createCompanionSetup({ ...g.options, now: () => at, idle: async () => { asked++; return idle; } });
    const settle = () => new Promise(resolve => setTimeout(resolve, 20));
    setup.retry(); await settle(); expect(asked).toBe(0);                     // nothing has waited yet: polling does nothing
    await setup.status(); await setup.status(); await settle(); expect(asked).toBe(0);   // and reading status never acts
    expect(await setup.retire()).toBe('waiting'); expect(asked).toBe(1);
    setup.retry(); setup.retry(); await settle(); expect(asked).toBe(1);        // too soon
    at += 30_000; setup.retry(); await settle(); expect(asked).toBe(2);         // a poll after 30 s tries again, still busy
    idle = true; at += 30_000; setup.retry(); await settle(); expect(asked).toBe(3);
    expect(parse(await readFile(g.config, 'utf8')).plugins).toEqual([]); expect(await g.retired()).toBe(true);
    at += 60_000; setup.retry(); await settle(); expect(asked).toBe(3);         // done: polling does nothing more
  });
});

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser/lib/esm/main.js';
import { COMPANION_FILES, COMPANION_ID, createCompanionSetup, type CompanionProbe, type CompanionSetupOptions } from './companion-setup.ts';
import { version as companionVersion } from '../bridge/opencode/package.json';

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
async function fixture(text?: string, extra: Partial<CompanionSetupOptions> = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'mlx-scope-setup-'))); homes.push(home);
  const root = join(home, '.config', 'opencode'), bundle = join(home, 'bundle'), config = join(root, 'opencode.json');
  const addon = join(root, 'addons', COMPANION_ID);
  await mkdir(root, { recursive: true }); await mkdir(bundle);
  for (const name of COMPANION_FILES) await writeFile(join(bundle, name), name === 'package.json' ? JSON.stringify({ name: COMPANION_ID, version: companionVersion, type: 'module' }) : `// bundled ${name}\n`);
  if (text !== undefined) await writeFile(config, text, { mode: 0o600 });
  const options = { home, env: {}, bundleDirectory: bundle, ...extra };
  return { home, root, bundle, config, addon, options, setup: createCompanionSetup(options) };
}
const receipt = (at: number, extra: Partial<CompanionProbe> = {}): CompanionProbe => ({ companionVersion, protocol: 'opencode-2.0.25', runtimeVersion: '2.0.25', supported: true, loadedAtMs: at, ...extra });

describe('explicit companion setup', () => {
  it('status creates no files; enable installs the bundled package and a scoped entry', async () => {
    const f = await fixture();
    expect((await f.setup.status()).state).toBe('disabled');
    expect(await readdir(f.root)).toEqual([]);
    expect((await f.setup.enable()).state).toBe('pending');
    expect(parse(await readFile(f.config, 'utf8')).plugins).toEqual([{ package: f.addon, options: { promptProgress: false, scopeRevision: expect.stringMatching(/^[a-f0-9]{64}$/) } }]);
    expect((await stat(f.addon)).mode & 0o777).toBe(0o700);
    for (const name of COMPANION_FILES) expect((await stat(join(f.addon, name))).mode & 0o777).toBe(0o600);
    expect((await f.setup.status()).managed).toBe(true);
  });

  it('preserves JSONC comments, other plugins, existing companion options and idempotent config bytes', async () => {
    const f = await fixture();
    const original = `{
  // Keep this private configuration comment.
  "plugins": [
    "another-plugin", // keep its entry
    {"package": ${JSON.stringify(f.addon)}, "options": {"providerID":"custom-splash",/* keep these options */"baseURL":"http://localhost:9876/v1","custom":true}},
  ],
  "theme": "unchanged",
}\n`;
    await writeFile(f.config, original);
    await f.setup.enable();
    const installed = await readFile(f.config, 'utf8');
    expect(installed).toContain('// Keep this private configuration comment.');
    expect(installed).toContain('// keep its entry');
    expect(installed).toContain('/* keep these options */');
    expect(parse(installed).plugins).toEqual(['another-plugin', { package: f.addon, options: {
      providerID: 'custom-splash', baseURL: 'http://localhost:9876/v1', custom: true, scopeRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
    } }]);
    await f.setup.enable();
    expect(await readFile(f.config, 'utf8')).toBe(installed);
    expect((await f.setup.disable()).state).toBe('disabled');
    const disabled = await readFile(f.config, 'utf8');
    expect(disabled).toContain('// Keep this private configuration comment.');
    expect(disabled).toContain('// keep its entry');
    expect(parse(disabled)).toEqual({ plugins: ['another-plugin'], theme: 'unchanged' });
    expect(await readdir(join(f.root, 'addons'))).toEqual([]);
    expect((await f.setup.disable()).state).toBe('disabled');
  });

  it('uses existing JSONC and only configures discovered standalone Splash prompt progress', async () => {
    const f = await fixture();
    const config = join(f.root, 'opencode.jsonc');
    await writeFile(config, '{\n// Keep provider settings\n"providers":{"splish":{"settings":{"baseURL":"http://localhost:8111/v1"}}},"plugins":["other"],\n}\n');
    await f.setup.enable();
    const changed = await readFile(config, 'utf8');
    expect(changed).toContain('// Keep provider settings');
    expect(parse(changed).plugins).toEqual(['other', { package: f.addon, options: { providerID: 'splish', baseURL: 'http://127.0.0.1:8111/v1', scopeRevision: expect.stringMatching(/^[a-f0-9]{64}$/) } }]);
    expect(await readdir(f.root)).not.toContain('opencode.json');
  });

  it('honors the explicit global configuration root', async () => {
    const f = await fixture();
    const root = join(f.home, 'custom-opencode');
    const setup = createCompanionSetup({ ...f.options, env: { OPENCODE_CONFIG_DIR: root } });
    await setup.enable();
    expect(parse(await readFile(join(root, 'opencode.json'), 'utf8')).plugins[0].package).toBe(join(root, 'addons', COMPANION_ID));
    expect(await readdir(f.root)).toEqual([]);
  });

  it('honors provider overlays and never enables progress for an overridden remote endpoint', async () => {
    for (const overlay of [
      { provider: { splish: { options: { baseURL: 'https://remote.example/v1' } } } },
      { providers: { splish: { settings: { baseURL: 'https://remote.example/v1' } } } },
    ]) {
      const f = await fixture(JSON.stringify({ provider: { splish: { options: { baseURL: 'http://localhost:8000/v1' } } } }));
      const path = join(f.root, 'opencode.jsonc'); await writeFile(path, JSON.stringify(overlay));
      await f.setup.enable();
      expect(parse(await readFile(path, 'utf8')).plugins[0].options).toEqual({ promptProgress: false, scopeRevision: expect.stringMatching(/^[a-f0-9]{64}$/) });
    }
  });

  it('preserves compact plugin comments while appending and removing the managed entry', async () => {
    for (const plugins of ['["first"/* keep A */]', '["first", /* keep B */]', '[/* keep C */]']) {
      const f = await fixture(`{"plugins":${plugins},"setting":true}`);
      expect((await f.setup.enable()).state).toBe('pending');
      const installed = await readFile(f.config, 'utf8');
      expect(installed).toContain(plugins.match(/\/\*.*?\*\//)![0]);
      expect(parse(installed).plugins.at(-1).package).toBe(f.addon);
      expect((await f.setup.disable()).state).toBe('disabled');
      expect(parse(await readFile(f.config, 'utf8')).plugins).toEqual(parse(plugins));
    }
  });

  it('refuses edited managed source and an active setup lock without replacing either', async () => {
    const f = await fixture('{}'); await f.setup.enable();
    await writeFile(join(f.addon, 'index.js'), '// user customization');
    expect((await f.setup.enable()).message).toContain('edited after installation');
    expect(await readFile(join(f.addon, 'index.js'), 'utf8')).toBe('// user customization');
    const g = await fixture('{}'), lock = join(g.root, '.mlx-scope-setup.lock');
    const locked = JSON.stringify({ owner: COMPANION_ID, pid: process.pid }); await writeFile(lock, locked);
    expect((await g.setup.enable()).message).toContain('setup is in progress');
    expect(await readFile(lock, 'utf8')).toBe(locked);
    expect(await readFile(g.config, 'utf8')).toBe('{}');
  });

  it('preserves unrelated files through upgrade and removal; modified managed files survive', async () => {
    const f = await fixture('{}'); await f.setup.enable();
    await writeFile(join(f.addon, 'notes.txt'), 'My unrelated notes');
    await f.setup.enable();
    await writeFile(join(f.addon, 'README.md'), 'My changes');
    await f.setup.disable();
    expect(await readFile(join(f.addon, 'notes.txt'), 'utf8')).toBe('My unrelated notes');
    expect(await readFile(join(f.addon, 'README.md'), 'utf8')).toBe('My changes');
    expect((await readdir(f.addon)).sort()).toEqual(['README.md', 'notes.txt']);
  });

  it('adopts the known legacy companion and retains its provider options', async () => {
    const f = await fixture(); await mkdir(f.addon, { recursive: true });
    await writeFile(join(f.addon, 'package.json'), JSON.stringify({ name: COMPANION_ID, version: '1.0.0' }));
    await writeFile(join(f.addon, 'index.js'), '// old package');
    const config = JSON.stringify({ plugins: [{ package: f.addon, options: { providerID: 'splish', baseURL: 'http://localhost:8000/v1' } }] });
    await writeFile(f.config, config);
    expect((await f.setup.enable()).managed).toBe(true);
    expect(parse(await readFile(f.config, 'utf8')).plugins[0]).toEqual({ package: f.addon,
      options: { providerID: 'splish', baseURL: 'http://localhost:8000/v1', scopeRevision: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(await readFile(join(f.addon, 'index.js'), 'utf8')).toBe('// bundled index.js\n');
  });

  it('disables an unowned legacy entry without deleting its installation', async () => {
    const f = await fixture(); await mkdir(f.addon, { recursive: true });
    await writeFile(join(f.addon, 'package.json'), JSON.stringify({ name: COMPANION_ID }));
    await writeFile(f.config, JSON.stringify({ plugins: [f.addon] }));
    expect((await f.setup.disable()).state).toBe('disabled');
    expect(await readFile(join(f.addon, 'package.json'), 'utf8')).toContain(COMPANION_ID);
  });

  it('changes only the owned config revision when bundled files change and stays byte-stable otherwise', async () => {
    const f = await fixture('{"plugins":["other"],"setting":{"untouched":true}}');
    await f.setup.enable();
    const before = parse(await readFile(f.config, 'utf8'));
    await writeFile(join(f.bundle, 'index.js'), '// updated helper\n');
    await f.setup.enable();
    const updated = await readFile(f.config, 'utf8'), after = parse(updated);
    expect(after.plugins[1].options.scopeRevision).not.toBe(before.plugins[1].options.scopeRevision);
    expect({ ...after.plugins[1].options, scopeRevision: undefined }).toEqual({ ...before.plugins[1].options, scopeRevision: undefined });
    expect(after.plugins[0]).toBe('other'); expect(after.setting).toEqual(before.setting);
    await f.setup.enable(); expect(await readFile(f.config, 'utf8')).toBe(updated);
  });

  it('upgrades a string entry without changing its configured package path or adjacent comments', async () => {
    const f = await fixture();
    await writeFile(f.config, `{"plugins":["other",/* keep */${JSON.stringify(f.addon)}]}`);
    await f.setup.enable();
    const installed = await readFile(f.config, 'utf8');
    expect(installed).toContain('/* keep */');
    expect(parse(installed).plugins).toEqual(['other', { package: f.addon, options: { scopeRevision: expect.stringMatching(/^[a-f0-9]{64}$/) } }]);
  });

  it('preserves invalid existing options and leaves installation untouched', async () => {
    const f = await fixture();
    const config = JSON.stringify({ plugins: [{ package: f.addon, options: 'user-value' }] });
    await writeFile(f.config, config);
    expect((await f.setup.enable()).state).toBe('manual');
    expect(await readFile(f.config, 'utf8')).toBe(config);
    expect(await readdir(f.root)).toEqual(['opencode.json']);
  });

  it('rolls back installed files on a failed config commit', async () => {
    const f = await fixture('{"plugins":["other"]}'); await f.setup.enable();
    const oldConfig = await readFile(f.config, 'utf8'), oldEntry = await readFile(join(f.addon, 'index.js'), 'utf8');
    await writeFile(join(f.bundle, 'index.js'), '// new package');
    const setup = createCompanionSetup({ ...f.options, beforeConfigCommit: async () => { throw new Error('simulated failure'); } });
    expect(await setup.enable()).toMatchObject({ state: 'error' });
    expect(await readFile(f.config, 'utf8')).toBe(oldConfig);
    expect(await readFile(join(f.addon, 'index.js'), 'utf8')).toBe(oldEntry);
    expect((await readdir(join(f.root, 'addons')))).toEqual([COMPANION_ID]);
    expect(await readdir(f.root)).not.toContain('.mlx-scope-setup.lock');
  });

  it('preserves a competing config edit and rolls back a new addon', async () => {
    const f = await fixture('{"plugins":["other"]}');
    const newer = '{"plugins":["other","new-user-plugin"]}';
    const setup = createCompanionSetup({ ...f.options, beforeConfigCommit: () => writeFile(f.config, newer) });
    expect((await setup.enable()).message).toContain('changed during setup');
    expect(await readFile(f.config, 'utf8')).toBe(newer);
    expect(await readdir(join(f.root, 'addons'))).toEqual([]);
  });

  it('refuses malformed config, duplicate entries and a separately installed companion', async () => {
    const f = await fixture('{broken');
    expect((await f.setup.enable()).state).toBe('manual');
    expect(await readFile(f.config, 'utf8')).toBe('{broken');
    await writeFile(f.config, JSON.stringify({ plugins: [f.addon, { package: f.addon }] }));
    expect((await f.setup.enable()).message).toContain('Several companion entries');
    await writeFile(f.config, JSON.stringify({ plugins: [join(f.home, 'another', COMPANION_ID)] }));
    expect((await f.setup.enable()).message).toContain('another location');
  });

  it('refuses symlinks without changing their targets', async () => {
    const f = await fixture(), privateFile = join(f.home, 'private.json');
    await writeFile(privateFile, '{"private":true}'); await symlink(privateFile, f.config);
    expect((await f.setup.enable()).canEnable).toBe(false);
    expect(await readFile(privateFile, 'utf8')).toBe('{"private":true}');
  });

  it('refuses inline, relative and out-of-root overrides without creating installation files', async () => {
    const f = await fixture('{}');
    for (const env of [{ OPENCODE_CONFIG_CONTENT: '{}' }, { OPENCODE_CONFIG_DIR: 'relative' }, { OPENCODE_CONFIG: join(f.home, 'other.json') }]) {
      expect((await createCompanionSetup({ ...f.options, env }).enable()).state).toBe('manual');
    }
    expect(await readdir(f.root)).toEqual(['opencode.json']);
  });

  it('qualifies startup metadata without claiming it is a live connection', async () => {
    const at = 10_000, f = await fixture('{}', { now: () => at });
    await f.setup.enable();
    let probe = receipt(at);
    const setup = createCompanionSetup({ ...f.options, now: () => at + 100, probe: async () => probe });
    expect(await setup.status()).toMatchObject({ state: 'ready', live: false, runtimeVersion: '2.0.25', message: 'Chat tracking is ready for your next local reply.' });
    probe = receipt(at, { updatedAtMs: at, expiresAtMs: at + 15_000 });
    expect((await setup.status()).live).toBe(true);
    probe = receipt(at, { companionVersion: '3.0.0', updatedAtMs: at, expiresAtMs: at + 15_000 });
    expect(await setup.status()).toMatchObject({ state: 'pending', live: false,
      message: 'Installed · waiting for OpenCode to load the updated tracking helper. Your current work can continue.' });
    await writeFile(join(f.addon, 'package.json'), JSON.stringify({ name: COMPANION_ID, version: '3.0.0' }));
    expect(await setup.status()).toMatchObject({ state: 'pending', live: false,
      message: 'Update chat speed to install the current tracking helper.' });
    probe = receipt(at, { runtimeVersion: '2.0.26', supported: false, protocol: 'unsupported' });
    const before = await readFile(f.config, 'utf8');
    expect(await setup.enable()).toMatchObject({ state: 'incompatible', canEnable: false, canDisable: true });
    expect(await readFile(f.config, 'utf8')).toBe(before);
  });

  it('serializes enable clicks and never duplicates the entry', async () => {
    const f = await fixture('{}');
    const results = await Promise.all([f.setup.enable(), f.setup.enable(), f.setup.enable()]);
    expect(results.every(result => result.state === 'pending')).toBe(true);
    expect(parse(await readFile(f.config, 'utf8')).plugins).toHaveLength(1);
  });
});

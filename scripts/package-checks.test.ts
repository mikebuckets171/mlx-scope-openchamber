import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseManifestJson } from '@openchamber/sdk/schemas';
import {
  BUNDLE_CEILINGS, cspOf, EXEC_G1, execMatch, guestLeaks, manifestProblems, rootBlock, serviceLeaks, spawnPaths, tokenDeclarations,
} from './package-checks.ts';

const root = join(import.meta.dir, '..');
const read = (file: string): string => readFileSync(join(root, file), 'utf8');
const pkg = JSON.parse(read('package.json'));

describe('the 2.0 manifest (plan §6 with the G1/S2 amendments)', () => {
  test('parses with SDK 2.0.4 and matches the frozen set exactly', () => {
    const parsed = parseManifestJson(read('package.json'));
    expect(parsed.ok).toBe(true);
    expect(manifestProblems(pkg)).toEqual([]);
    expect(pkg.dependencies['@openchamber/sdk']).toBe('2.0.4');
  });
  test('any drift is named: a capability, a missing exec entry, a different floor or command', () => {
    const changed = structuredClone(pkg);
    changed.openchamber.contributes.capabilities = ['sessions'];
    changed.openchamber.contributes.service.permissions.exec = EXEC_G1.slice(1);
    changed.openchamber.engines.openchamber = '>=2.0.1';
    changed.openchamber.contributes.commands = [{ name: 'scope' }];
    delete changed.openchamber.contributes.statusSection;
    expect(manifestProblems(changed)).toEqual([
      'engines.openchamber must be ">=2.0.4"',
      'contributes.capabilities must be absent (S2: sessions dropped)',
      'contributes.statusSection must be {"entry":"panel/index.html","title":"MLX Scope","height":72}',
      'contributes.commands must be exactly [{"name":"scope","description":"Attach a private MLX Scope diagnostics summary"}]',
      'service exec must be exactly the 10 G1 entries, in order',
    ]);
  });
  test('ships the background entry and bundle, and the extracted tokens', () => {
    for (const file of ['background/index.html', 'background/main.js', 'ui/tokens.css']) expect(pkg.files).toContain(file);
    expect(pkg.scripts.build).toContain('build:background');
    expect(pkg.scripts.test).toContain('./background');
  });
});

describe('two-way exec match', () => {
  const bundle = (paths: string[]) => paths.map(path => `spawn(${JSON.stringify(path)},[])`).join(';');
  const home = (paths: readonly string[]) => paths.map(path => path.startsWith('~/') ? path.slice(2) : path);
  test('passes when the service spawns exactly the declared set, ~/ entries as HOME-relative literals', () => {
    expect(execMatch(EXEC_G1, bundle(home(EXEC_G1)))).toEqual({ unspawned: [], undeclared: [] });
  });
  test('names a declared entry that is never spawned, and a spawn that is not declared', () => {
    const spawned = [...home(EXEC_G1).filter(path => path !== '/usr/sbin/ioreg'), '/bin/ps', '.lmstudio-pointed/bin/lms'];
    expect(execMatch(EXEC_G1, bundle(spawned))).toEqual({ unspawned: ['/usr/sbin/ioreg'], undeclared: ['/bin/ps', '~/.lmstudio-pointed/bin/lms'] });
  });
  test('argv.ts, once bundled into the service, names exactly the declared set (so integration closes the match)', async () => {
    const built = await Bun.build({ entrypoints: [join(root, 'service/lib/argv.ts')], target: 'node', format: 'esm', minify: true });
    expect(built.success).toBe(true);
    // The minifier keeps exports; the literals must survive as whole strings.
    expect(execMatch(EXEC_G1, await built.outputs[0]!.text())).toEqual({ unspawned: [], undeclared: [] });
  });
  test('ignores what is not an executable path: PATH lists, routes, config files and plain words', () => {
    expect(spawnPaths('env={PATH:"/usr/bin:/bin"};get("/v2/snapshot");join(home,".omlx","settings.json");x="lms";y=\'/usr/bin/\'')).toEqual([]);
    expect(spawnPaths('a=`/opt/homebrew/bin/macmon`;b=\'/usr/libexec/x\'')).toEqual(['/opt/homebrew/bin/macmon', '/usr/libexec/x']);
  });
});

describe('bundles and pages', () => {
  test('service progress allowance preserves the panel and background ceilings', () => {
    expect(BUNDLE_CEILINGS).toEqual({ 'panel/main.js': 264_000, 'service/main.js': 180_000, 'background/main.js': 25_000 });
  });
  test('the background page declares exactly the panel CSP', () => {
    const panel = cspOf(read('panel/index.html'));
    expect(panel).toContain("default-src 'none'");
    expect(cspOf(read('background/index.html'))).toBe(panel);
    expect(cspOf('<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">')).toBe("default-src 'self'");
    expect(cspOf('<meta charset="utf-8">')).toBeNull();
  });
  test('leak checks name host-only code in guest bundles and a settings.json read in the service', () => {
    expect(guestLeaks('import("node:child_process");x="/Users/someone"')).toEqual(['node:child_process', '/Users/']);
    expect(guestLeaks('<code>/usr/sbin/ioreg</code>')).toEqual([]);
    expect(serviceLeaks('join(home,".config","openchamber","settings.json")')).toHaveLength(1);
    expect(serviceLeaks('join(home,".omlx","settings.json")')).toEqual([]);
  });
});

test('ui/tokens.css stays in sync with the panel theme tokens', () => {
  const extracted = tokenDeclarations(rootBlock(read('ui/tokens.css'))!);
  const panel = new Map(tokenDeclarations(rootBlock(read('panel/style.css'))!));
  expect(extracted.length).toBeGreaterThan(20);
  // Consumers of the extracted tokens get the same current-theme fallbacks as the panel.
  for (const [name, value] of extracted) expect(panel.get(name)).toBe(value);
});

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseManifestJson } from '@openchamber/sdk/schemas';
import {
  BUNDLE_CEILINGS, cspOf, EXEC_G1, execMatch, guestLeaks, manifestProblems, PANEL_CSP, rootBlock, serviceLeaks, spawnPaths, tokenDeclarations,
} from './package-checks.ts';

const root = join(import.meta.dir, '..');
const read = (file: string): string => readFileSync(join(root, file), 'utf8');
const pkg = JSON.parse(read('package.json'));

describe('the Next manifest with the approved awareness grants', () => {
  test('parses with SDK 2.5.0 and matches the frozen set exactly', () => {
    const parsed = parseManifestJson(read('package.json'));
    expect(parsed.ok).toBe(true);
    expect(manifestProblems(pkg)).toEqual([]);
    expect(pkg.dependencies['@openchamber/sdk']).toBe('2.5.0');
  });
  test('any drift is named: a capability, a missing exec entry, a different floor, a command or a second SDK', () => {
    const changed = structuredClone(pkg);
    changed.openchamber.contributes.capabilities = ['sessions', 'shells'];
    changed.openchamber.contributes.service.permissions.exec = EXEC_G1.slice(1);
    changed.openchamber.engines.openchamber = '>=2.3.3';
    changed.openchamber.contributes.commands = [{ name: 'scope' }];
    changed.openchamber.contributes.background = { entry: 'background/index.html' };
    changed.dependencies['@openchamber/sdk-background'] = 'npm:@openchamber/sdk@2.0.4';
    delete changed.openchamber.contributes.statusSection;
    expect(manifestProblems(changed)).toEqual([
      'engines.openchamber must be ">=2.4.0"',
      'contributes.capabilities must be exactly sessions',
      'only one OpenChamber SDK may be a dependency',
      'contributes.statusSection must be {"entry":"panel/index.html","title":"MLX Scope","height":72}',
      'contributes.background must be absent: 5.1 has no background entry',
      'contributes.commands must be absent: 5.1 has no slash command',
      'service exec must be exactly the 11 G1 entries, in order',
    ]);
  });
  test('ships no background entry, and ships the extracted tokens', () => {
    expect(pkg.files.some((file: string) => file.startsWith('background/'))).toBe(false);
    expect(pkg.files).toContain('ui/tokens.css');
    expect(pkg.scripts.build).not.toContain('background');
    expect(pkg.scripts.test).not.toContain('background');
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
  test('the guest and service ceilings stay fixed', () => {
    expect(BUNDLE_CEILINGS).toEqual({ 'panel/main.js': 270_000, 'service/main.js': 268_000 });
  });
  test('the panel page declares exactly the approved CSP', () => {
    expect(cspOf(read('panel/index.html'))).toBe(PANEL_CSP);
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

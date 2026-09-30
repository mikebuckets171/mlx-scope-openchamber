import { parseManifestJson } from '@openchamber/sdk/schemas';
import { basename, dirname, join, posix } from 'node:path';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { BUNDLE_CEILINGS, cspOf, execMatch, GUEST_BUNDLES, guestLeaks, manifestProblems, serviceLeaks } from './package-checks.ts';
const root = join(import.meta.dir, '..');
// Every failed check is listed, not only the first, so one run shows the whole gap (e.g. exec entries not wired yet).
const problems: string[] = [];
const check = (ok: boolean, message: string): void => { if (!ok) problems.push(message); };
const document = await Bun.file(join(root, 'package.json')).text();
const parsed = parseManifestJson(document);
if (!parsed.ok) throw new Error(`OpenChamber manifest: ${parsed.message}`);
const pkg = JSON.parse(document);
problems.push(...manifestProblems(pkg));
const entries: string[] = pkg.files;
if (!Array.isArray(entries) || entries.some(entry => typeof entry !== 'string')) throw new Error('Package files must be an explicit file allowlist.');
for (const file of ['panel/index.html', 'panel/main.js', 'panel/style.css', 'panel/scope-icon.svg', 'service/main.js', 'background/index.html',
  'background/main.js', 'ui/tokens.css', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  if (!entries.includes(file) || !await Bun.file(join(root, file)).exists()) throw new Error(`Missing installable asset: ${file}`);
}
let bytes = 0;
for (const entry of entries) {
  if (entry.includes('..') || entry.startsWith('/') || posix.normalize(entry) !== entry || /\.(ts|test\.js)$/.test(entry)) throw new Error(`Unsafe or source-only package entry: ${entry}`);
  const file = Bun.file(join(root, entry));
  if (!await file.exists()) throw new Error(`Missing package entry: ${entry}`);
  if (!lstatSync(join(root, entry)).isFile()) throw new Error(`Package entry is not a regular file: ${entry}`);
  bytes += file.size;
}
// Docs travel in the installation ZIP. Relative links must work there too.
for (const entry of entries.filter(name => name.endsWith('.md'))) {
  const markdown = (await Bun.file(join(root, entry)).text()).replace(/```[\s\S]*?```/g, '');
  for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)) {
    const href = match[1]!;
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) continue;
    const target = posix.normalize(posix.join(posix.dirname(entry), decodeURIComponent(href.split(/[?#]/)[0]!)));
    if (!entries.includes(target)) throw new Error(`Broken package link in ${entry}: ${href}`);
  }
}
const text = (file: string) => Bun.file(join(root, file)).text();
for (const [file, ceiling] of Object.entries(BUNDLE_CEILINGS)) {
  const size = Bun.file(join(root, file)).size;
  check(size <= ceiling, `${file} is ${size} bytes; the ceiling is ${ceiling} (plan §6).`);
}
for (const file of GUEST_BUNDLES) {
  const leaks = guestLeaks(await text(file));
  check(!leaks.length, `Host-only code leaked into ${file}: ${leaks.join(', ')}`);
}
// The background frame runs under exactly the panel's policy (plan §6), which the host's guestFramePolicy already allows.
const panelPolicy = cspOf(await text('panel/index.html'));
check(panelPolicy !== null && cspOf(await text('background/index.html')) === panelPolicy, 'background/index.html must declare the CSP of panel/index.html.');
const service = await text('service/main.js');
check(!serviceLeaks(service).length, `The service bundle reads OpenChamber settings or carries a home path: ${serviceLeaks(service).join(', ')}`);
// The service reads only when a view asks (P5), and serves contract v2 with the 1.x route retired.
check(!/\bsetInterval\b/.test(service), 'The service bundle must not schedule repeating work.');
for (const route of ['/v2/snapshot', '/v2/trend', '/v2/usage', 'contract_mismatch']) check(service.includes(route), `The service bundle does not serve ${route}.`);
// Two-way exec match (plan §6): what the approval dialog lists is exactly what the service can spawn.
const exec = execMatch(pkg.openchamber?.contributes?.service?.permissions?.exec ?? [], service);
check(!exec.unspawned.length, `Declared exec entries the service bundle never spawns: ${exec.unspawned.join(', ')}`);
check(!exec.undeclared.length, `Executables the service bundle spawns without declaring them: ${exec.undeclared.join(', ')}`);
// A coarse regression ceiling catches accidental dependencies or build artifacts.
// Runtime overhead is measured separately; this is not a product size target.
check(bytes <= 2 * 1024 * 1024, 'Installable content exceeds 2 MiB. Review the package allowlist and dependency change.');
// Build from a fresh staging directory, never update a pre-existing ZIP.
// Fixed file order, mode and timestamp make repeat builds reproducible.
const stage = mkdtempSync(join(tmpdir(), 'mlx-scope-package-'));
const archive = join(root, 'dist', `${pkg.name}-${pkg.version}.zip`);
const names = [...entries].sort();
if (new Set(names).size !== names.length) throw new Error('Duplicate package entries.');
const command = (file: string, args: string[], cwd = stage, timeout = 10_000): string => {
  const result = spawnSync(file, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 1_000_000, env: { ...process.env, TZ: 'UTC' } });
  if (result.error || result.status !== 0) throw new Error(`${file} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
};
try {
  for (const name of names) {
    const path = join(stage, name);
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, Bun.file(join(root, name)));
    chmodSync(path, 0o644);
    utimesSync(path, 946684800, 946684800);
  }
  mkdirSync(dirname(archive), { recursive: true });
  rmSync(archive, { force: true });
  command('zip', ['-X', '-q', archive, ...names]);
  const repeated = join(stage, 'repeated.zip');
  command('zip', ['-X', '-q', repeated, ...names]);
  const archiveBytes = Buffer.from(await Bun.file(archive).bytes());
  if (!archiveBytes.equals(Buffer.from(await Bun.file(repeated).bytes()))) throw new Error('Repeated packaging was not byte-identical.');
  const listed = command('unzip', ['-Z1', archive]).trim().split('\n').sort();
  if (JSON.stringify(listed) !== JSON.stringify(names)) throw new Error('ZIP differs from the package allowlist.');
  const extracted = join(stage, 'extracted');
  command('unzip', ['-q', archive, '-d', extracted]);
  for (const name of names) {
    const original = await Bun.file(join(root, name)).bytes();
    const copy = await Bun.file(join(extracted, name)).bytes();
    if (!Buffer.from(original).equals(Buffer.from(copy))) throw new Error(`ZIP content mismatch: ${name}`);
  }
  const smoke = command('node', [join(root, 'scripts/smoke-service.mjs'), extracted], extracted, 20_000);
  process.stdout.write(smoke);
  if (!smoke.includes('/v2/snapshot, the retired /snapshot 410')) throw new Error('The packaged smoke did not verify the v2 routes.');
  const digest = createHash('sha256').update(archiveBytes).digest('hex');
  await Bun.write(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`);
  console.log(`SHA-256: ${digest}  ${basename(archive)}`);
  if (problems.length) {
    console.error(`FAIL: ${problems.length} package check${problems.length === 1 ? '' : 's'}:\n- ${problems.join('\n- ')}`);
    process.exitCode = 1;
  } else console.log(`PASS: SDK 2.0.4 manifest (§6 set, two-way exec match), ${names.length} assets, ${bytes} uncompressed bytes; ${archiveBytes.byteLength} ZIP bytes; `
    + `bundle ceilings, background CSP and leak checks; reproducible archive and extracted bytes verified.`);
} finally { rmSync(stage, { recursive: true, force: true }); }

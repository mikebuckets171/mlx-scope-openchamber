import { parseManifestJson } from '@openchamber/sdk/schemas';
import { basename, dirname, join, posix } from 'node:path';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const root = join(import.meta.dir, '..');
const document = await Bun.file(join(root, 'package.json')).text();
const parsed = parseManifestJson(document);
if (!parsed.ok) throw new Error(`OpenChamber manifest: ${parsed.message}`);
const pkg = JSON.parse(document);
const sessionAction = pkg.openchamber?.contributes?.actions?.find((action: { id?: string; where?: string }) => action.id === 'open-mlx-scope' && action.where === 'session');
if (!sessionAction) throw new Error('Missing session action: open-mlx-scope');
const entries: string[] = pkg.files;
if (!Array.isArray(entries) || entries.some(entry => typeof entry !== 'string')) throw new Error('Package files must be an explicit file allowlist.');
for (const file of ['panel/index.html', 'panel/main.js', 'panel/style.css', 'panel/scope-icon.svg', 'service/main.js', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
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
const panel = await Bun.file(join(root, 'panel/main.js')).text();
if (['node:os', 'node:fs', 'node:child_process', 'MLX_SCOPE_API_KEY', '/usr/bin/vm_stat', '/usr/sbin/sysctl'].some((secret) => panel.includes(secret))) throw new Error('Host-only code leaked into the panel');
// A coarse regression ceiling catches accidental dependencies or build artifacts.
// Runtime overhead is measured separately; this is not a product size target.
if (bytes > 2 * 1024 * 1024) throw new Error('Installable content exceeds 2 MiB. Review the package allowlist and dependency change.');
if (pkg.openchamber?.contributes?.page !== true) throw new Error('Full-page monitor surface is missing.');
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
  process.stdout.write(command('node', [join(root, 'scripts/smoke-service.mjs'), extracted], extracted, 20_000));
  const digest = createHash('sha256').update(archiveBytes).digest('hex');
  await Bun.write(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`);
  console.log(`PASS: SDK manifest, ${names.length} assets, ${bytes} uncompressed bytes; ${archiveBytes.byteLength} ZIP bytes; reproducible archive and extracted bytes verified.`);
  console.log(`SHA-256: ${digest}  ${basename(archive)}`);
} finally { rmSync(stage, { recursive: true, force: true }); }

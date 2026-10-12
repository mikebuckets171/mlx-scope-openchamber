// Synthetic qualification only. No mode starts a native host, installs a candidate, or sends a prompt.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURE_IDS, profileFor } from '../bridge/opencode/compatibility.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureVersion = '2.0.25';
const versionPattern = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/;
const versionOK = value => typeof value === 'string' && value.length <= 64 && versionPattern.test(value);
const usage = 'Usage: node scripts/qualify-compatibility.mjs [--candidate OpenCode-version] [--output report.json]. Synthetic fixtures only.';
export const CHECK_SUITES = [
  { id: 'bridge', executable: 'node', args: ['--test', ...['bridge', 'chat', 'websocket', 'compatibility'].map(name => `bridge/opencode/${name}.test.js`)] },
  { id: 'service', executable: 'bun', args: ['test', ...['companion-setup', 'chat-telemetry', 'chat-telemetry-review'].map(name => `service/${name}.test.ts`)] },
  { id: 'host-storage', executable: 'bun', args: ['test', 'panel/host', 'panel/sdk-theme.test.ts', 'panel/attribution',
    'panel/state/follow-chat.test.ts', 'panel/data/client.test.ts', 'panel/data/visibility.test.ts', 'panel/data/poller.test.ts',
    'panel/testing/storage.test.ts', 'panel/history/storage-compatibility.test.ts', 'panel/history/migrate-v1.test.ts',
    'panel/history/ledger.test.ts', 'panel/history/prefs.test.ts', 'panel/captures/store.test.ts', 'background'] },
  { id: 'privacy', executable: 'bun', args: ['scripts/scan-committed.ts'] },
  { id: 'build-consistency', executable: 'bun', args: ['scripts/check-built-artifacts.ts'] },
  // Verifies the existing bundles, a reproducible ZIP and its extracted service under the synthetic smoke host.
  // No product bundle is overwritten: an artifact receipt identifies exactly the bytes under review.
  { id: 'package', executable: 'bun', args: ['scripts/verify-package.ts'] },
];
export const REQUIRED_CHECKS = [...CHECK_SUITES.map(check => check.id), 'source-consistency'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const inputFingerprint = hashes => digest(JSON.stringify(Object.keys(hashes).sort().map(group =>
  [group, Object.entries(hashes[group]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)])));
export const sameInputs = (before, after) => inputFingerprint(before) === inputFingerprint(after);

export function parseOptions(args) {
  const options = { candidate: fixtureVersion }, seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!['--candidate', '--output'].includes(key) || seen.has(key) || !value || value.startsWith('--')) throw new Error(usage);
    seen.add(key); options[key.slice(2)] = value;
  }
  if (!versionOK(options.candidate)) throw new Error(usage);
  return options;
}

/** Never follow arbitrary manifest paths when constructing a shareable, repository-relative inventory. */
export function packageEntries(pkg) {
  if (!Array.isArray(pkg.files) || new Set(pkg.files).size !== pkg.files.length || pkg.files.some(name => typeof name !== 'string'
    || !name || name.includes('..') || name.includes('\\') || name.startsWith('/') || posix.normalize(name) !== name))
    throw new Error('The package must have a safe, explicit file allowlist.');
  return [...pkg.files].sort();
}

const sourceRoots = ['panel', 'service', 'background', 'src', 'bridge', 'scripts', 'tests'];
const profiles = ['bridge/opencode/compatibility.js'];
const dependencies = ['package.json', 'bun.lock', 'tsconfig.json', 'node_modules/@openchamber/sdk/package.json',
  'node_modules/@openchamber/sdk/dist/host.js', 'node_modules/@openchamber/sdk/dist/contract.js', 'node_modules/@openchamber/sdk/dist/ui/theme.js'];
const readHashes = async (directory, names) => Object.fromEntries(await Promise.all([...new Set(names)].sort().map(async name => {
  if (!(await lstat(join(directory, name))).isFile()) throw new Error('Qualification inputs must be regular files.');
  return [name, digest(await readFile(join(directory, name)))];
})));
export async function collectInputs(directory) {
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')), assets = packageEntries(pkg), files = [];
  for (const base of sourceRoots) {
    for (const entry of await readdir(join(directory, base), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:[cm]?js|ts|json)$/.test(entry.name)) continue;
      const path = posix.join(base, ...resolve(entry.parentPath, entry.name).slice(resolve(directory, base).length + 1).split(/[\\/]/));
      if (!assets.includes(path)) files.push(path);
    }
  }
  const fixtures = files.filter(name => name.startsWith('tests/') || /(?:\.test\.|\/testing(?:\/|\.))/.test(name));
  const sources = files.filter(name => !fixtures.includes(name) && !profiles.includes(name));
  // Packaged companion sources also belong to the adapter/source inventory; asset and source hashes must agree.
  sources.push(...assets.filter(name => name.startsWith('bridge/') && /\.js$/.test(name)));
  return { sources: await readHashes(directory, sources), fixtures: await readHashes(directory, fixtures),
    profiles: await readHashes(directory, profiles), assets: await readHashes(directory, assets), dependencies: await readHashes(directory, dependencies) };
}

const resultFor = (checks, ids) => ids.some(id => checks.some(check => check.id === id && check.result === 'fail')) ? 'failed'
  : ids.every(id => checks.some(check => check.id === id && check.result === 'pass')) ? 'passed' : 'skipped';
export function qualificationReport(checks, hashes, at, context = {}) {
  const candidateVersion = context.candidate ?? fixtureVersion, profile = profileFor(candidateVersion);
  const completeHashes = ['sources', 'fixtures', 'profiles', 'assets', 'dependencies'].every(group => Object.keys(hashes[group] ?? {}).length > 0);
  const passed = completeHashes && resultFor(checks, REQUIRED_CHECKS) === 'passed' && checks.every(check => check.result === 'pass');
  const inputs = inputFingerprint(hashes), identity = { candidate: candidateVersion, hostSdk: context.hostSdk ?? null,
    hostApi: context.hostApi ?? null, companionVersion: context.companionVersion ?? null };
  const features = Object.fromEntries(FEATURE_IDS.map(id => [id, {
    result: profile ? resultFor(checks, [id === 'managed-reload' ? 'service' : 'bridge', 'source-consistency']) : 'unqualified',
    support: profile ? 'qualified' : 'unqualified',
    fixtures: checks.find(check => check.id === (id === 'managed-reload' ? 'service' : 'bridge'))?.result ?? 'not-run', nativeRuntime: 'not-run',
    limitation: id === 'managed-reload' ? 'File/configuration mocks do not prove native watcher activation or uninterrupted live replies.'
      : id === 'websocket-delivery' ? profile?.websocketCancellation === 'native'
        ? 'Mock hooks and interruption only; native cancellation has a separate version-specific receipt.'
        : 'Mock hooks and interruption only; native cancellation remains unqualified.'
        : id === 'prompt-progress' ? 'Synthetic counters and byte passthrough do not prove progress through a live llama-swap backend.'
          : 'Synthetic event fixtures do not prove semantics of another OpenCode release.',
  }]));
  for (const [id, check, limitation] of [
    ['host-events', 'host-storage', 'Pinned SDK replay/disposal fixtures only; native host builds and browser DOM/visibility still need separate qualification.'],
    ['storage', 'host-storage', 'Synthetic storage, quota, migration and unknown-format cases do not prove native backup/restore or every mixed-version installation.'],
    ['packaged-artifact', 'package', 'In-memory source/bundle comparison, reproducible ZIP checks and an extracted synthetic service smoke; no native extension installation.'],
    ['privacy', 'privacy', 'Committed-source scan plus package leak checks; this does not certify arbitrary external inputs.'],
  ]) features[id] = { result: resultFor(checks, [check, ...id === 'packaged-artifact' ? ['build-consistency'] : [], 'source-consistency']), nativeRuntime: 'not-run', limitation };
  return { schemaVersion: 2, at, mode: 'synthetic', result: passed ? 'synthetic-pass' : 'synthetic-fail',
    candidate: { runtime: 'OpenCode', version: candidateVersion, profile: profile?.id ?? null, support: profile ? 'qualified' : 'unqualified' },
    fixtureProfile: profileFor(fixtureVersion).id, fixtureRuntime: fixtureVersion,
    host: { sdk: identity.hostSdk, apiVersion: identity.hostApi, nativeBuild: 'not-observed' }, companionVersion: identity.companionVersion,
    runtimeExecuted: false, supportChanged: false, hashes, inputFingerprint: inputs,
    evidenceKey: digest(JSON.stringify({ ...identity, inputs })), artifact: context.artifact ?? null, checks, features,
    additionalGates: { browser: 'not-run', resources: 'not-run', nativeProtocols: 'not-run' },
    invalidation: 'A changed candidate, SDK/API, companion, adapter/profile, contract, fixture, dependency or packaged asset requires a new receipt; support changes require a reviewed registry edit.',
    limits: ['No native OpenCode or OpenChamber process was launched or stopped; no inference, model download or installation.',
      'Candidate selection labels policy status only. The bundled reference fixtures run unchanged and cannot qualify an unknown candidate.',
      'This report does not prove native transport behavior, application hot reload, browser geometry, performance, or live prompt percentage.',
      'Native protocol harnesses, browser and resource gates are separate, explicitly invoked operations and were not run.'] };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args), hashes = await collectInputs(root), checks = [];
  for (const suite of CHECK_SUITES) {
    const result = spawnSync(suite.executable === 'node' ? process.execPath : suite.executable, suite.args,
      { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 ** 2 });
    checks.push({ ...suite, result: !result.error && result.status === 0 ? 'pass' : 'fail', exitCode: result.status });
    if (result.error || result.status !== 0) process.stderr.write(`${suite.id} checks failed. Run the listed suite for diagnostics.\n`);
  }
  let unchanged = false;
  try { unchanged = sameInputs(hashes, await collectInputs(root)); } catch { /* Missing/changed inputs fail the receipt. */ }
  checks.push({ id: 'source-consistency', result: unchanged ? 'pass' : 'fail', exitCode: null });
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const companion = JSON.parse(await readFile(join(root, 'bridge/opencode/package.json'), 'utf8'));
  let artifact = null;
  if (/^[a-z0-9][a-z0-9-]*$/.test(pkg.name) && versionOK(pkg.version) && checks.find(check => check.id === 'package').result === 'pass') {
    const path = `dist/${pkg.name}-${pkg.version}.zip`, bytes = await readFile(join(root, path));
    artifact = { path, sha256: digest(bytes), bytes: bytes.length };
  }
  const report = qualificationReport(checks, hashes, new Date().toISOString(), { ...options, artifact,
    hostSdk: pkg.dependencies?.['@openchamber/sdk'], hostApi: pkg.openchamber?.apiVersion, companionVersion: companion.version });
  const text = JSON.stringify(report, null, 2) + '\n';
  if (options.output) await writeFile(resolve(options.output), text, { flag: 'wx', mode: 0o600 });
  process.stdout.write(text);
  if (report.result !== 'synthetic-pass') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { process.stderr.write(`${error.message === usage ? usage : 'Qualification could not complete; check inputs and output permissions. No support was changed.'}\n`); process.exitCode = 1; });

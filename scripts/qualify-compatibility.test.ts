import { expect, test } from 'bun:test';
// Importing the CLI never starts a process; these tests exercise reporting and input policy only.
// @ts-expect-error The standalone Node CLI has no emitted declarations.
import { CHECK_SUITES, REQUIRED_CHECKS, inputFingerprint, packageEntries, parseOptions, qualificationReport, sameInputs } from './qualify-compatibility.mjs';

const checks = () => REQUIRED_CHECKS.map((id: string) => ({ id, result: 'pass' }));
const hashes = { sources: { 'panel/main.ts': 'source' }, fixtures: { 'panel/host/openchamber.test.ts': 'fixture' },
  profiles: { 'bridge/opencode/compatibility.js': 'profile' }, assets: { 'panel/main.js': 'artifact' }, dependencies: { 'bun.lock': 'lock' } };
const context = { hostSdk: '2.0.4', hostApi: 1, companionVersion: '3.2.0' };

test('synthetic success identifies the reference profile without claiming native qualification', () => {
  const result = qualificationReport(checks(), hashes, 'fixture-time', context);
  expect(result.result).toBe('synthetic-pass');
  expect(result.runtimeExecuted).toBe(false); expect(result.supportChanged).toBe(false);
  expect(result.candidate).toEqual({ runtime: 'OpenCode', version: '2.0.25', profile: 'opencode-2.0.25-v1', support: 'qualified' });
  expect(result.fixtureRuntime).toBe('2.0.25'); expect(result.host.nativeBuild).toBe('not-observed');
  for (const feature of Object.values(result.features) as Array<{ nativeRuntime: string }>) expect(feature.nativeRuntime).toBe('not-run');
  expect(result.features['websocket-delivery'].limitation).toContain('cancellation remains unqualified');
  expect(result.features['managed-reload'].limitation).toContain('do not prove');
  expect(result.features.storage.result).toBe('passed');
  expect(result.additionalGates).toEqual({ browser: 'not-run', resources: 'not-run', nativeProtocols: 'not-run' });
});

for (const [candidate, support] of [['2.0.33', 'self-checked'], ['3.0.0', 'unsupported']] as const) test(`an unqualified ${support} candidate gains no qualification even when every reference fixture passes`, () => {
  const result = qualificationReport(checks(), hashes, '', { ...context, candidate });
  expect(result.result).toBe('synthetic-pass');
  expect(result.candidate).toEqual({ runtime: 'OpenCode', version: candidate, profile: null, support });
  for (const id of ['http-delivery', 'websocket-delivery', 'prompt-progress', 'managed-reload']) {
    expect(result.features[id].result).toBe(support); expect(result.features[id].support).toBe(support);
  }
  expect(result.features['host-events'].result).toBe('passed'); expect(result.supportChanged).toBe(false);
  expect(result.evidenceKey).not.toBe(qualificationReport(checks(), hashes, '', context).evidenceKey);
});

for (const version of ['2.0.27', '2.0.28', '2.0.29', '2.0.32']) test(`the native-tested ${version} profile keeps fixture and native results distinct`, () => {
  const result = qualificationReport(checks(), hashes, '', { ...context, candidate: version });
  expect(result.candidate).toEqual({ runtime: 'OpenCode', version, profile: `opencode-${version}-v1`, support: 'qualified' });
  expect(result.fixtureRuntime).toBe('2.0.25');
  expect(result.features['websocket-delivery'].nativeRuntime).toBe('not-run');
  expect(result.features['websocket-delivery'].limitation).toContain('separate version-specific receipt');
});

test('every required suite, hash inventory and source-consistency check must pass', () => {
  for (const id of REQUIRED_CHECKS) {
    const omitted = checks().filter((check: { id: string }) => check.id !== id);
    expect(qualificationReport(omitted, hashes, '').result).toBe('synthetic-fail');
    expect(qualificationReport([...omitted, { id, result: 'fail' }], hashes, '').result).toBe('synthetic-fail');
    expect(qualificationReport([...omitted, { id, result: 'skipped' }], hashes, '').result).toBe('synthetic-fail');
  }
  expect(qualificationReport(checks(), {}, '').result).toBe('synthetic-fail');
  expect(qualificationReport([{ id: 'bridge', result: 'pass' }], hashes, '').features.storage.result).toBe('skipped');
  const failed = checks().map((check: { id: string }) => ({ ...check, result: check.id === 'host-storage' ? 'fail' : 'pass' }));
  expect(qualificationReport(failed, hashes, '').features.storage.result).toBe('failed');
  expect(qualificationReport(failed, hashes, '').features['http-delivery'].result).toBe('passed');
});

test('artifact, profile, source, fixture and dependency changes each invalidate the input fingerprint', () => {
  const original = inputFingerprint(hashes);
  expect(inputFingerprint(Object.fromEntries(Object.entries(hashes).reverse()))).toBe(original);
  for (const group of Object.keys(hashes) as Array<keyof typeof hashes>) {
    const changed = structuredClone(hashes); Object.assign(changed[group], { 'new-input': 'changed' });
    expect(sameInputs(hashes, changed)).toBe(false); expect(inputFingerprint(changed)).not.toBe(original);
  }
  expect(sameInputs(hashes, structuredClone(hashes))).toBe(true);
  expect(qualificationReport(checks(), hashes, '', { ...context, hostSdk: '2.0.5' }).evidenceKey)
    .not.toBe(qualificationReport(checks(), hashes, '', context).evidenceKey);
});

test('candidate arguments are bounded labels and never become child-process commands', () => {
  expect(parseOptions([])).toEqual({ candidate: '2.0.25' });
  expect(parseOptions(['--output', 'receipt.json', '--candidate', '2.0.26-rc.1'])).toEqual({ output: 'receipt.json', candidate: '2.0.26-rc.1' });
  for (const args of [['--candidate'], ['--candidate', 'anything'], ['--candidate', '2.0.26', '--candidate', '2.0.25'],
    ['--candidate', '2.0.26\nsecret'], ['--install', '2.0.26'], ['--candidate', '2'.repeat(70) + '.0.0']]) expect(() => parseOptions(args)).toThrow('Usage:');
  expect(CHECK_SUITES.map((suite: { id: string }) => suite.id)).toEqual(['bridge', 'service', 'host-storage', 'privacy', 'build-consistency', 'package']);
  expect(JSON.stringify(CHECK_SUITES)).not.toMatch(/protocol-(?:smoke|ws|hot)|--candidate|opencode serve|build:|test:browser/);
  expect(CHECK_SUITES.find((suite: { id: string }) => suite.id === 'package').args).toEqual(['scripts/verify-package.ts']);
});

test('package hashing accepts only the explicit relative-file allowlist', () => {
  expect(packageEntries({ files: ['panel/main.js', 'package.json'] })).toEqual(['package.json', 'panel/main.js']);
  for (const files of [null, ['../secret'], ['/private/secret'], ['panel/../secret'], ['panel\\main.js'], ['panel/main.js', 'panel/main.js'], [123]])
    expect(() => packageEntries({ files })).toThrow('safe, explicit');
});

import { expect, test } from 'bun:test';
import { parseTelemetrySnapshot, unavailableTelemetry, type TelemetrySnapshot } from '../telemetry.ts';
import { __test__, hostFromV1, toSnapshotV2, type V1Snapshot } from './convert-v1.ts';
import { bodyChars, classAKeys, MAX_BODY_CHARS } from './guards.ts';
import { honestyViolations, parseSnapshotV2 } from './snapshot.ts';
import { EPOCH, hostStates, type V1State } from './testing/v1-states.ts';
import { unitViolations } from './units.ts';

const EXTRAS = { service: { version: '2.0.0', instance: '5c1e0a7b' } };
const NOW = EPOCH + 60_000;
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const states: V1State[] = hostStates();

test('the fixture sweep covers every state the 1.6 panel can show', () => {
  const seen = (predicate: (body: TelemetrySnapshot) => boolean) => states.some(state => predicate(parseTelemetrySnapshot(wire(state.body))));
  expect(states.length).toBeGreaterThan(250);
  for (const runtime of ['omlx', 'lmstudio', 'splash', 'vllm-mlx', 'mlx-lm'] as const) expect(seen(body => body.available && body.runtime === runtime), runtime).toBe(true);
  for (const phase of ['notLoaded', 'idle', 'queued', 'prefill', 'decode', 'processing', 'unknown'] as const) expect(seen(body => body.available && body.phase === phase), phase).toBe(true);
  for (const reason of ['runtime_unreachable', 'authentication_failed', 'unparseable_snapshot'] as const) expect(seen(body => body.reason === reason), reason).toBe(true);
  for (const coverage of ['requests', 'inventory', 'server'] as const) expect(seen(body => body.connection?.coverage === coverage), coverage).toBe(true);
  expect(seen(body => body.lastRequest !== null && body.lastRequest !== undefined)).toBe(true);
  expect(seen(body => body.serverStats?.ready === false)).toBe(true);
  expect(seen(body => body.prefillProgressStale)).toBe(true);
  expect(seen(body => (body.residentModelCount ?? 0) > 1)).toBe(true);
  expect(seen(body => body.system?.macOS !== null && body.system?.cpuPercent !== null)).toBe(true);
  expect(seen(body => body.system !== null && body.system?.platform !== 'macOS')).toBe(true);
  expect(seen(body => body.system === null)).toBe(true);
});

test('converted bodies are canonical, honest, unit-clean, free of class A keys and inside the route limit', () => {
  for (const state of states) {
    const v2 = toSnapshotV2(state.body, EXTRAS);
    expect(parseSnapshotV2(wire(v2)), state.name).toEqual(v2);
    expect(honestyViolations(v2), state.name).toEqual([]);
    expect(unitViolations(v2), state.name).toEqual([]);
    expect(classAKeys(v2), state.name).toEqual([]);
    expect(bodyChars(v2)).toBeLessThan(MAX_BODY_CHARS);
    // Real service readings never need a capability the adapter table does not declare.
    if (state.service) expect(__test__.draft(state.body, EXTRAS).uncovered, state.name).toEqual([]);
  }
});

const find = (prefix: string) => states.find(state => state.name.startsWith(prefix))!.body;

test('decimal GB becomes the integer bytes the runtime reported, and seconds become milliseconds', () => {
  const decode = toSnapshotV2(find('host omlx-decode #0'), EXTRAS);
  expect(decode.host).toMatchObject({ memTotalBytes: 48 * 1024 ** 3, memUsedBytes: Math.round(36.1 * 1024 ** 3), mac: { swapUsedBytes: Math.round(1.1 * 1024 ** 3) } });
  expect(decode.runtime.request).toMatchObject({ model: 'Qwen3.8-27B-4bit', promptTokens: 52_100, cachedTokens: 43_000, elapsedMs: 260_500,
    contextWindowTokens: 131_072, contextUsedTokens: 52_100 + 6_494 });
  expect(decode.runtime.server.averages).toMatchObject({ cacheEfficiencyFraction: 0.823, uptimeMs: 51_420_000 });
  expect(decode.runtime.residency[0]).toMatchObject({ model: 'Qwen3.8-27B-4bit', phase: 'decode', bytes: 17_100_000_000, decodeTps: 24.6 });
});

test('1.6 status and connection semantics map onto v2 codes', () => {
  expect(toSnapshotV2(find('host omlx-auth #0'), EXTRAS).status).toMatchObject({ state: 'failing', reason: 'authentication_failed' });
  expect(toSnapshotV2(find('host omlx-offline #0'), EXTRAS).status).toMatchObject({ state: 'failing', reason: 'runtime_unreachable' });
  const missing = toSnapshotV2({ ...unavailableTelemetry('runtime_unreachable', null, EPOCH), connection: { selected: null, label: null, runtime: null,
    generation: null, choices: [], diagnostic: 'missing', coverage: null } }, EXTRAS);
  expect(missing.status).toEqual({ state: 'unconfigured', reason: 'configuration_missing', params: {} });
  expect(missing.connection).toMatchObject({ id: 'auto', label: 'Automatic', runtime: null, generation: 0 });
  // A frame-side 1.x reason has no v2 code: the status stays failing without one.
  const parsed = toSnapshotV2(parseTelemetrySnapshot(wire(find('host setup-missing'))), EXTRAS);
  expect(parsed.status).toEqual({ state: 'failing', reason: null, params: {} });
  const bionic = toSnapshotV2(find('host bionic-decode #0'), EXTRAS);
  expect(bionic.connection).toMatchObject({ runtime: 'lmstudio', engine: 'splash', host: 'bionic' });
});

test('an unavailable 1.x body keeps only what the 1.6 panel kept', () => {
  const offline = toSnapshotV2(find('host omlx-offline #0'), EXTRAS);
  expect(offline.runtime).toMatchObject({ phase: 'unknown', request: null, server: { active: null, queued: null }, memory: {}, residency: [] });
  expect(Object.keys(offline.capabilities).sort()).toEqual(['host.cpu', 'host.memory', 'host.swap']);
});

test('1.6 connection ids cross unchanged (owner decision: ≤ 120 characters, no control characters)', () => {
  const v1: V1Snapshot = { ...unavailableTelemetry('runtime_unreachable', null, EPOCH), connection: { selected: 'My Provider', label: 'My Provider',
    runtime: 'lmstudio', generation: null, choices: [{ id: 'My Provider', label: 'My Provider', runtime: 'lmstudio' }, { id: 'omlx', label: 'oMLX', runtime: 'omlx' }],
    diagnostic: 'offline', coverage: null } };
  const v2 = toSnapshotV2(v1, EXTRAS);
  expect(v2.connection).toMatchObject({ id: 'My Provider', label: 'My Provider', choices: [{ id: 'My Provider', label: 'My Provider', runtime: 'lmstudio' },
    { id: 'omlx', label: 'oMLX', runtime: 'omlx' }] });
});

test('extras carry the service identity and scheduling; bad identity is a programming error', () => {
  const v2 = toSnapshotV2(find('host omlx-idle'), { ...EXTRAS, serverNow: NOW, generation: 7, nextPollMs: 3_000, marksHead: 4,
    detection: { basis: 'explicit', confidence: 'high' }, runtimeVersion: '0.7.0rc1' });
  expect(v2).toMatchObject({ serverNow: NOW, nextPollMs: 3_000, marksHead: 4, connection: { generation: 7, version: '0.7.0rc1', detection: { basis: 'explicit' } } });
  expect(toSnapshotV2(find('host omlx-decode'), EXTRAS).nextPollMs).toBe(500);
  expect(toSnapshotV2(find('host omlx-idle'), EXTRAS).nextPollMs).toBe(2_000);
  expect(() => toSnapshotV2(find('host omlx-idle'), { service: { version: '2.0.0', instance: 'not-hex' } })).toThrow(TypeError);
});

test('the 1.x host sampler reading as HostV2 until svc-host replaces it', () => {
  const host = hostFromV1(find('host omlx-idle').system);
  expect(host).toMatchObject({ platform: 'macOS', memTotalBytes: expect.any(Number), mac: { swapUsedBytes: expect.any(Number) } });
  expect([hostFromV1(null), hostFromV1(undefined), hostFromV1({ ...find('host omlx-idle').system!, sampledAt: -1 })]).toEqual([null, null, null]);
});

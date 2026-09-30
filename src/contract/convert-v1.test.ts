import { expect, test } from 'bun:test';
import { parseTelemetrySnapshot, unavailableTelemetry, type TelemetrySnapshot } from '../telemetry.ts';
import { __test__, hostFromV1, toSnapshotV2, v1Parts, type V1Snapshot } from './convert-v1.ts';
import { bodyChars, classAKeys, MAX_BODY_CHARS } from './guards.ts';
import { honestyViolations, parseSnapshotV2 } from './snapshot.ts';
import { rendered, toV1 } from './testing/v1-inverse.ts';
import { EPOCH, hostStates, serviceStates, type V1State } from './testing/v1-states.ts';
import { unitViolations } from './units.ts';

const EXTRAS = { service: { version: '2.0.0', instance: '5c1e0a7b' } };
const NOW = EPOCH + 60_000;
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const states: V1State[] = [...hostStates(), ...await serviceStates()];

test('the fixture sweep covers every state the 1.6 panel can show', () => {
  const seen = (predicate: (body: TelemetrySnapshot) => boolean) => states.some(state => predicate(parseTelemetrySnapshot(wire(state.body))));
  expect(states.length).toBeGreaterThan(300);
  for (const runtime of ['omlx', 'lmstudio', 'splash', 'vllm-mlx', 'mlx-lm'] as const) expect(seen(body => body.available && body.runtime === runtime), runtime).toBe(true);
  for (const phase of ['notLoaded', 'idle', 'queued', 'prefill', 'decode', 'processing', 'unknown'] as const) expect(seen(body => body.available && body.phase === phase), phase).toBe(true);
  for (const reason of ['runtime_unreachable', 'authentication_failed', 'unsupported_contract', 'unparseable_snapshot'] as const) expect(seen(body => body.reason === reason), reason).toBe(true);
  for (const coverage of ['requests', 'inventory', 'server'] as const) expect(seen(body => body.connection?.coverage === coverage), coverage).toBe(true);
  expect(seen(body => body.lastRequest !== null && body.lastRequest !== undefined)).toBe(true);
  expect(seen(body => body.serverStats?.ready === false)).toBe(true);
  expect(seen(body => body.prefillProgressStale)).toBe(true);
  expect(seen(body => (body.residentModelCount ?? 0) > 1)).toBe(true);
  expect(seen(body => body.system?.macOS !== null && body.system?.cpuPercent !== null)).toBe(true);
  expect(seen(body => body.system !== null && body.system?.platform !== 'macOS')).toBe(true);
  expect(seen(body => body.system === null)).toBe(true);
});

test('v1 → v2 → v1 preserves every value the 1.6 panel renders, at its precision', () => {
  for (const state of states) {
    const original = parseTelemetrySnapshot(wire(state.body));
    for (const [input, route] of [[state.body, 'service body'], [original, 'panel-parsed body']] as const) {
      const v2 = toSnapshotV2(input as V1Snapshot, EXTRAS);
      const back = parseTelemetrySnapshot(wire(toV1(parseSnapshotV2(wire(v2))!)));
      expect(rendered(back, NOW), `${state.name} (${route})`).toEqual(rendered(original, NOW));
    }
  }
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
  const splash = toSnapshotV2(find('service splash idle'), EXTRAS);
  expect(splash.runtime.memory).toEqual({ metalBytes: 12_500_000_000, metalPeakBytes: 13_000_000_000 });
  expect(splash.runtime.server.averages).toEqual({ decodeTps: 47.2, requestsTotal: 17, failedTotal: 0 });
  expect(splash.capabilities['server.requests']).toEqual({ scope: 'server', basis: 'derived' });
  expect(splash.runtime.catalog).toEqual([{ name: 'example/Example-27B-Splash', format: 'splash', loaded: true, contextWindowTokens: 262_144 }]);
  const decode = toSnapshotV2(find('host omlx-decode #0'), EXTRAS);
  expect(decode.host).toMatchObject({ memTotalBytes: 48 * 1024 ** 3, memUsedBytes: Math.round(36.1 * 1024 ** 3), mac: { swapUsedBytes: Math.round(1.1 * 1024 ** 3) } });
  expect(decode.runtime.request).toMatchObject({ model: 'Qwen3.8-27B-4bit', promptTokens: 52_100, cachedTokens: 43_000, elapsedMs: 260_500,
    contextWindowTokens: 131_072, contextUsedTokens: 52_100 + 6_494 });
  expect(decode.runtime.server.averages).toMatchObject({ cacheEfficiencyFraction: 0.823, uptimeMs: 51_420_000 });
  expect(decode.runtime.residency[0]).toMatchObject({ model: 'Qwen3.8-27B-4bit', phase: 'decode', bytes: 17_100_000_000, decodeTps: 24.6 });
});

test('1.6 status and connection semantics map onto v2 codes', () => {
  expect(toSnapshotV2(find('service splash loading'), EXTRAS).status).toEqual({ state: 'degraded', reason: 'loading', params: {} });
  expect(toSnapshotV2(find('service omlx auth'), EXTRAS).status).toEqual({ state: 'failing', reason: 'authentication_failed', params: {} });
  expect(toSnapshotV2(find('service omlx unreachable'), EXTRAS).status).toEqual({ state: 'failing', reason: 'runtime_unreachable', params: {} });
  expect(toSnapshotV2(find('service splash unsupported'), EXTRAS).status).toEqual({ state: 'failing', reason: 'unsupported_contract', params: {} });
  const missing = toSnapshotV2({ ...unavailableTelemetry('runtime_unreachable', null, EPOCH), connection: { selected: null, label: null, runtime: null,
    generation: null, choices: [], diagnostic: 'missing', coverage: null } }, EXTRAS);
  expect(missing.status).toEqual({ state: 'unconfigured', reason: 'configuration_missing', params: {} });
  expect(missing.connection).toMatchObject({ id: 'auto', label: 'Automatic', runtime: null, generation: 0 });
  // A frame-side reason the service never sends survives only in the bridge.
  const parsed = toSnapshotV2(parseTelemetrySnapshot(wire(find('host setup-missing'))), EXTRAS);
  expect([parsed.status, parsed.compat?.reason]).toEqual([{ state: 'failing', reason: null, params: {} }, 'unparseable_snapshot']);
  const bionic = toSnapshotV2(find('service lmstudio activity decode'), EXTRAS);
  expect(bionic.connection).toMatchObject({ id: 'bionic', runtime: 'lmstudio', engine: 'splash', host: 'bionic', generation: 1 });
  expect(bionic.completions.items).toEqual([{ seq: 1, finishedAt: EPOCH - 42_000, startedAt: null, model: 'fixture-splash', basis: 'reported',
    promptTokens: 18_400, cachedTokens: 11_260, outputTokens: 1092, ttftMs: 470, decodeTps: 38.6, overlapped: true, host: {} }]);
  expect(bionic.capabilities['request.elapsed']?.basis).toBe('observed');
  expect(bionic.capabilities['server.averages']?.basis).toBe('derived');
});

test('an unavailable 1.x body keeps only what the 1.6 panel kept', () => {
  const offline = toSnapshotV2(find('host omlx-offline #0'), EXTRAS);
  expect(offline.runtime).toMatchObject({ phase: 'unknown', request: null, server: { active: null, queued: null }, memory: {}, residency: [] });
  expect(offline.compat).toMatchObject({ message: 'oMLX is not responding. Start the server, then refresh.', modelID: null, statsState: 'unavailable' });
  expect(Object.keys(offline.capabilities).sort()).toEqual(['host.cpu', 'host.memory', 'host.swap']);
});

test('1.6 connection ids cross unchanged (owner decision: ≤ 120 characters, no control characters)', () => {
  const v1: V1Snapshot = { ...unavailableTelemetry('runtime_unreachable', null, EPOCH), connection: { selected: 'My Provider', label: 'My Provider',
    runtime: 'lmstudio', generation: null, choices: [{ id: 'My Provider', label: 'My Provider', runtime: 'lmstudio' }, { id: 'omlx', label: 'oMLX', runtime: 'omlx' }],
    diagnostic: 'offline', coverage: null } };
  const v2 = toSnapshotV2(v1, EXTRAS);
  expect(v2.connection).toMatchObject({ id: 'My Provider', label: 'My Provider', choices: [{ id: 'My Provider', label: 'My Provider', runtime: 'lmstudio' },
    { id: 'omlx', label: 'oMLX', runtime: 'omlx' }] });
  expect(v2.compat?.connection?.selected).toBe('My Provider');
});

test('extras carry the service identity and scheduling; bad identity is a programming error', () => {
  const v2 = toSnapshotV2(find('host omlx-idle'), { ...EXTRAS, serverNow: NOW, generation: 7, nextPollMs: 3_000, marksHead: 4,
    detection: { basis: 'explicit', confidence: 'high' }, runtimeVersion: '0.7.0rc1' });
  expect(v2).toMatchObject({ serverNow: NOW, nextPollMs: 3_000, marksHead: 4, connection: { generation: 7, version: '0.7.0rc1', detection: { basis: 'explicit' } } });
  expect(toSnapshotV2(find('host omlx-decode'), EXTRAS).nextPollMs).toBe(500);
  expect(toSnapshotV2(find('host omlx-idle'), EXTRAS).nextPollMs).toBe(2_000);
  expect(() => toSnapshotV2(find('host omlx-idle'), { service: { version: '2.0.0', instance: 'not-hex' } })).toThrow(TypeError);
});

test('the 2b bridge: a 1.x adapter reading becomes adapter-reading parts, with the same withholding and no English', () => {
  const service = states.filter(state => state.service);
  expect(service.length).toBeGreaterThan(40);
  for (const { name, body } of service) {
    const parts = v1Parts(body), whole = toSnapshotV2({ ...body, system: null }, EXTRAS);
    expect([parts.status, parts.runtime], name).toEqual([{ state: whole.status.state, reason: whole.status.reason }, whole.runtime]);
    // The bridge derives 1.6's coverage tier itself, so it declares what runtime-client's reading declared.
    if (body.connection?.coverage) expect(parts.capabilities, name).toEqual(whole.capabilities);
    if (body.message) expect(JSON.stringify(parts), name).not.toContain(body.message);
    expect(Object.keys(parts.compat).sort(), name).not.toContain('message');
  }
  const bionic = v1Parts(find('service lmstudio activity decode'));
  expect(bionic.last).toEqual({ finishedAt: EPOCH - 42_000, startedAt: null, model: 'fixture-splash', basis: 'reported', promptTokens: 18_400,
    cachedTokens: 11_260, outputTokens: 1092, ttftMs: 470, decodeTps: 38.6, overlapped: true });
  expect(v1Parts(find('service omlx decode')).compat).toMatchObject({ statsState: expect.any(String), traceEpoch: expect.any(Number) });
});

test('the 1.x host sampler reading as HostV2 until svc-host replaces it', () => {
  const host = hostFromV1(find('host omlx-idle').system);
  expect(host).toMatchObject({ platform: 'macOS', memTotalBytes: expect.any(Number), mac: { swapUsedBytes: expect.any(Number) } });
  expect([hostFromV1(null), hostFromV1(undefined), hostFromV1({ ...find('host omlx-idle').system!, sampledAt: -1 })]).toEqual([null, null, null]);
});

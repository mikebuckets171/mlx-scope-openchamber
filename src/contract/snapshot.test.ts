import { expect, test } from 'bun:test';
import fixtures from '../../docs/design/2.0-mock-fixtures.json';
import { CAPABILITY_KEYS } from './capabilities.ts';
import { classAKeys } from './guards.ts';
import { HONESTY, honestyViolations, parseSnapshotV2, requiredCapabilities, type SnapshotV2 } from './snapshot.ts';
import { fullSnapshot } from './testing/full.ts';
import { unitViolations } from './units.ts';

type Body = Record<string, any>;
const clone = <T>(value: T): T => structuredClone(value);
const base = (): Body => clone(fixtures.snapshots['omlx-decode']) as Body;
const edit = (change: (body: Body) => void, from: () => Body = base): Body => { const body = from(); change(body); return body; };
// The G2 mock's own merge: a patch replaces leaves; null in a patch means "absent".
const merge = (a: unknown, b: unknown): unknown => b === undefined ? a : b === null || typeof b !== 'object' || Array.isArray(b) ? b
  : Object.fromEntries([...new Set([...Object.keys(a ?? {}), ...Object.keys(b)])].map(key => [key, merge((a as Body)?.[key], (b as Body)[key])]));
const mockStates = Object.entries(fixtures.states as Record<string, { snapshot: keyof typeof fixtures.snapshots; patch?: unknown }>)
  .map(([name, state]) => [name, merge(fixtures.snapshots[state.snapshot], state.patch)] as const);

test('every G2 mock snapshot and state parses, and parsing is idempotent', () => {
  expect(mockStates.length).toBeGreaterThan(30);
  for (const [name, body] of [...Object.entries(fixtures.snapshots), ...mockStates]) {
    const parsed = parseSnapshotV2(body);
    expect(parsed, name).not.toBeNull();
    expect(parseSnapshotV2(JSON.parse(JSON.stringify(parsed))), name).toEqual(parsed);
    expect(honestyViolations(parsed!), name).toEqual([]);
    expect(unitViolations(parsed!), name).toEqual([]);
  }
  const decode = parseSnapshotV2(base())!;
  expect(decode.runtime.request).toMatchObject({ model: 'Example-27B-4bit', decodeTps: 26.4, contextUsedTokens: 52_712 });
  expect(decode.host?.power).toMatchObject({ chipW: 38.4, coverageFraction: 0.97 });
  expect(decode.completions.items[0]?.verdict).toEqual({ attr: 'inferred', at: 1_790_690_640_000 });
});

const REJECT: Array<[string, unknown]> = [
  ['null', null], ['array', [base()]], ['string', JSON.stringify(base())],
  ['contract v1', edit(body => { body.contractVersion = 1; })], ['contract "2"', edit(body => { body.contractVersion = '2'; })],
  ['no contractVersion', edit(body => { delete body.contractVersion; })], ['negative serverNow', edit(body => { body.serverNow = -1; })],
  ['serverNow as text', edit(body => { body.serverNow = '1790690700000'; })], ['instance not hex', edit(body => { body.service.instance = 'zzzzzzzz'; })],
  ['instance upper case', edit(body => { body.service.instance = '5C1E0A7B'; })], ['no service version', edit(body => { delete body.service.version; })],
  ['no connection', edit(body => { delete body.connection; })], ['connection id with a newline', edit(body => { body.connection.id = 'my\nomlx'; })],
  ['connection id of 121', edit(body => { body.connection.id = 'x'.repeat(121); })], ['empty connection id', edit(body => { body.connection.id = ''; })], ['fractional generation', edit(body => { body.connection.generation = 1.5; })],
  ['no detection', edit(body => { delete body.connection.detection; })], ['unknown detection basis', edit(body => { body.connection.detection.basis = 'guess'; })],
  ['no status', edit(body => { delete body.status; })], ['unknown state', edit(body => { body.status.state = 'offline'; })],
  ['unknown reason', edit(body => { body.status.reason = 'feature_disabled'; })], ['no runtime', edit(body => { delete body.runtime; })],
  ['no capabilities', edit(body => { delete body.capabilities; })], ['host missing', edit(body => { delete body.host; })],
  ['host without sampledAt', edit(body => { delete body.host.sampledAt; })], ['no completions', edit(body => { delete body.completions; })],
  ['completions from another instance', edit(body => { body.completions.instance = 'ffffffff'; })], ['no marksHead', edit(body => { delete body.marksHead; })],
  ['unknown leader surface', edit(body => { body.lease.leaderSurface = 'background'; })], ['negative nextPollMs', edit(body => { body.nextPollMs = -1; })],
  ['alerts not a list', edit(body => { body.alerts = {}; })], ['no alertLog', edit(body => { delete body.alertLog; })],
];
test.each(REJECT)('rejects %s', (_, body) => { expect(parseSnapshotV2(body)).toBeNull(); });

// Class A (contract §9) anywhere in a body rejects it whole; the frame never renders a leaking body.
const LEAKS: Array<[string, (body: Body) => void]> = [
  ['a PID', body => { body.host.runtimeProcess.pid = 4242; }], ['an api_key', body => { body.runtime.server.api_key = 'fixture'; }],
  ['a cookie', body => { body.connection.cookie = 'fixture'; }], ['prompt text', body => { body.runtime.request.prompt = 'hello'; }],
  ['a model path', body => { body.runtime.residency[0].model_path = '/models/x'; }], ['a session id', body => { body.completions.items[0].sessionId = 'x'; }],
  ['a session title', body => { body.alerts.push({ id: 'thermal', severity: 'info', since: 1, params: { title: 'x' }, badge: false }); }],
  ['a project folder', body => { body.connection.choices[0].directory = '/fixture'; }], ['a request id', body => { body.runtime.request.request_id = 'x'; }],
  ['a Splash crash trace', body => { body.status.params.last_crash_trace = '/tmp/x'; }], ['a generation prompt', body => { body.runtime.slots = [{ generation_prompt: 'x' }]; }],
  ['a username', body => { body.host.user = 'someone'; }], ['a tag', body => { body.completions.items[0].tag8 = 'deadbeef'; }],
];
test.each(LEAKS)('rejects a body carrying %s', (_, leak) => {
  const body = edit(leak);
  expect(classAKeys(body).length).toBe(1);
  expect(parseSnapshotV2(body)).toBeNull();
});

test('values are rebuilt from allowlists: unknown or malformed fields are dropped, lists capped', () => {
  const parsed = parseSnapshotV2(edit(body => {
    body.extra = 'dropped';
    body.capabilities['request.unknown'] = { scope: 'request', basis: 'reported' };
    body.capabilities['host.cpu'] = { scope: 'server', basis: 'reported' };
    body.capabilities['host.memory'] = { scope: 'host', basis: 'guessed' };
    body.runtime.memory.modelBytes = 1.5;
    body.runtime.server.averages.cacheEfficiencyFraction = 82.3;
    body.runtime.residency = Array.from({ length: 15 }, (_, index) => ({ ...body.runtime.residency[0], model: `/models/folder/m${index}` }));
    body.connection.choices = Array.from({ length: 10 }, (_, index) => ({ id: `c${index}`, label: `Choice ${index}\u0000`, runtime: 'nope' }));
    body.status = { state: 'degraded', reason: 'runtime_changed', params: { detected: 'splash', port: 8000, note: 'free text' } };
    body.host.memUsedBytes = body.host.memTotalBytes + 1;
    body.host.power.sysW = 0;
    body.host.thermal.level = 5;
  }))!;
  expect(parsed).not.toHaveProperty('extra');
  expect(Object.keys(parsed.capabilities)).not.toContain('request.unknown');
  expect(parsed.capabilities).not.toHaveProperty('host.cpu');
  expect(parsed.capabilities).not.toHaveProperty('host.memory');
  expect(parsed.runtime.memory).toEqual({ ceilingBytes: 40_802_189_312 });
  expect(parsed.runtime.server.averages).not.toHaveProperty('cacheEfficiencyFraction');
  expect(parsed.runtime.residency.map(item => item.model)).toEqual(Array.from({ length: 12 }, (_, index) => `m${index}`));
  expect(parsed.connection.choices).toHaveLength(8);
  expect(parsed.connection.choices[0]).toEqual({ id: 'c0', label: 'Choice 0', runtime: null });
  expect(parsed.status.params).toEqual({ detected: 'splash', port: 8000 });
  // Host CPU and memory lost their capabilities, so their values are withheld too.
  expect(parsed.host).not.toHaveProperty('cpuFraction');
  expect(parsed.host).not.toHaveProperty('memUsedBytes');
  expect(parsed.host?.power).not.toHaveProperty('sysW');
  expect(parsed.host).not.toHaveProperty('thermal');
});

// Ported from the 1.6 panel parser (src/telemetry.ts parseTelemetrySnapshot) and its resident rules.
const prefill = (request: Body, phase = 'prefill') => parseSnapshotV2(edit(body => {
  body.runtime.phase = phase;
  body.runtime.request = { model: 'm', prefillTps: 184.5, prefillEtaMs: 17_750, ...request };
}))!.runtime.request!;
test('prefill cross-field rules match 1.6', () => {
  expect(prefill({ prefillProcessedTokens: 5824, prefillTotalTokens: 9100, prefillFraction: 0.9 })).toMatchObject({ prefillFraction: 0.64, prefillEtaMs: 17_750 });
  expect(prefill({ prefillProcessedTokens: 5824, prefillTotalTokens: 0, prefillFraction: 0.64 })).not.toHaveProperty('prefillFraction');
  expect(prefill({ prefillProcessedTokens: 9200, prefillTotalTokens: 9100 })).not.toHaveProperty('prefillProcessedTokens');
  expect(prefill({ prefillFraction: 0.64 })).toMatchObject({ prefillFraction: 0.64, prefillEtaMs: 17_750 });
  expect(prefill({ prefillFraction: 0.64 }, 'decode')).not.toHaveProperty('prefillFraction');
  expect(prefill({ prefillFraction: 0.64, prefillStale: true })).toMatchObject({ prefillStale: true });
  expect(prefill({ prefillFraction: 0.64, prefillStale: true })).not.toHaveProperty('prefillEtaMs');
  expect(prefill({ prefillFraction: 1 })).not.toHaveProperty('prefillEtaMs');
  expect(prefill({ prefillFraction: 0.64, prefillTps: 0 })).not.toHaveProperty('prefillEtaMs');
});
test('per-model and per-slot speeds only while a single request makes them honest', () => {
  const runtime = parseSnapshotV2(edit(body => {
    const row = body.runtime.residency[0];
    body.runtime.residency = [{ ...row, active: 2, decodeTps: 26 }, { ...row, phase: 'prefill', active: 1, prefillTps: 280, prefillFraction: 0.2, prefillStale: true },
      { ...row, phase: 'prefill', active: 1, prefillTps: 280, prefillFraction: 0.2 }, { ...row, phase: 'idle', decodeTps: 26 }];
    body.capabilities['server.slots'] = { scope: 'server', basis: 'observed' };
    body.runtime.slots = [{ id: 0, busy: true, contextWindowTokens: 4096, decodeTps: 40 }, { id: 1, busy: true, contextWindowTokens: 4096, decodeTps: 41 }];
    body.runtime.memory = { metalBytes: 10, metalPeakBytes: 9 };
    body.capabilities['server.memory.metal'] = { scope: 'server', basis: 'reported' };
  }))!.runtime;
  expect(runtime.residency.map(row => [row.decodeTps, row.prefillTps, row.prefillFraction])).toEqual([
    [undefined, undefined, undefined], [undefined, undefined, 0.2], [undefined, 280, 0.2], [undefined, undefined, undefined]]);
  expect(runtime.slots.map(slot => slot.decodeTps)).toEqual([undefined, undefined]);
  expect(runtime.memory).toEqual({ metalBytes: 10 });
});

test('completion, alert and lease rules', () => {
  const parsed = parseSnapshotV2(edit(body => {
    const item = body.completions.items[0];
    body.completions.cursor = 60;
    body.completions.items = [{ ...item, seq: 58, verdict: { attr: 'withheld', at: 1 }, aggregateOf: 1, startedAt: item.finishedAt + 1,
      host: { ...item.host, powerCoverage: 0.5 } }, { ...item, seq: 57 }, { ...item, seq: 59, verdict: { attr: 'armed', at: 2 } }, { ...item, seq: 61 }];
    body.alerts = [{ id: 'thermal', severity: 'warning', since: 5, params: { level: 2, extra: 1 }, badge: true },
      { id: 'thermal', severity: 'critical', since: 6, params: { level: 4 }, badge: true }, { id: 'near-gpu-limit', severity: 'warning', since: 5, params: {}, badge: true }];
    body.alertLog = [{ id: 'runtime-lost', severity: 'critical', since: 1, until: 0, params: { runtime: 'omlx' } },
      { id: 'pressure-warning', severity: 'warning', since: 3, until: 4, params: { level: 3 } },
      ...Array.from({ length: 20 }, (_, index) => ({ id: 'thermal', severity: 'info', since: 100 + index, until: null, params: { level: 2 } }))];
  }))!;
  expect(parsed.completions.items.map(item => item.seq)).toEqual([58, 59]);
  const [first, second] = parsed.completions.items;
  expect(first).not.toHaveProperty('verdict');
  expect(first).not.toHaveProperty('aggregateOf');
  expect(first?.startedAt).toBeNull();
  expect(first?.host).not.toHaveProperty('energyJ');
  expect(second?.verdict).toEqual({ attr: 'armed', at: 2 });
  expect(parsed.alerts).toEqual([{ id: 'thermal', severity: 'warning', since: 5, params: { level: 2 }, badge: true }]);
  // Newest first, at most 20: the two oldest entries fall off even though they came first.
  expect(parsed.alertLog.map(entry => entry.since)).toEqual(Array.from({ length: 20 }, (_, index) => 119 - index));
  const log = parseSnapshotV2(edit(body => { body.alertLog = [{ id: 'runtime-lost', severity: 'critical', since: 1, until: 0, params: { runtime: 'omlx' } },
    { id: 'pressure-warning', severity: 'warning', since: 3, until: 4, params: { level: 3 } }]; }))!.alertLog;
  expect(log).toEqual([{ id: 'pressure-warning', severity: 'warning', since: 3, until: 4, params: {} },
    { id: 'runtime-lost', severity: 'critical', since: 1, until: null, params: { runtime: 'omlx' } }]);
});

test('the honesty invariant: every mapped field needs its capability, and parsing withholds it otherwise', () => {
  const full = parseSnapshotV2(fullSnapshot())!;
  expect(full).not.toBeNull();
  expect(new Set(HONESTY.map(([, key]) => key))).toEqual(new Set(CAPABILITY_KEYS.filter(key => key !== 'server.usage')));
  expect(requiredCapabilities(full).sort()).toEqual([...new Set(HONESTY.map(([, key]) => key))].sort());
  for (const key of new Set(HONESTY.map(([, key]) => key))) {
    const body = fullSnapshot() as Body;
    delete body.capabilities[key];
    expect(honestyViolations(body).length, key).toBeGreaterThan(0);
    const parsed = parseSnapshotV2(body)!;
    expect(honestyViolations(parsed), key).toEqual([]);
    for (const [path, needed] of HONESTY) {
      const value = path.split('.').reduce<unknown>((item, part) => (item as Body | undefined)?.[part], parsed);
      if (needed === key) expect(value === undefined || value === null || Array.isArray(value) && value.length === 0, `${path} without ${key}`).toBe(true);
      // A stale prefill withholds its ETA, so the full body carries a live prefill (prefillStale absent).
      else if (path !== 'runtime.request.prefillStale') expect(value, `${path} kept with ${needed}`).not.toBeUndefined();
    }
  }
});

test('a snapshot type is the parser output', () => {
  const parsed: SnapshotV2 | null = parseSnapshotV2(base());
  expect(parsed?.contractVersion).toBe(2);
});

test('engine format (§12.3): a lower-case token is kept; anything else is dropped, the engine kept', () => {
  const body = edit(body => { body.runtime.engines = [
    { name: 'splash', version: '0.0.5', selected: true, format: 'yuzu' }, { name: 'llama.cpp', version: '2.41.0', selected: true, format: 'GGUF' },
    { name: 'mlx-llm', version: '1.9.0', selected: false, format: 'x'.repeat(17) }, { name: 'other', version: '1.0.0', selected: false, format: 'free text' }];
  body.capabilities['server.engines'] = { scope: 'server', basis: 'reported' }; });
  expect(parseSnapshotV2(body)!.runtime.engines).toEqual([{ name: 'splash', version: '0.0.5', selected: true, format: 'yuzu' },
    { name: 'llama.cpp', version: '2.41.0', selected: true }, { name: 'mlx-llm', version: '1.9.0', selected: false }, { name: 'other', version: '1.0.0', selected: false }]);
});

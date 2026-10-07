import { describe, expect, test } from 'bun:test';
import { toSnapshotV2 } from '../../src/contract/convert-v1.ts';
import { parseSnapshotV2 } from '../../src/contract/snapshot.ts';
import { fullSnapshot } from '../../src/contract/testing/full.ts';
import { hostStates } from '../../src/contract/testing/v1-states.ts';
import { MOCK_STATES, mockBody } from '../testing/mock-states.ts';
import { sizeBucket as ledgerBucket } from '../history/ledger-schema.ts';
import * as report from './report.ts';
import { lastReply, SCOPE_HEADER, SCOPE_TEXT_MAX_CHARS, scopeItem, scopeReadme, scopeText, sizeBucket } from './scope.ts';

const AT = 1_790_690_700_000;

test('Splash scope exports separate recent stage intervals and retain only labeled lifetime values while held', () => {
  const snapshot = parseSnapshotV2(mockBody('splash-decode'))!;
  snapshot.runtime.phase = 'processing';
  snapshot.runtime.server.rates = { decodeTps: 43.8, windowMs: 4000, promptTps: 1200, promptWindowMs: 2350 };
  snapshot.runtime.server.averages!.prefillTps = 1500;
  const read = (now = AT) => scopeText({ version: '2.1.5', now, snapshot });
  expect(read()).toContain('recent engine speed over 4 s (output/native decode time) 43.8 tok/s (derived)');
  expect(read()).toContain('recent prefill engine speed over 2.35 s (input/native prefill time) 1200 tok/s (derived)');
  expect(read()).toContain('prefill average since engine start 1500 tok/s (reported)');
  expect(read()).not.toContain('Current request:');
  for (const invalid of [true, '2350', -1, Infinity]) {
    snapshot.runtime.server.rates.promptWindowMs = invalid as number;
    expect(read()).not.toContain('recent prefill engine speed');
    expect(read()).toContain('recent engine speed');
  }
  delete snapshot.runtime.server.rates.promptWindowMs;
  expect(read()).not.toContain('recent prefill engine speed');
  snapshot.runtime.server.rates.promptWindowMs = 2350;
  snapshot.capabilities['server.rates']!.basis = 'reported';
  expect(read()).not.toContain('recent prefill engine speed');
  expect(read()).not.toContain('recent engine speed');
  snapshot.capabilities['server.rates']!.basis = 'derived';
  expect(read(AT + 30_000)).not.toContain('recent prefill engine speed');
  expect(read(AT + 30_000)).not.toContain('recent engine speed');
  snapshot.runtime.phase = 'prefill'; delete snapshot.runtime.server.rates.decodeTps;
  delete snapshot.runtime.server.rates.promptWindowMs;
  expect(read()).toContain('recent prefill engine speed over 4 s');
  expect(read()).not.toContain('recent engine speed');
  snapshot.runtime.server.rates = undefined;
  expect(read()).not.toContain('recent prefill engine speed');
  expect(read()).toContain('prefill average since engine start');
});

test('Splash scope diagnostics separate recent engine speed and lifetime rate, suppressing held recent rates', () => {
  const snapshot = parseSnapshotV2(mockBody('splash-decode'))!;
  const read = () => scopeText({ version: '2.1.4', now: AT, snapshot });
  expect(read()).toContain('average since engine start 47.2 tok/s (reported)');
  expect(read()).toContain('recent engine speed over 4 s (output/native decode time) 43.8 tok/s (derived)');
  snapshot.capabilities['server.rates']!.basis = 'reported';
  expect(read()).not.toContain('recent engine speed');
  snapshot.capabilities['server.rates']!.basis = 'derived';
  snapshot.status.state = 'recovering';
  expect(read()).not.toContain('recent engine speed');
  snapshot.status.state = 'ready'; snapshot.runtime.phase = 'prefill';
  expect(read()).not.toContain('recent engine speed');
  snapshot.runtime.phase = 'decode'; snapshot.runtime.server.rates!.windowMs = 1_000;
  expect(read()).not.toContain('recent engine speed');
});
const cap = (key: string, basis = 'reported') => [key, { scope: key.slice(0, key.indexOf('.')), basis }];
const MODEL = 'CANARY-MODEL-qwen9-1234b';
/** A decoding oMLX-shaped body with every field /scope reads, each behind its capability. */
const body = (patch: (value: Record<string, any>) => void = () => {}) => {
  const value: Record<string, any> = {
    contractVersion: 2, serverNow: AT, service: { version: '2.0.0', instance: '5c1e0a7b' },
    connection: { id: 'omlx', label: `Local ${MODEL}`, runtime: 'omlx', version: '0.7.0rc1', generation: 1,
      detection: { basis: 'probe', confidence: 'high' }, choices: [{ id: 'omlx', label: MODEL, runtime: 'omlx' }] },
    status: { state: 'ready', reason: null, params: {} },
    capabilities: Object.fromEntries([cap('request.decodeRate'), cap('request.prefillRate'), cap('request.prefillProgress'), cap('request.prefillEta', 'estimate'),
      cap('request.tokens'), cap('request.context'), cap('request.ttft'), cap('server.requests'), cap('server.averages'), cap('server.latency'),
      cap('server.rates', 'derived'), cap('server.completions', 'last-observed'), cap('server.residency'), cap('host.pressure'), cap('host.gpuBusy'),
      cap('host.gpuMemory'), cap('host.thermal')]),
    runtime: { sampledAt: AT - 400, phase: 'decode',
      request: { model: MODEL, decodeTps: 24.62, promptTokens: 52_100, cachedTokens: 43_000, contextUsedTokens: 58_582, ttftMs: 812 },
      server: { active: 1, queued: 0, averages: { decodeTps: 23.2, prefillTps: 184.5 },
        histograms: { ttftMs: { p50: 410, p95: 1_210, n: 412, window: 'native-last-4096' } }, rates: { decodeTps: 38.24, windowMs: 30_000 } },
      memory: {}, residency: [{ model: MODEL, phase: 'decode', source: 'runtime' }], slots: [], catalog: [{ name: MODEL, format: 'mlx', loaded: true, contextWindowTokens: 131_072 }], engines: [] },
    host: { sampledAt: AT, platform: 'macOS', mac: { sampledAt: AT, pressureLevel: 2 }, gpu: { sampledAt: AT, busyFraction: 0.62, allocBytes: 30 * 1024 ** 3 },
      thermal: { sampledAt: AT, level: 2 } },
    completions: { instance: '5c1e0a7b', cursor: 7, reset: false, items: [{ seq: 7, finishedAt: AT - 42_000, startedAt: AT - 60_000, model: MODEL,
      basis: 'last-observed', promptTokens: 18_400, cachedTokens: 11_260, outputTokens: 1_092, decodeTps: 38.6, ttftMs: 500, overlapped: false,
      verdict: { attr: 'inferred', at: AT - 41_000 }, host: {} }] },
    marksHead: 0, alerts: [{ id: 'model-unloaded', severity: 'info', since: AT - 1, params: { model: MODEL }, badge: true },
      { id: 'pressure-warning', severity: 'warning', since: AT - 1, params: { level: 2 }, badge: true }],
    alertLog: [{ id: 'model-unloaded', severity: 'info', since: AT - 9, until: AT - 2, params: { model: MODEL } }],
    lease: { leader: false, epoch: 1, ttlMs: 12_000, leaderSurface: null }, nextPollMs: 500,
    compat: { message: `Generating on ${MODEL}`, modelID: MODEL, connection: null, contextWindow: 131_072, statsState: 'fresh', guardLevel: null,
      lastMissReason: null, traceEpoch: null },
  };
  patch(value);
  return value;
};
const text = (value: unknown, vsUsual?: Parameters<typeof scopeText>[0]['vsUsual']) => scopeText({ version: '2.0.0', now: AT, snapshot: value, vsUsual });

describe('/scope text (plan §5.8)', () => {
  test('starts with the cloud-provider header and carries every required part, each rate with its basis', () => {
    const lines = text(body(), [{ metric: 'decodeTps', ratio: 0.8214, n: 34, basis: 'reported' }, { metric: 'ttftMs', ratio: 1.3, n: 12, basis: 'reported' }]).split('\n');
    expect(lines[0]).toBe(`${SCOPE_HEADER}.`);
    expect(lines[0]).toBe("Sent to this chat's model, which may be a cloud provider.");
    expect(lines.slice(1)).toEqual([
      'MLX Scope 2.0.0: local server/Mac; replies labelled separately. No chat content, model names, paths or IDs.',
      '',
      'Runtime: oMLX, version 0.7.0rc1, status ready, phase decode, reading 400 ms old',
      'Current request: decode 24.6 tok/s (reported), first token 812 ms (reported), context 32k–64k tokens',
      'Server, all requests: 1 active, 0 queued (reported), average decode 23.2 tok/s (reported), average prefill 184.5 tok/s (reported), '
        + 'first token p50 410 ms p95 1.21 s over 412 requests (reported), decode over 30 s 38.2 tok/s (derived)',
      'Last finished reply (42 s ago, last-observed): decode 38.6 tok/s, first token 500 ms, context 8k–32k tokens, 61% cached',
      'Label: inferred for Scope’s chat at sampling time',
      'vs usual: decode 0.82× (n=34), first token 1.3× (n=12)',
      'This Mac: memory pressure warning, GPU 62% busy, GPU memory 30 GiB allocated (includes other apps, not model size), GPU values driver-reported, thermal pressure heavy',
      'Alerts: model-unloaded, pressure-warning',
    ]);
  });
  test('prefill: progress from the counts, the stage estimate labelled, nothing held counted as live', () => {
    const prefill = (request: object) => text(body(value => { value.runtime.phase = 'prefill'; value.runtime.request = { model: MODEL, ...request }; }))
      .split('\n').find(line => line.startsWith('Current request'));
    expect(prefill({ prefillTps: 184.5, prefillProcessedTokens: 5_824, prefillTotalTokens: 9_100, prefillFraction: 0.1, prefillEtaMs: 17_750, promptTokens: 9_100 }))
      .toBe('Current request: prefill 184.5 tok/s (reported), prefill 64% of this stage (reported), about 17.75 s left (runtime estimate), context 8k–32k tokens');
    expect(prefill({ prefillTps: 184.5, prefillFraction: 0.64, prefillStale: true, prefillEtaMs: 17_750 }))
      .toBe('Current request: prefill 64% of this stage, held (reported)');
    expect(prefill({ prefillProcessedTokens: 10, prefillTotalTokens: 0, prefillFraction: 0.5 })).toBeUndefined();
  });
  test('a value without its capability is left out, and idle is a gap, never a zero', () => {
    const lines = text(body(value => {
      value.runtime.phase = 'idle'; value.runtime.request = null; value.capabilities = {};
      value.runtime.server = { active: 0, queued: 0, averages: { decodeTps: 23.2 } };
    }));
    expect(lines).toContain('Runtime: oMLX, version 0.7.0rc1, status ready, phase idle');
    for (const absent of ['Current request', 'Server,', 'Last finished', 'This Mac', 'tok/s', ' 0 ', '0%']) expect(lines).not.toContain(absent);
    expect(lines).toContain('Alerts: model-unloaded, pressure-warning');
  });
  test('the label follows the reply verdict, and vs usual says when history is missing or thin', () => {
    const label = (verdict: object | undefined, vsUsual?: null | []) => text(body(value => { value.completions.items[0].verdict = verdict; }), vsUsual)
      .split('\n').filter(line => /^(Label|vs usual)/.test(line));
    expect(label({ attr: 'withheld', reason: 'other-provider', at: AT })).toEqual(['Label: server-wide (other-provider)']);
    expect(label({ attr: 'armed', at: AT }, [])).toEqual(['Label: armed Next reply', 'vs usual: no baseline yet']);
    expect(label(undefined, null)).toEqual(['Label: server-wide (not labelled)', 'vs usual: history unavailable']);
  });
  test('a pressure or thermal level outside the macOS scale is left out, not named', () => {
    const mac = (pressure: number, thermal: number) => text(body(value => { value.host.mac.pressureLevel = pressure; value.host.thermal.level = thermal; }))
      .split('\n').find(line => line.startsWith('This Mac'));
    expect(mac(3, 2.5)).toBe('This Mac: GPU 62% busy, GPU memory 30 GiB allocated (includes other apps, not model size), GPU values driver-reported');
    expect(mac(4, 4)).toContain('memory pressure critical');
    expect(mac(4, 4)).toContain('thermal pressure sleeping');
  });
  test('never says VRAM, and GPU memory is always driver-reported, not model size', () => {
    const value = text(fullSnapshot());
    expect(value).not.toMatch(/vram/i);
    expect(value).toContain('GPU memory 931.3 GiB allocated (includes other apps, not model size), GPU values driver-reported');
  });
  test('stays under the SDK chip limit even for a body filled to its caps', () => {
    expect(text(fullSnapshot()).length).toBeLessThan(SCOPE_TEXT_MAX_CHARS);
    expect(text({ contractVersion: 1 })).toContain('No runtime reading.');
    expect(text(null).split('\n')[0]).toBe(`${SCOPE_HEADER}.`);
  });
});

describe('/scope privacy canaries (plan §8.7)', () => {
  const CLASS_A = ['/Users/fixture/models/secret.gguf', 'sk-CANARY-7f3a-key', 'CANARY-SESSION-9f1c', 'CANARY chat title', 'CANARY project', 'pid 48213'];
  test('class B: a model name in any field a body can carry never reaches the text', () => {
    const value = text(body(), [{ metric: 'decodeTps', ratio: 1.1, n: 9, basis: 'reported' }]);
    expect(value).not.toContain(MODEL);
    expect(value).not.toContain('qwen9');
  });
  test('class A: values in fields /scope never reads, or in unknown keys, never reach the text', () => {
    const value = text(body(value => {
      value.connection.label = CLASS_A.join(' ');
      value.compat.message = CLASS_A.join(' ');
      value.runtime.request.prompt = CLASS_A[0];
      value.session = { id: CLASS_A[2], title: CLASS_A[3] };
      value.status.params = { path: CLASS_A[0], pid: 48_213 };
      value.alerts[1].params = { api_key: CLASS_A[1] };
    }));
    for (const canary of CLASS_A) expect(value).not.toContain(canary);
    expect(value).not.toContain('48213');
  });
  test('only code-shaped enums are copied: a free-text reason or phase is dropped', () => {
    const value = text(body(value => { value.status.reason = `failed at ${CLASS_A[0]}`; value.runtime.phase = 'Generating on CANARY'; }));
    expect(value).toContain('status ready,');
    expect(value).toContain('phase unknown');
    expect(value).not.toContain('CANARY');
  });
  test('every preview and approved-mock state: no model name, and the same text from the raw body as from parseSnapshotV2', async () => {
    const states = hostStates();
    expect(states.length).toBeGreaterThan(100);
    const names = (value: any): string[] => [value.runtime?.request?.model, value.compat?.modelID, ...(value.runtime?.residency ?? []).map((item: any) => item.model),
      ...(value.runtime?.catalog ?? []).map((item: any) => item.name), ...(value.completions?.items ?? []).map((item: any) => item.model)]
      .filter((name: unknown): name is string => typeof name === 'string' && name.length >= 2);
    for (const state of states) {
      const raw = JSON.parse(JSON.stringify(toSnapshotV2(state.body, { service: { version: '2.0.0', instance: '5c1e0a7b' } })));
      const parsed = parseSnapshotV2(raw);
      expect(parsed, state.name).not.toBeNull();
      const output = text(raw);
      expect(text(parsed), state.name).toBe(output);
      for (const name of names(raw)) expect(output, `${state.name}: ${name}`).not.toContain(name);
    }
    // The approved mock's v2 bodies (every runtime, attribution and alert state the 2.0 views render).
    for (const state of MOCK_STATES) {
      const raw = JSON.parse(JSON.stringify(mockBody(state))), parsed = parseSnapshotV2(raw);
      if (!parsed) continue;
      const output = text(raw);
      expect(text(parsed), state).toBe(output);
      for (const name of names(raw)) expect(output, `${state}: ${name}`).not.toContain(name);
    }
    const full = fullSnapshot();
    expect(text(parseSnapshotV2(JSON.parse(JSON.stringify(full))))).toBe(text(full));
  });
});

describe('the chip', () => {
  test('is the MLX Scope diagnostics item, linking the README of this version', () => {
    expect(scopeItem('x'.repeat(20_000), scopeReadme('2.0.0'))).toEqual({ providerId: 'mlx-scope', id: 'mlx-scope-diagnostics',
      title: 'MLX Scope diagnostics', url: 'https://github.com/mikebuckets171/mlx-scope-openchamber/blob/v2.0.0/README.md#scope-diagnostics',
      text: `${'x'.repeat(15_999)}…` });
    expect(scopeReadme('2.0.0-beta.1')).toBe('https://github.com/mikebuckets171/mlx-scope-openchamber/blob/main/README.md#scope-diagnostics');
  });
  test('report.ts stays the one sanitizer entry point for every share path', () => {
    for (const name of ['measurementReport', 'redact', 'clamp', 'toastText', 'scopeText', 'scopeItem', 'scopeReadme', 'SCOPE_HEADER']) expect(report).toHaveProperty(name);
    expect(report.toastText(`${MODEL} was unloaded ${'.'.repeat(600)}`, [MODEL])).toStartWith('a model was unloaded');
    expect(report.toastText('x'.repeat(600), [])).toHaveLength(500);
  });
  test('the last reply needs a seq, a finish time, a basis and the overlap flag; the size buckets are the ledger buckets', () => {
    expect(lastReply(body(value => { value.completions.items.push({ seq: 8, finishedAt: AT, basis: 'guess', overlapped: false }); }))?.seq).toBe(7);
    expect(lastReply(body(), false)).toBeNull();
    for (const tokens of [0, 8_191, 8_192, 32_767, 32_768, 65_535, 65_536, 131_071, 131_072, 1e9]) expect(sizeBucket(tokens)).toBe(ledgerBucket(tokens)!);
    expect(sizeBucket(null)).toBeNull();
  });
});

// Self-checks for the Splash fixture corpora (tests/fixtures/splash/<version>/). They prove that each body parses, carries
// the shapes SPIKES S7 relies on, is the state its name claims, and holds every planted privacy canary exactly where
// SOURCE.md says, so later adapter tests can assert that none of them ever reaches the wire.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type Json = Record<string, unknown>;
type Version = '1.1.0' | '1.0.2';
const VERSIONS: Version[] = ['1.1.0', '1.0.2'];
const ROOT = import.meta.dir;

const CANARY = {
  instanceId: 'CANARY-INSTANCE-7f3a',
  pid: 4242,
  host: '198.51.100.42',
  port: 18742,
  startedAt: 1790636042.4242,
  crashTrace: '/Users/fixture/Library/Logs/splash/CANARY-CRASH-7f3a.trace',
  error: 'CANARY-ERROR-7f3a',
  metal: 'CANARY-METAL-7f3a',
  identity: {
    'cache.loaded_model_layout_sha256': 'CANARY-IDENTITY-LAYOUT-7f3a',
    'cache.runtime_cache_namespace': 'CANARY-IDENTITY-NAMESPACE-7f3a',
    'cache.build_id': 'CANARY-IDENTITY-BUILD-7f3a',
    'q8.target_model_sha256': 'CANARY-IDENTITY-TARGET-7f3a',
  } as Record<string, string>,
};
const MODEL = 'publisher/Example-27B-4bit';
// The only JSON paths allowed to hold a CANARY-* string.
const CANARY_PATHS = new Set(['instance.id', 'transport.last_crash_trace', 'transport.error', 'metal.failure_reason',
  'identity.cache.loaded_model_layout_sha256', 'identity.cache.runtime_cache_namespace', 'identity.cache.build_id',
  'identity.kv.target_model_sha256', 'identity.q8.target_model_sha256']);

const BUCKET_KEYS = ['0.001', '0.005', '0.01', '0.025', '0.05', '0.1', '0.25', '0.5', '1', '2.5', '5', '10', '30', '60',
  '120', '300', '900', '1800', '+Inf'];
const STAGES: Record<Version, string[]> = {
  '1.1.0': ['http_request', 'upload', 'preparation_queue', 'preparation', 'template', 'tokenization', 'grammar', 'images',
    'native_queue', 'ttft', 'output_interval'],
  '1.0.2': ['http_request', 'upload', 'preparation_queue', 'preparation', 'template', 'tokenization', 'images',
    'native_queue', 'ttft', 'output_interval'],
};

// Expected SPIKES S7 state per /status variant: recovering > status_stale > not admitting > ready.
type State = 'Recovering' | 'Status stale' | 'Not admitting' | 'Ready';
const EXPECTED_STATE: Record<Version, Record<string, State>> = {
  '1.1.0': {
    'ready-idle': 'Ready', decoding: 'Ready', vision: 'Ready', 'ready-after-crash': 'Ready',
    'delta1-before': 'Ready', 'delta1-after': 'Ready', 'delta2-before': 'Ready', 'delta2-after': 'Ready',
    recovering: 'Recovering', 'status-stale': 'Status stale', 'stale-no-snapshot': 'Status stale',
    'metal-unhealthy': 'Not admitting', 'memory-critical': 'Not admitting',
  },
  '1.0.2': { 'ready-idle': 'Ready', decoding: 'Ready', recovering: 'Recovering' },
};
// Where each free-text / path canary is planted (every other /status body must not carry it).
const CRASH_TRACE_IN: Record<Version, string[]> = { '1.1.0': ['recovering', 'ready-after-crash'], '1.0.2': ['recovering'] };
const ERROR_IN: Record<Version, string[]> = {
  '1.1.0': ['recovering', 'status-stale', 'stale-no-snapshot'], '1.0.2': ['recovering'],
};
const METAL_IN: Record<Version, string[]> = { '1.1.0': ['metal-unhealthy'], '1.0.2': [] };
const EXPECTED_FILES: Record<Version, string[]> = {
  '1.1.0': [...Object.keys(EXPECTED_STATE['1.1.0']).map(v => `status.${v}.json`), 'v1-models.language-only.json',
    'v1-models.vision.json', 'v1-models.alias.json', 'metrics.ready-idle.txt'],
  '1.0.2': [...Object.keys(EXPECTED_STATE['1.0.2']).map(v => `status.${v}.json`), 'v1-models.default.json',
    'v1-models.alias.json'],
};

const text = (version: Version, file: string) => readFileSync(join(ROOT, version, file), 'utf8');
const body = (version: Version, file: string) => JSON.parse(text(version, file)) as Json;
const status = (version: Version, variant: string) => body(version, `status.${variant}.json`);
const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
const object = (value: unknown, where: string): Json => {
  expect(isObject(value), `${where} is an object`).toBe(true);
  return value as Json;
};
const at = (root: Json, path: string): unknown => path.split('.').reduce<unknown>(
  (value, key) => (isObject(value) ? value[key] : undefined), root);
const int = (root: Json, path: string) => {
  const value = at(root, path);
  expect(Number.isSafeInteger(value) && (value as number) >= 0, `${path} is a non-negative integer (${String(value)})`).toBe(true);
  return value as number;
};
const num = (root: Json, path: string) => {
  const value = at(root, path);
  expect(typeof value === 'number' && Number.isFinite(value) && value >= 0, `${path} is a non-negative number`).toBe(true);
  return value as number;
};
const bool = (root: Json, path: string) => {
  const value = at(root, path);
  expect(typeof value, `${path} is boolean`).toBe('boolean');
  return value as boolean;
};
const strings = (value: unknown, path = ''): Array<[string, string]> => {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((item, index) => strings(item, `${path}[${index}]`));
  if (isObject(value)) return Object.entries(value).flatMap(([key, item]) => strings(item, path ? `${path}.${key}` : key));
  return [];
};
const numbers = (value: unknown, out: Set<number> = new Set()): Set<number> => {
  if (typeof value === 'number') out.add(value);
  else if (typeof value === 'boolean') out.add(value ? 1 : 0);
  else if (Array.isArray(value)) value.forEach(item => numbers(item, out));
  else if (isObject(value)) Object.values(value).forEach(item => numbers(item, out));
  return out;
};
const inFlight = (s: Json) => int(s, 'requests.submitted') - int(s, 'requests.completed') - int(s, 'requests.failed')
  - int(s, 'requests.cancelled');
const busyRows = (s: Json) => int(s, 'scheduler.prefilling') + int(s, 'scheduler.decoding');
const stateOf = (s: Json): State => {
  if (at(s, 'transport.recovering') === true) return 'Recovering';
  if (at(s, 'transport.status_stale') === true) return 'Status stale';
  if (at(s, 'metal.healthy') !== true || at(s, 'memory_pressure') === 'critical') return 'Not admitting';
  return 'Ready';
};

describe.each(VERSIONS)('Splash %s corpus', version => {
  const files = readdirSync(join(ROOT, version)).filter(file => file !== 'SOURCE.md').sort();
  const statusVariants = Object.keys(EXPECTED_STATE[version]);

  test('inventory: every file is named <route>.<variant>.<ext> and has provenance in SOURCE.md', () => {
    expect(files).toEqual([...EXPECTED_FILES[version]].sort());
    const source = text(version, 'SOURCE.md');
    for (const file of files) {
      expect(file).toMatch(/^(status|v1-models|metrics)\.[a-z0-9-]+\.(json|txt)$/);
      expect(source, `SOURCE.md covers ${file}`).toContain(`\`${file}\``);
    }
    expect(source).toContain(version);
  });

  test('every JSON body parses and is a compact json_codec body (no whitespace, no trailing newline)', () => {
    for (const file of files.filter(name => name.endsWith('.json'))) {
      const raw = text(version, file);
      expect(() => JSON.parse(raw), file).not.toThrow();
      expect(raw.includes('\n') || /[,:]\s/.test(raw.replace(/"(?:[^"\\]|\\.)*"/g, '""')), file).toBe(false);
      // On the wire, histogram buckets are in ascending bound order (latency.py snapshot()).
      for (const match of raw.matchAll(/"buckets":\{([^}]*)\}/g))
        expect([...match[1].matchAll(/"([^"]+)":/g)].map(key => key[1]), file).toEqual(BUCKET_KEYS);
    }
  });

  test.each(statusVariants)('/status %s has the S7 shape', variant => {
    const s = status(version, variant);
    expect(s.schema_version).toBe(5);
    bool(s, 'ready');
    const transport = object(s.transport, 'transport');
    for (const key of ['ready', 'recovering', 'status_stale']) bool(s, `transport.${key}`);
    for (const key of ['pending', 'pending_limit', 'restarts']) int(s, `transport.${key}`);
    num(s, 'transport.status_age_ms');
    expect(transport.recovering).toBe(!transport.ready);
    expect(transport.last_crash_trace === null || typeof transport.last_crash_trace === 'string').toBe(true);
    expect('error' in transport).toBe(transport.status_stale === true);
    if (transport.status_stale === true) expect(typeof transport.error).toBe('string');
    else expect(transport.status_age_ms).toBe(0);

    const instance = object(s.instance, 'instance');
    expect(Object.keys(instance)).toEqual(['id', 'pid', 'model', 'host', 'port', 'started_at']);
    expect(instance.model).toBe(MODEL);
    for (const key of ['requests', 'request_body_bytes', 'token_counts', 'connections']) {
      int(s, `http.${key}.active`);
      int(s, `http.${key}.capacity`);
    }
    for (const key of ['preparation_capacity', 'active', 'waiting']) int(s, `frontend.${key}`);

    const latency = object(s.latency, 'latency');
    expect(Object.keys(latency)).toEqual(STAGES[version]);
    for (const stage of STAGES[version]) {
      const buckets = object(at(s, `latency.${stage}.buckets`), `${stage}.buckets`);
      // JSON.parse moves integer-like keys ('1', '5', '10', …) first, so compare as a set and walk by bound.
      expect(Object.keys(buckets).sort()).toEqual([...BUCKET_KEYS].sort());
      const counts = BUCKET_KEYS.map(key => buckets[key] as number);
      counts.forEach((count, index) => expect(count >= (counts[index - 1] ?? 0) && Number.isSafeInteger(count)).toBe(true));
      expect(counts.at(-1)).toBe(int(s, `latency.${stage}.count`));
      num(s, `latency.${stage}.sum`);
    }

    // A body without `requests` is the stale-no-snapshot case: only {schema_version, ready} of the native part.
    if (variant === 'stale-no-snapshot') {
      expect(s.ready).toBe(false);
      for (const key of ['requests', 'metrics', 'scheduler', 'metal', 'memory_pressure', 'identity']) expect(key in s).toBe(false);
    } else {
      for (const key of ['submitted', 'completed', 'cancelled', 'failed']) int(s, `requests.${key}`);
      for (const key of ['queued', 'waiting_resources', 'waiting_prefix', 'prefilling', 'decoding', 'waiting_mask', 'terminal',
        'prefill_batches', 'prefill_rows', 'decode_batches']) int(s, `scheduler.${key}`);
      for (const series of ['ttft_ms', 'itl_ms']) {
        const samples = int(s, `metrics.${series}.samples`);
        expect(samples).toBeLessThanOrEqual(4096);
        expect(num(s, `metrics.${series}.p50`)).toBeLessThanOrEqual(num(s, `metrics.${series}.p95`));
      }
      for (const key of ['decode_tokens_per_second', 'prefill_tokens_per_second', 'decode_wall_ms', 'prefill_wall_ms'])
        num(s, `metrics.${key}`);
      bool(s, 'metal.healthy');
      expect(typeof at(s, 'metal.failure_reason')).toBe('string');
      expect(['normal', 'warning', 'critical']).toContain(s.memory_pressure as string);
      expect(int(s, 'maximum_context_tokens')).toBeGreaterThan(0);
      expect(int(s, 'memory_actual.peak_bytes')).toBeGreaterThanOrEqual(int(s, 'memory_actual.current_bytes'));
      int(s, 'memory_governor.limit_bytes');
      expect(inFlight(s)).toBeGreaterThanOrEqual(0);
    }

    // Backend rule (backend.py status()): ready is forced false while stale, transport down, critical or Metal unhealthy.
    if (transport.ready !== true || transport.status_stale === true || s.memory_pressure === 'critical'
      || at(s, 'metal.healthy') !== true) expect(s.ready).toBe(false);
  });

  test.each(statusVariants)('/status %s is the state its name claims (SPIKES S7 precedence)', variant => {
    const s = status(version, variant);
    const expected = EXPECTED_STATE[version][variant];
    expect(stateOf(s)).toBe(expected);
    if (expected === 'Ready') expect(s.ready).toBe(true);
  });

  test('1.1 feature detection: vision, input_modalities and chat_template exist only in 1.1', () => {
    for (const variant of statusVariants) {
      const s = status(version, variant);
      if (version === '1.1.0') {
        expect(typeof s.vision).toBe('boolean');
        expect(s.input_modalities).toEqual(s.vision ? ['text', 'image', 'pdf'] : ['text']);
        expect(['native', 'patched', 'unsupported']).toContain(at(s, 'chat_template.later_system') as string);
        expect(isObject(s.tokenizer_cache)).toBe(true);
      } else {
        for (const key of ['vision', 'input_modalities', 'chat_template', 'tokenizer_cache']) expect(key in s).toBe(false);
      }
    }
    if (version === '1.1.0') {
      expect(status(version, 'vision').vision).toBe(true);
      expect(status(version, 'ready-idle').vision).toBe(false);
    }
  });

  test('privacy canaries: instance.* and identity.* are planted in every /status body', () => {
    for (const variant of statusVariants) {
      const s = status(version, variant);
      expect(s.instance).toEqual({ id: CANARY.instanceId, pid: CANARY.pid, model: MODEL, host: CANARY.host,
        port: CANARY.port, started_at: CANARY.startedAt });
      if (variant === 'stale-no-snapshot') continue;
      for (const [path, value] of Object.entries(CANARY.identity)) expect(at(s, `identity.${path}`), path).toBe(value);
      if (version === '1.1.0') expect(at(s, 'identity.kv.target_model_sha256')).toBe(CANARY.identity['q8.target_model_sha256']);
    }
  });

  test('privacy canaries: crash trace, transport.error and metal.failure_reason appear exactly where intended', () => {
    for (const variant of statusVariants) {
      const s = status(version, variant);
      const trace = at(s, 'transport.last_crash_trace');
      if (CRASH_TRACE_IN[version].includes(variant)) expect(trace).toBe(CANARY.crashTrace);
      else expect(trace).toBeNull();
      const error = at(s, 'transport.error');
      if (ERROR_IN[version].includes(variant)) expect(String(error)).toContain(CANARY.error);
      else expect(error).toBeUndefined();
      const reason = at(s, 'metal.failure_reason');
      if (METAL_IN[version].includes(variant)) expect(String(reason)).toContain(CANARY.metal);
      else if (reason !== undefined) expect(reason).toBe('');
    }
  });

  test('privacy canaries: no CANARY string outside the planted paths, no prompt text, no private paths', () => {
    for (const file of files) {
      const raw = text(version, file);
      expect(raw).not.toContain('CANARY-PROMPT');
      for (const match of raw.matchAll(/\/Users\/[A-Za-z0-9._-]+/g)) expect(match[0]).toBe('/Users/fixture');
      if (!file.endsWith('.json')) continue;
      for (const [path, value] of strings(JSON.parse(raw))) {
        if (value.includes('CANARY')) expect(CANARY_PATHS.has(path), `${file}: ${path}`).toBe(true);
      }
    }
    for (const file of files.filter(name => !name.startsWith('status.'))) {
      const raw = text(version, file);
      for (const needle of ['CANARY', String(CANARY.pid), CANARY.host, String(CANARY.port)])
        expect(raw, `${file} carries no instance/identity data`).not.toContain(needle);
    }
  });

  test('/v1/models lists the resident model with 1.1-only catalog chips', () => {
    for (const file of files.filter(name => name.startsWith('v1-models.'))) {
      const models = body(version, file);
      expect(models.object).toBe('list');
      const data = models.data as Json[];
      const typed = models.models as Json[];
      expect(Array.isArray(data) && data.length > 0).toBe(true);
      expect(typed.map(item => item.name)).toEqual(data.map(item => item.id));
      expect(data[0].id).toBe(MODEL);
      for (const item of typed) expect(item).toEqual({ name: item.name, description: 'Splash resident model', release_date: '' });
      for (const [index, item] of data.entries()) {
        expect(item).toMatchObject({ object: 'model', created: 0, owned_by: 'splash' });
        if (index > 0) expect(item.root).toBe(MODEL);
        else expect('root' in item).toBe(false);
        if (version === '1.1.0') {
          expect(typeof item.vision).toBe('boolean');
          expect(item.input_modalities).toEqual(item.vision ? ['text', 'image', 'pdf'] : ['text']);
          expect(item.max_model_len).toBe(item.context_length as number);
        } else {
          for (const key of ['vision', 'input_modalities', 'max_model_len', 'context_length']) expect(key in item).toBe(false);
        }
      }
    }
    if (version === '1.1.0') {
      expect((body(version, 'v1-models.vision.json').data as Json[])[0].vision).toBe(true);
      expect((body(version, 'v1-models.language-only.json').data as Json[])[0].vision).toBe(false);
    }
  });
});

describe('Splash 1.1.0 counter-delta pairs (per-request TTFT derivation, SPIKES S7)', () => {
  const pair = (before: string, after: string) => {
    const a = status('1.1.0', before), b = status('1.1.0', after);
    return {
      a, b,
      count: int(b, 'latency.ttft.count') - int(a, 'latency.ttft.count'),
      completed: int(b, 'requests.completed') - int(a, 'requests.completed'),
      sumMs: (num(b, 'latency.ttft.sum') - num(a, 'latency.ttft.sum')) * 1000,
    };
  };
  const derivable = (p: ReturnType<typeof pair>) => p.count === 1 && p.completed === 1
    && inFlight(p.a) <= 1 && inFlight(p.b) <= 1 && busyRows(p.a) <= 1 && busyRows(p.b) <= 1
    && int(p.a, 'scheduler.queued') === 0 && int(p.b, 'scheduler.queued') === 0;

  test('Δ=1: one completion between two idle reads derives one TTFT of 412.5 ms', () => {
    const p = pair('delta1-before', 'delta1-after');
    expect([p.count, p.completed, inFlight(p.a), inFlight(p.b)]).toEqual([1, 1, 0, 0]);
    expect(derivable(p)).toBe(true);
    expect(p.sumMs).toBeCloseTo(412.5, 6);
    expect(int(p.b, 'requests.submitted') - int(p.a, 'requests.submitted')).toBe(1);
    expect(int(p.b, 'metrics.ttft_ms.samples') - int(p.a, 'metrics.ttft_ms.samples')).toBe(1);
    expect(p.a.transport).toMatchObject({ status_stale: false, recovering: false });
    expect(p.b.transport).toMatchObject({ status_stale: false, recovering: false });
  });

  test('Δ=2: two completions between reads are aggregate-only (mean 944.75 ms), never per-request', () => {
    const p = pair('delta2-before', 'delta2-after');
    expect([p.count, p.completed, inFlight(p.a), inFlight(p.b)]).toEqual([2, 2, 0, 0]);
    expect(derivable(p)).toBe(false);
    expect(p.sumMs / p.count).toBeCloseTo(944.75, 6);
  });

  test('negative controls: an in-flight read and an engine restart never derive a TTFT', () => {
    const busy = pair('ready-idle', 'decoding');
    expect([busy.count, busy.completed, inFlight(busy.b)]).toEqual([1, 0, 2]);
    expect(derivable(busy)).toBe(false);
    // recovering → ready-after-crash: native counters reset with the new engine process; Python latency continues.
    const restart = pair('recovering', 'ready-after-crash');
    expect(restart.completed).toBeLessThan(0);
    expect(restart.count).toBeGreaterThan(0);
    expect(derivable(restart)).toBe(false);
  });

  test('the Δ=1 pair is the ready-idle state (before) plus exactly one request', () => {
    expect(status('1.1.0', 'delta1-before')).toEqual(status('1.1.0', 'ready-idle'));
  });
});

describe('Splash 1.1.0 /metrics sample (kept only for the S7 "not used" decision)', () => {
  const raw = text('1.1.0', 'metrics.ready-idle.txt');
  const s = status('1.1.0', 'ready-idle');
  const samples = raw.split('\n').filter(line => line && !line.startsWith('#')).map(line => {
    const match = /^([a-z_:][a-z0-9_:]*)(\{[^}]*\})? (\S+)$/.exec(line);
    expect(match, line).not.toBeNull();
    return { name: match![1], labels: match![2] ?? '', value: Number(match![3]) };
  });
  const value = (name: string, labels = '') => samples.find(sample => sample.name === name && sample.labels === labels)?.value;

  test('Prometheus 0.0.4 text: 108 series, 11 typed histograms, trailing newline', () => {
    expect(raw.endsWith('\n')).toBe(true);
    const series = new Set(samples.map(sample => sample.name.replace(/_(bucket|count|sum)$/, '')));
    expect(series.size).toBe(108);
    const histograms = [...raw.matchAll(/^# TYPE (\S+) histogram$/gm)].map(match => match[1]);
    expect(histograms).toEqual(STAGES['1.1.0'].map(stage => `splash_${stage}_seconds`));
  });

  test('every value is already in /status (adds nothing; S7 reads /status only)', () => {
    const known = numbers(s);
    for (const sample of samples) expect(known.has(sample.value), `${sample.name}${sample.labels}`).toBe(true);
    expect(value('splash_requests_completed_total')).toBe(int(s, 'requests.completed'));
    expect(value('splash_ttft_p95_milliseconds')).toBe(num(s, 'metrics.ttft_ms.p95'));
    expect(value('splash_ttft_seconds_count')).toBe(int(s, 'latency.ttft.count'));
    expect(value('splash_ttft_seconds_bucket', '{le="+Inf"}')).toBe(int(s, 'latency.ttft.count'));
    expect(value('splash_memory_pressure', '{state="normal"}')).toBe(1);
    expect(value('splash_ready')).toBe(1);
  });
});

// Splash 1.2.0 is a captured-and-scrubbed corpus (1.2.0/SOURCE.md), not a synthesized one, and its /status schema is 6,
// so it gets its own checks instead of the schema-5 tables above.
describe('Splash 1.2.0 captured corpus (status schema 6)', () => {
  const DIR = '1.2.0';
  const VARIANTS = ['ready-idle', 'delta1-before', 'decoding', 'delta1-after'];
  const STAGES_12 = ['http_request', 'upload', 'preparation_queue', 'preparation', 'template', 'tokenization', 'grammar', 'images',
    'native_queue', 'http_ttft', 'output_interval'];
  const raw = (file: string) => readFileSync(join(ROOT, DIR, file), 'utf8');
  const read = (file: string) => JSON.parse(raw(file)) as Json;
  const files = readdirSync(join(ROOT, DIR)).filter(file => file !== 'SOURCE.md').sort();

  test('inventory: the four /status reads and /v1/models, each with provenance in SOURCE.md', () => {
    expect(files).toEqual([...VARIANTS.map(variant => `status.${variant}.json`), 'v1-models.default.json'].sort());
    const source = raw('SOURCE.md');
    for (const file of files) expect(source, `SOURCE.md covers ${file}`).toContain(`\`${file}\``);
    expect(source).toContain('captured from a local server and scrubbed');
  });

  test('every body is a compact json_codec body with ascending bucket bounds', () => {
    for (const file of files) {
      const text = raw(file);
      expect(text.includes('\n') || /[,:]\s/.test(text.replace(/"(?:[^"\\]|\\.)*"/g, '""')), file).toBe(false);
      for (const match of text.matchAll(/"buckets":\{([^}]*)\}/g))
        expect([...match[1].matchAll(/"([^"]+)":/g)].map(key => key[1]), file).toEqual(BUCKET_KEYS);
    }
  });

  test.each(VARIANTS)('/status %s: schema 6, Ready, latency.http_ttft in place of latency.ttft, canaries planted', variant => {
    const s = read(`status.${variant}.json`);
    expect(s.schema_version).toBe(6);
    expect(stateOf(s)).toBe('Ready');
    expect(s.ready).toBe(true);
    expect(Object.keys(object(s.latency, 'latency'))).toEqual(STAGES_12);
    const buckets = object(at(s, 'latency.http_ttft.buckets'), 'http_ttft.buckets');
    expect(Object.keys(buckets).sort()).toEqual([...BUCKET_KEYS].sort());
    expect(buckets['+Inf']).toBe(int(s, 'latency.http_ttft.count'));
    num(s, 'latency.http_ttft.sum');
    for (const key of ['submitted', 'completed', 'cancelled', 'failed']) int(s, `requests.${key}`);
    for (const key of ['decode_output_tokens', 'prefill_input_tokens']) int(s, `metrics.${key}`);
    for (const key of ['decode_wall_ms', 'prefill_wall_ms']) num(s, `metrics.${key}`);
    expect(int(s, 'memory_actual.peak_bytes')).toBeGreaterThanOrEqual(int(s, 'memory_actual.current_bytes'));
    expect(s.instance).toEqual({ id: CANARY.instanceId, pid: CANARY.pid, model: MODEL, host: CANARY.host,
      port: CANARY.port, started_at: CANARY.startedAt });
    expect(at(s, 'identity.cache.loaded_model_layout_sha256')).toBe(CANARY.identity['cache.loaded_model_layout_sha256']);
    expect(at(s, 'identity.cache.build_id')).toBe(CANARY.identity['cache.build_id']);
    expect(at(s, 'identity.kv.target_model_sha256')).toBe(CANARY.identity['q8.target_model_sha256']);
    expect(at(s, 'transport.last_crash_trace')).toBeNull();
    expect(at(s, 'transport.error')).toBeUndefined();
    expect(at(s, 'metal.failure_reason')).toBe('');
    expect(s.input_modalities).toEqual(s.vision ? ['text', 'image', 'pdf'] : ['text']);
  });

  test('privacy: CANARY strings only at the planted paths, and no real paths', () => {
    for (const file of files) {
      const text = raw(file);
      expect(text).not.toContain('CANARY-PROMPT');
      for (const match of text.matchAll(/\/Users\/[A-Za-z0-9._-]+/g)) expect(match[0]).toBe('/Users/fixture');
      for (const [path, value] of strings(JSON.parse(text)))
        if (value.includes('CANARY')) expect(CANARY_PATHS.has(path), `${file}: ${path}`).toBe(true);
    }
    expect(raw('v1-models.default.json')).not.toContain('CANARY');
  });

  test('Δ=1 pair: exactly one request between two idle reads, with a mid-reply read in between', () => {
    const before = read('status.delta1-before.json'), done = read('status.delta1-after.json'), mid = read('status.decoding.json');
    expect([inFlight(before), inFlight(mid), inFlight(done)]).toEqual([0, 1, 0]);
    expect(busyRows(mid)).toBeGreaterThan(0);
    for (const path of ['requests.submitted', 'requests.completed', 'latency.http_ttft.count'])
      expect(int(done, path) - int(before, path), path).toBe(1);
    expect(Math.round((num(done, 'latency.http_ttft.sum') - num(before, 'latency.http_ttft.sum')) * 1e6) / 1e3).toBe(207.117);
  });

  test('/v1/models lists the resident model with its catalog chips', () => {
    const models = read('v1-models.default.json'), [item] = models.data as Json[];
    expect(models.object).toBe('list');
    expect(item).toMatchObject({ id: MODEL, object: 'model', created: 0, owned_by: 'splash' });
    expect(item.max_model_len).toBe(item.context_length as number);
    expect(item.input_modalities).toEqual(item.vision ? ['text', 'image', 'pdf'] : ['text']);
  });
});

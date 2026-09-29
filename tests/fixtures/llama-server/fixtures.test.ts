// Integrity tests for the llama-server fixture corpora (b10519 master-era, b6700 pre-sleep).
// They check the corpora themselves, not an adapter: every body parses, carries the SPIKES S7b shapes for its build,
// and each planted privacy canary sits exactly where SOURCE.md says, so adapter tests can later prove none leaks.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Fixture bodies are untyped JSON.
type J = any;

const ROOT = import.meta.dir;
const VERSIONS = ['b10519', 'b6700'] as const;
type Version = typeof VERSIONS[number];

const read = (version: Version, file: string) => readFileSync(join(ROOT, version, file), 'utf8');
const json = (version: Version, file: string): J => JSON.parse(read(version, file));
const fixtureFiles = (version: Version) => readdirSync(join(ROOT, version)).filter(file => file !== 'SOURCE.md').sort();

const EXPECTED_FILES: Record<Version, string[]> = {
  b10519: [
    'health.loading-503.json', 'health.ok.json',
    'metrics.disabled-501.json', 'metrics.idle.txt', 'metrics.large-counters.txt', 'metrics.no-spec.txt',
    'metrics.scrape-1.txt', 'metrics.scrape-2.txt', 'metrics.scrape-3.txt',
    'props.no-metrics.json', 'props.normal.json', 'props.router.json', 'props.sleeping.json', 'props.unauthorized-401.json',
    'slots.all-idle.json', 'slots.debug.json', 'slots.disabled-501.json', 'slots.fresh.json', 'slots.one-busy.json',
    'slots.two-busy.json',
  ],
  b6700: [
    'health.loading-503.json', 'health.ok.json',
    'metrics.disabled-501.json', 'metrics.idle.txt', 'metrics.scrape-1.txt', 'metrics.scrape-2.txt', 'metrics.scrape-3.txt',
    'props.no-metrics.json', 'props.normal.json', 'props.unauthorized-401.json',
    'slots.all-idle.json', 'slots.disabled-501.json', 'slots.one-busy.json', 'slots.two-busy.json',
  ],
};
const UPSTREAM_COMMIT: Record<Version, string> = {
  b10519: '947fd9bb2bdeaa72e9dd74b6aa3b5d68f03f3d6a',
  b6700: '3df2244df40c67dfd6ad548b40ccc507a066af2b',
};
const MODEL_FILE = 'example-27b-q4.gguf';

// ------------------------------------------------------------------ Prometheus text (test-only, strict)
interface Sample { name: string; labels: Record<string, string>; value: number }
interface Scrape { types: Map<string, string>; helps: Map<string, string>; samples: Sample[]; raw: string }

function parseProm(raw: string): Scrape {
  if (!raw.endsWith('\n') || raw.includes('\r') || raw.includes('\n\n')) throw new Error('malformed exposition framing');
  const types = new Map<string, string>(), helps = new Map<string, string>(), samples: Sample[] = [];
  for (const line of raw.slice(0, -1).split('\n')) {
    let match = /^# HELP (\S+) (.+)$/.exec(line);
    if (match) {
      if (types.has(match[1]!)) throw new Error(`HELP after TYPE for ${match[1]}`);
      helps.set(match[1]!, match[2]!);
      continue;
    }
    match = /^# TYPE (\S+) (counter|gauge)$/.exec(line);
    if (match) {
      if (!helps.has(match[1]!)) throw new Error(`TYPE without HELP for ${match[1]}`);
      types.set(match[1]!, match[2]!);
      continue;
    }
    match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})? (\S+)$/.exec(line);
    if (!match) throw new Error(`unparsed line: ${line}`);
    if (!types.has(match[1]!)) throw new Error(`sample before TYPE: ${match[1]}`);
    const labels: Record<string, string> = {};
    for (const pair of match[2] ? match[2].split(',') : []) {
      const label = /^([a-zA-Z_][a-zA-Z0-9_]*)="([^"\\]*)"$/.exec(pair);
      if (!label) throw new Error(`bad label: ${pair}`);
      labels[label[1]!] = label[2]!;
    }
    samples.push({ name: match[1]!, labels, value: Number(match[3]) });
  }
  return { types, helps, samples, raw };
}
const scrape = (version: Version, file: string) => parseProm(read(version, file));
function value(parsed: Scrape, name: string): number {
  const hits = parsed.samples.filter(sample => sample.name === `llamacpp:${name}` && !Object.keys(sample.labels).length);
  if (hits.length !== 1) throw new Error(`expected one ${name}, got ${hits.length}`);
  return hits[0]!.value;
}
const delta = (a: Scrape, b: Scrape, name: string) => value(b, name) - value(a, name);

const PER_POS = 'llamacpp:spec_decode_num_accepted_tokens_per_pos_total';
const TYPES: Record<Version, Record<string, 'counter' | 'gauge'>> = {
  // server-task.cpp:1525-1619 @ b10519
  b10519: {
    'llamacpp:prompt_tokens_total': 'counter',
    'llamacpp:prompt_tokens_cached_total': 'counter',
    'llamacpp:prompt_seconds_total': 'counter',
    'llamacpp:tokens_predicted_total': 'counter',
    'llamacpp:tokens_predicted_seconds_total': 'counter',
    'llamacpp:n_decode_total': 'counter',
    'llamacpp:n_tokens_max': 'counter',
    'llamacpp:spec_decode_num_draft_tokens_total': 'counter',
    'llamacpp:spec_decode_num_accepted_tokens_total': 'counter',
    'llamacpp:spec_decode_num_drafts_total': 'counter',
    'llamacpp:prompt_tokens_seconds': 'gauge',
    'llamacpp:predicted_tokens_seconds': 'gauge',
    'llamacpp:requests_processing': 'gauge',
    'llamacpp:requests_deferred': 'gauge',
    'llamacpp:n_busy_slots_per_decode': 'gauge',
  },
  // server.cpp:4308-4406 @ b6700
  b6700: {
    'llamacpp:prompt_tokens_total': 'counter',
    'llamacpp:prompt_seconds_total': 'counter',
    'llamacpp:tokens_predicted_total': 'counter',
    'llamacpp:tokens_predicted_seconds_total': 'counter',
    'llamacpp:n_decode_total': 'counter',
    'llamacpp:n_past_max': 'counter',
    'llamacpp:n_busy_slots_per_decode': 'counter',
    'llamacpp:prompt_tokens_seconds': 'gauge',
    'llamacpp:predicted_tokens_seconds': 'gauge',
    'llamacpp:requests_processing': 'gauge',
    'llamacpp:requests_deferred': 'gauge',
  },
};

// ------------------------------------------------------------------ inventory, provenance, framing
describe('llama-server fixture inventory', () => {
  for (const version of VERSIONS) {
    test(`${version}: exactly the documented files, each with provenance in SOURCE.md`, () => {
      expect(fixtureFiles(version)).toEqual([...EXPECTED_FILES[version]].sort());
      const source = read(version, 'SOURCE.md');
      expect(source).toContain(UPSTREAM_COMMIT[version]);
      expect(source).toContain(`build **${version}**`);
      expect(source).toContain('synthesized from upstream source');
      for (const file of EXPECTED_FILES[version]) expect(source).toContain(`\`${file}\``);
    });

    test(`${version}: JSON bodies parse and are wire-shaped (compact, one line, no trailing newline)`, () => {
      for (const file of fixtureFiles(version).filter(name => name.endsWith('.json'))) {
        const raw = read(version, file);
        expect(() => JSON.parse(raw)).not.toThrow();
        expect(raw.includes('\n')).toBe(false);
        expect(/[:,] /.test(raw.replace(/"(?:[^"\\]|\\.)*"/g, '""'))).toBe(false);
      }
    });

    test(`${version}: Prometheus bodies parse strictly`, () => {
      for (const file of fixtureFiles(version).filter(name => name.endsWith('.txt'))) {
        const parsed = scrape(version, file);
        expect(parsed.samples.length).toBeGreaterThan(0);
        for (const sample of parsed.samples) {
          expect(Number.isFinite(sample.value)).toBe(true);
          expect(sample.value).toBeGreaterThanOrEqual(0);
        }
      }
    });

    test(`${version}: the only home path is /Users/fixture, and there are no PIDs, keys or tokens`, () => {
      for (const file of fixtureFiles(version)) {
        const raw = read(version, file);
        for (const home of raw.match(/\/Users\/[^/"]+/g) ?? []) expect(home).toBe('/Users/fixture');
        expect(raw).not.toMatch(/\/home\//);
        expect(raw).not.toMatch(/"pid"|api_key|Bearer |cookie/i);
      }
    });
  }
});

// ------------------------------------------------------------------ /health and error bodies
describe('llama-server /health and error bodies', () => {
  for (const version of VERSIONS) {
    test(`${version}: /health ok and 503 loading`, () => {
      expect(json(version, 'health.ok.json')).toEqual({ status: 'ok' });
      const loading = json(version, 'health.loading-503.json');
      expect(loading.error).toMatchObject({ code: 503, type: 'unavailable_error', message: 'Loading model' });
      // b10519's middleware writes message,type,code; b6700 uses format_error_response (code,message,type)
      expect(Object.keys(loading.error)).toEqual(version === 'b10519' ? ['message', 'type', 'code'] : ['code', 'message', 'type']);
    });

    test(`${version}: 501 for disabled /slots and /metrics, 401 for a keyed server`, () => {
      const slots = json(version, 'slots.disabled-501.json').error;
      expect(Object.keys(slots)).toEqual(['code', 'message', 'type']);
      expect(slots).toMatchObject({ code: 501, type: 'not_supported_error' });
      expect(slots.message).toContain('`--slots`');
      const metrics = json(version, 'metrics.disabled-501.json').error;
      expect(metrics).toMatchObject({ code: 501, type: 'not_supported_error' });
      expect(metrics.message).toContain('`--metrics`');
      const unauthorized = json(version, 'props.unauthorized-401.json').error;
      expect(unauthorized).toMatchObject({ code: 401, type: 'authentication_error', message: 'Invalid API Key' });
    });
  }
});

// ------------------------------------------------------------------ /props
function buildNumber(props: J): number {
  const match = /^b(\d+)-[0-9a-f]{7,}$/.exec(props.build_info);
  if (!match) throw new Error(`bad build_info ${props.build_info}`);
  return Number(match[1]);
}

describe('llama-server /props', () => {
  for (const version of VERSIONS) {
    test(`${version}: normal props carry the detection keys and numeric/boolean allowlist`, () => {
      const props = json(version, 'props.normal.json');
      expect(buildNumber(props)).toBe(Number(version.slice(1)));
      expect(Number.isInteger(props.total_slots) && props.total_slots > 0).toBe(true);
      expect(Number.isInteger(props.default_generation_settings.n_ctx) && props.default_generation_settings.n_ctx > 0).toBe(true);
      expect(props.endpoint_metrics).toBe(true);
      expect(props.endpoint_slots).toBe(true);
      expect(typeof props.endpoint_props).toBe('boolean');
      expect(typeof props.modalities.vision).toBe('boolean');
      expect(typeof props.modalities.audio).toBe('boolean');
      expect(typeof props.model_path).toBe('string');
      expect(props.model_path.split('/').at(-1)).toBe(MODEL_FILE);
      expect(typeof props.chat_template).toBe('string');
      const params = props.default_generation_settings.params;
      expect(typeof params.temperature).toBe('number');
      expect(Array.isArray(params.samplers)).toBe(true);
    });

    test(`${version}: no-metrics props differ from normal only in endpoint_metrics`, () => {
      const normal = json(version, 'props.normal.json');
      const noMetrics = json(version, 'props.no-metrics.json');
      expect(noMetrics.endpoint_metrics).toBe(false);
      expect({ ...noMetrics, endpoint_metrics: true }).toEqual(normal);
    });
  }

  test('b10519: sleep-capable shape (is_sleeping, video modality, model_alias, generation_prompt empty)', () => {
    const props = json('b10519', 'props.normal.json');
    const build = buildNumber(props);
    expect(build >= 7492).toBe(true);    // S7b: sleep-capable, /slots wakes it
    expect(build >= 10519).toBe(true);   // S7b: /metrics bypasses sleep
    expect(props.is_sleeping).toBe(false);
    expect(typeof props.modalities.video).toBe('boolean');
    expect(props.model_alias).toBe(MODEL_FILE);
    expect(props.default_generation_settings.params.generation_prompt).toBe('');
    expect(props.default_generation_settings.params['speculative.types']).toBe('none');
    expect(Object.keys(props.chat_template_caps)).toEqual([...Object.keys(props.chat_template_caps)].sort());
  });

  test('b10519: sleeping props differ from normal only in is_sleeping', () => {
    const sleeping = json('b10519', 'props.sleeping.json');
    expect(sleeping.is_sleeping).toBe(true);
    expect({ ...sleeping, is_sleeping: false }).toEqual(json('b10519', 'props.normal.json'));
  });

  test('b10519: router props are recognisable and not a single-model server', () => {
    const router = json('b10519', 'props.router.json');
    expect(router.role).toBe('router');
    expect(router.model_path).toBe('none');
    expect('total_slots' in router).toBe(false);
    expect(router.default_generation_settings).toEqual({ params: {}, n_ctx: 0 });
    expect(buildNumber(router)).toBe(10519);
  });

  test('b6700: pre-sleep shape (no is_sleeping, full slot as default_generation_settings)', () => {
    const props = json('b6700', 'props.normal.json');
    const build = buildNumber(props);
    expect(build >= 6337 && build < 7492).toBe(true);   // S7b: /slots exists, cannot sleep
    expect('is_sleeping' in props).toBe(false);
    expect('video' in props.modalities).toBe(false);
    const dgs = props.default_generation_settings;
    expect(Object.keys(dgs)).toEqual(['id', 'id_task', 'n_ctx', 'speculative', 'is_processing', 'params', 'prompt', 'next_token']);
    expect(dgs.prompt).toBe('');
    expect('generation_prompt' in dgs.params).toBe(false);
    expect(dgs.next_token).toEqual({ has_next_token: true, has_new_line: false, n_remain: -1, n_decoded: 0, stopping_word: '' });
  });
});

// ------------------------------------------------------------------ /slots
const FRESH_KEYS = ['id', 'n_ctx', 'speculative', 'is_processing'];
const B6700_SLOT_KEYS = ['id', 'id_task', 'n_ctx', 'speculative', 'is_processing', 'params', 'next_token'];
const NEXT_TOKEN_KEYS = ['has_next_token', 'has_new_line', 'n_remain', 'n_decoded'];
const isInt = (x: unknown) => Number.isInteger(x);

function checkSlotB10519(slot: J, debug: boolean) {
  expect(isInt(slot.id) && isInt(slot.n_ctx)).toBe(true);
  expect(typeof slot.speculative).toBe('boolean');
  expect(typeof slot.is_processing).toBe('boolean');
  if (!('id_task' in slot)) {
    expect(Object.keys(slot)).toEqual(FRESH_KEYS);
    expect(slot.is_processing).toBe(false);
    return;
  }
  for (const key of ['id_task', 'n_prompt_tokens', 'n_prompt_tokens_processed', 'n_prompt_tokens_cache']) expect(isInt(slot[key])).toBe(true);
  expect(Array.isArray(slot.next_token)).toBe(true);
  expect(slot.next_token).toHaveLength(1);
  const next = slot.next_token[0];
  expect(Object.keys(next)).toEqual(NEXT_TOKEN_KEYS);
  expect(typeof next.has_next_token).toBe('boolean');
  expect(isInt(next.n_remain) && isInt(next.n_decoded)).toBe(true);
  expect(slot.n_prompt_tokens).toBeGreaterThanOrEqual(slot.n_prompt_tokens_processed + slot.n_prompt_tokens_cache + next.n_decoded);
  if (!slot.is_processing) {
    // reset() inside release() zeroes the stats on this build (server-context.cpp:325-360, 500-521)
    expect([slot.n_prompt_tokens_processed, slot.n_prompt_tokens_cache, next.n_decoded, next.n_remain]).toEqual([0, 0, 0, -1]);
    expect(next.has_next_token).toBe(false);
  }
  expect(typeof slot.params.generation_prompt).toBe('string');
  expect('prompt' in slot).toBe(debug);
  expect('generated' in slot).toBe(debug);
  expect('stop' in slot.params).toBe(debug);
}

function checkSlotB6700(slot: J) {
  expect(Object.keys(slot)).toEqual(B6700_SLOT_KEYS);
  expect(isInt(slot.id) && isInt(slot.id_task) && isInt(slot.n_ctx)).toBe(true);
  expect(Array.isArray(slot.next_token)).toBe(false);
  expect(Object.keys(slot.next_token)).toEqual(NEXT_TOKEN_KEYS);
  expect(isInt(slot.next_token.n_decoded) && isInt(slot.next_token.n_remain)).toBe(true);
  expect('generation_prompt' in slot.params).toBe(false);
  expect('stop' in slot.params).toBe(false);
  if (slot.id_task === -1) {
    expect(slot.is_processing).toBe(false);
    expect(slot.next_token.n_decoded).toBe(0);
  }
}

describe('llama-server /slots', () => {
  const BUSY: Record<Version, Record<string, number>> = {
    b10519: { 'slots.fresh.json': 0, 'slots.one-busy.json': 1, 'slots.two-busy.json': 2, 'slots.all-idle.json': 0, 'slots.debug.json': 1 },
    b6700: { 'slots.one-busy.json': 1, 'slots.two-busy.json': 2, 'slots.all-idle.json': 0 },
  };
  for (const version of VERSIONS) {
    for (const [file, busy] of Object.entries(BUSY[version])) {
      test(`${version} ${file}: ${busy} busy, one entry per props slot, per-build slot shape`, () => {
        const props = json(version, 'props.normal.json');
        const slots = json(version, file);
        expect(Array.isArray(slots)).toBe(true);
        expect(slots).toHaveLength(props.total_slots);
        expect(slots.map((slot: J) => slot.id)).toEqual([...Array(props.total_slots).keys()]);
        for (const slot of slots) {
          expect(slot.n_ctx).toBe(props.default_generation_settings.n_ctx);
          if (version === 'b10519') checkSlotB10519(slot, file === 'slots.debug.json');
          else checkSlotB6700(slot);
        }
        expect(slots.filter((slot: J) => slot.is_processing).length).toBe(busy);
      });
    }
  }

  test('two-busy fixtures include one slot still before its first token', () => {
    for (const version of VERSIONS) {
      const slots = json(version, 'slots.two-busy.json');
      const decoded = slots.filter((slot: J) => slot.is_processing)
        .map((slot: J) => (Array.isArray(slot.next_token) ? slot.next_token[0] : slot.next_token).n_decoded);
      expect(decoded.filter((n: number) => n === 0)).toHaveLength(1);
      expect(decoded.filter((n: number) => n > 0)).toHaveLength(1);
    }
  });

  test('b6700: an idle slot keeps its last n_decoded (release() does not reset)', () => {
    const idle = json('b6700', 'slots.all-idle.json').filter((slot: J) => slot.id_task !== -1);
    expect(idle.map((slot: J) => slot.next_token.n_decoded)).toEqual([540, 312, 300]);
  });
});

// ------------------------------------------------------------------ /metrics
describe('llama-server /metrics', () => {
  for (const version of VERSIONS) {
    for (const file of EXPECTED_FILES[version].filter(name => name.endsWith('.txt'))) {
      test(`${version} ${file}: series names and types follow SPIKES S7b for this build`, () => {
        const parsed = scrape(version, file);
        const expected: Record<string, string> = { ...TYPES[version] };
        const perPos = parsed.samples.filter(sample => sample.name === PER_POS);
        if (perPos.length) expected[PER_POS] = 'counter';
        expect(Object.fromEntries(parsed.types)).toEqual(expected);
        for (const name of Object.keys(TYPES[version])) expect(parsed.samples.filter(sample => sample.name === name)).toHaveLength(1);
        for (const [name, type] of parsed.types) expect(parsed.helps.has(name) && ['counter', 'gauge'].includes(type)).toBe(true);
        if (perPos.length) {
          expect(perPos.map(sample => sample.labels.position)).toEqual(perPos.map((_, index) => String(index)));
          expect(perPos.reduce((sum, sample) => sum + sample.value, 0)).toBe(value(parsed, 'spec_decode_num_accepted_tokens_total'));
        }
      });
    }
  }

  test('b10519 carries spec_decode_* and prompt_tokens_cached_total; b6700 carries n_past_max and neither', () => {
    const master = scrape('b10519', 'metrics.scrape-1.txt');
    expect(master.types.has('llamacpp:spec_decode_num_drafts_total')).toBe(true);
    expect(master.types.has('llamacpp:prompt_tokens_cached_total')).toBe(true);
    expect(master.types.get('llamacpp:n_busy_slots_per_decode')).toBe('gauge');
    const old = scrape('b6700', 'metrics.scrape-1.txt');
    expect([...old.types.keys()].some(name => name.includes('spec_decode') || name.includes('cached'))).toBe(false);
    expect(old.types.get('llamacpp:n_past_max')).toBe('counter');
    expect(old.types.get('llamacpp:n_busy_slots_per_decode')).toBe('counter');
  });

  test('b10519 no-spec: speculative counters present at 0 with no per-position series', () => {
    const parsed = scrape('b10519', 'metrics.no-spec.txt');
    for (const name of ['spec_decode_num_draft_tokens_total', 'spec_decode_num_accepted_tokens_total', 'spec_decode_num_drafts_total']) {
      expect(value(parsed, name)).toBe(0);
    }
    expect(parsed.types.has(PER_POS)).toBe(false);
    expect(value(parsed, 'requests_processing')).toBe(1);
  });

  test('b10519 large counters: %g exponent form with 6 significant digits', () => {
    const parsed = scrape('b10519', 'metrics.large-counters.txt');
    expect(parsed.raw).toContain('llamacpp:prompt_tokens_total 3.21457e+06\n');
    expect(value(parsed, 'prompt_tokens_total')).toBe(3_214_570);
    expect(value(parsed, 'tokens_predicted_total')).toBe(1_048_730);
    expect(value(parsed, 'requests_processing')).toBe(4);
    expect(value(parsed, 'requests_deferred')).toBe(2);
    // the labelled per-position series is uint64 and printed exactly
    expect(parsed.samples.filter(sample => sample.name === PER_POS).map(sample => sample.value)).toEqual([421001, 305162, 176000]);
  });

  test('idle scrapes report nothing processing', () => {
    for (const version of VERSIONS) {
      const parsed = scrape(version, 'metrics.idle.txt');
      expect(value(parsed, 'requests_processing')).toBe(0);
      expect(value(parsed, 'requests_deferred')).toBe(0);
    }
  });
});

// ------------------------------------------------------------------ counter deltas across consecutive scrapes
describe('llama-server consecutive scrapes (5.000 s apart)', () => {
  const WINDOW_S = 5;
  for (const version of VERSIONS) {
    test(`${version}: *_total counters never decrease across scrape-1 -> 2 -> 3 -> idle`, () => {
      const sequence = ['metrics.scrape-1.txt', 'metrics.scrape-2.txt', 'metrics.scrape-3.txt', 'metrics.idle.txt'].map(file => scrape(version, file));
      const totals = Object.keys(TYPES[version]).filter(name => name.endsWith('_total')).map(name => name.slice('llamacpp:'.length));
      for (let index = 1; index < sequence.length; index++) {
        for (const name of totals) expect(delta(sequence[index - 1]!, sequence[index]!, name)).toBeGreaterThanOrEqual(0);
      }
    });
  }

  test('b10519 1 -> 2: busy but no completion, so no decode rate; prompt rate 800 tok/s', () => {
    const [a, b] = [scrape('b10519', 'metrics.scrape-1.txt'), scrape('b10519', 'metrics.scrape-2.txt')];
    expect(value(a, 'requests_processing')).toBe(1);
    expect(value(b, 'requests_processing')).toBe(2);
    expect(delta(a, b, 'tokens_predicted_total')).toBe(0);
    expect(delta(a, b, 'tokens_predicted_seconds_total')).toBe(0);
    expect(delta(a, b, 'spec_decode_num_draft_tokens_total')).toBe(0);
    expect(delta(a, b, 'n_decode_total')).toBe(100);
    expect(delta(a, b, 'prompt_tokens_total')).toBe(1024);
    expect(delta(a, b, 'prompt_tokens_cached_total')).toBe(512);
    expect(delta(a, b, 'prompt_tokens_total') / delta(a, b, 'prompt_seconds_total')).toBeCloseTo(800, 6);
    expect(value(b, 'predicted_tokens_seconds')).toBe(0);   // windowed gauge reads 0 mid-generation
  });

  test('b10519 2 -> 3: completion lands whole; decode 45 tok/s from *_total, not 108 from the wall window', () => {
    const [a, b] = [scrape('b10519', 'metrics.scrape-2.txt'), scrape('b10519', 'metrics.scrape-3.txt')];
    const tokens = delta(a, b, 'tokens_predicted_total');
    const seconds = delta(a, b, 'tokens_predicted_seconds_total');
    expect(tokens).toBe(540);
    expect(seconds).toBeCloseTo(12, 6);
    expect(seconds).toBeGreaterThan(WINDOW_S);
    expect(tokens / seconds).toBeCloseTo(45, 6);
    expect(tokens / WINDOW_S).toBeCloseTo(108, 6);
    const drafted = delta(a, b, 'spec_decode_num_draft_tokens_total');
    const accepted = delta(a, b, 'spec_decode_num_accepted_tokens_total');
    const steps = delta(a, b, 'spec_decode_num_drafts_total');
    expect([drafted, accepted, steps]).toEqual([720, 300, 240]);
    expect(accepted / drafted).toBeCloseTo(0.416667, 5);
    expect(steps + accepted).toBe(tokens);
    expect(delta(a, b, 'prompt_tokens_total')).toBe(0);
  });

  test('b6700 1 -> 2: prompt counters move at first token (666.667 tok/s); prediction counters do not', () => {
    const [a, b] = [scrape('b6700', 'metrics.scrape-1.txt'), scrape('b6700', 'metrics.scrape-2.txt')];
    expect(value(b, 'requests_processing')).toBe(2);
    expect(delta(a, b, 'tokens_predicted_total')).toBe(0);
    expect(delta(a, b, 'n_decode_total')).toBe(160);
    expect(delta(a, b, 'prompt_tokens_total')).toBe(1024);
    expect(delta(a, b, 'prompt_tokens_total') / delta(a, b, 'prompt_seconds_total')).toBeCloseTo(666.667, 2);
  });

  test('b6700 2 -> 3: decode 32 tok/s from *_total deltas', () => {
    const [a, b] = [scrape('b6700', 'metrics.scrape-2.txt'), scrape('b6700', 'metrics.scrape-3.txt')];
    const tokens = delta(a, b, 'tokens_predicted_total');
    const seconds = delta(a, b, 'tokens_predicted_seconds_total');
    expect(tokens).toBe(540);
    expect(seconds).toBeCloseTo(16.875, 6);
    expect(tokens / seconds).toBeCloseTo(32, 6);
  });
});

// ------------------------------------------------------------------ privacy canaries
const CANARY = /CANARY-[A-Z]+-7f3a/g;
const PROPS_CANARIES = { 'CANARY-PATH-7f3a': 1, 'CANARY-TEMPLATE-7f3a': 1, '/Users/fixture': 1 };
const EXPECTED_CANARIES: Record<string, Record<string, number>> = {
  'b10519/props.normal.json': PROPS_CANARIES,
  'b10519/props.sleeping.json': PROPS_CANARIES,
  'b10519/props.no-metrics.json': PROPS_CANARIES,
  'b10519/slots.one-busy.json': { 'CANARY-PROMPT-7f3a': 2 },
  'b10519/slots.two-busy.json': { 'CANARY-PROMPT-7f3a': 3 },
  'b10519/slots.all-idle.json': { 'CANARY-PROMPT-7f3a': 3 },
  'b10519/slots.debug.json': { 'CANARY-PROMPT-7f3a': 4, 'CANARY-GENERATED-7f3a': 2, 'CANARY-STOP-7f3a': 2 },
  'b6700/props.normal.json': PROPS_CANARIES,
  'b6700/props.no-metrics.json': PROPS_CANARIES,
};

describe('llama-server privacy canaries', () => {
  test('each canary occurs exactly where SOURCE.md places it, and nowhere else', () => {
    const found: Record<string, Record<string, number>> = {};
    for (const version of VERSIONS) {
      for (const file of fixtureFiles(version)) {
        const raw = read(version, file);
        const counts: Record<string, number> = {};
        for (const match of [...raw.matchAll(CANARY), ...raw.matchAll(/\/Users\/fixture/g)]) counts[match[0]] = (counts[match[0]] ?? 0) + 1;
        if (Object.keys(counts).length) found[`${version}/${file}`] = counts;
      }
    }
    expect(found).toEqual(EXPECTED_CANARIES);
  });

  test('props: canaries sit in model_path directories and chat_template; the last path segment is clean', () => {
    for (const key of Object.keys(EXPECTED_CANARIES).filter(name => name.includes('/props.'))) {
      const [version, file] = key.split('/') as [Version, string];
      const props = json(version, file);
      expect(props.model_path.startsWith('/Users/fixture/')).toBe(true);
      const segments = props.model_path.split('/');
      expect(segments.at(-2)).toBe('CANARY-PATH-7f3a');
      expect(segments.at(-1)).toBe(MODEL_FILE);
      expect(segments.at(-1)).not.toMatch(CANARY);
      expect(props.chat_template).toContain('CANARY-TEMPLATE-7f3a');
    }
  });

  test('b10519 slots: generation_prompt is the canary on every slot with params', () => {
    for (const file of ['slots.one-busy.json', 'slots.two-busy.json', 'slots.all-idle.json', 'slots.debug.json']) {
      const withParams = json('b10519', file).filter((slot: J) => 'params' in slot);
      expect(withParams.length).toBeGreaterThan(0);
      for (const slot of withParams) expect(slot.params.generation_prompt).toBe('CANARY-PROMPT-7f3a');
    }
  });

  test('b10519 LLAMA_SERVER_SLOTS_DEBUG: prompt, generated and stop text are canaries', () => {
    for (const slot of json('b10519', 'slots.debug.json').filter((entry: J) => 'params' in entry)) {
      expect(slot.prompt).toContain('CANARY-PROMPT-7f3a');
      expect(slot.generated).toBe('CANARY-GENERATED-7f3a');
      expect(slot.params.stop).toEqual(['CANARY-STOP-7f3a']);
    }
  });

  test('b6700 slots and every metrics body carry no text canary', () => {
    for (const version of VERSIONS) {
      for (const file of fixtureFiles(version).filter(name => name.startsWith('metrics.') || (version === 'b6700' && name.startsWith('slots.')))) {
        expect(read(version, file)).not.toMatch(CANARY);
      }
    }
  });
});

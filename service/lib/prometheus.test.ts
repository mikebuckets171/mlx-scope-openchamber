import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LLAMA_METRICS } from '../adapters/llama-server.ts';
import { histogram, parsePrometheus, promNumber, PROMETHEUS_MAX_BYTES, PROMETHEUS_MAX_SAMPLES, sampleValue, type PromParse } from './prometheus.ts';

const FIXTURES = join(import.meta.dir, '../../tests/fixtures');
const FUZZ = join(FIXTURES, 'prometheus/fuzz');
const seed = (file: string) => readFileSync(join(FUZZ, file), 'utf8');
const all = { allow: () => true };
const pairs = (parse: PromParse) => parse.samples.map(({ name, labels, value }) => [name, labels, value] as const);
// Every /metrics body in the repository: the fuzz seeds, llama-server (both builds) and Splash 1.1.
const EXPOSITIONS = [
  ...readdirSync(FUZZ).filter(file => file.endsWith('.txt')).map(file => join(FUZZ, file)),
  ...['b10519', 'b6700'].flatMap(build => readdirSync(join(FIXTURES, 'llama-server', build)).filter(file => /^metrics\..*\.txt$/.test(file))
    .map(file => join(FIXTURES, 'llama-server', build, file))),
  join(FIXTURES, 'splash/1.1.0/metrics.ready-idle.txt'),
];

describe('Prometheus text 0.0.4', () => {
  test('label escapes, spacing and empty label sets', () => {
    const parse = parsePrometheus(seed('escapes.txt'), all);
    expect(pairs(parse)).toEqual([
      ['fx_escaped_total', { quote: 'say "hi"', slash: 'a\\b', newline: 'one\ntwo', other: 'keep \\t literal' }, 3],
      ['fx_escaped_total', { comma: 'a,b', brace: 'x}y{z', equals: 'k=v' }, 4],
      ['fx_escaped_total', { spaced: 'yes', trailing: 'comma' }, 5],
      ['fx_escaped_total', { gap: 'before brace' }, 6],
      ['fx_escaped_total', {}, 7],
    ]);
    expect([...parse.types]).toEqual([['fx_escaped_total', 'counter']]);
    expect(parse.truncated).toBe(false);
  });

  test('values as Go reads them: NaN and ±Inf kept, JavaScript-only forms rejected', () => {
    const parse = parsePrometheus(seed('values.txt'), all);
    const values = Object.fromEntries(parse.samples.map(sample => [sample.labels.v, sample.value]));
    expect(Object.keys(values)).toEqual(['nan', 'pinf', 'ninf', 'inf', 'exp', 'negzero', 'leading-dot', 'trailing-dot', 'timestamp', 'negative-timestamp']);
    expect(values.nan).toBeNaN();
    expect([values.pinf, values.ninf, values.inf, values.exp, values['leading-dot'], values['trailing-dot'], values.timestamp])
      .toEqual([Infinity, -Infinity, Infinity, 3_214_570, 0.5, 5, 42]);
    expect(Object.is(values.negzero, -0)).toBe(true);
    for (const token of ['0x10', '', ' ', 'Infinity-and-beyond', '1_000', '1e', 'e5', '--1', 'nan1', '0b1']) expect(promNumber(token), token).toBeNull();
    // Not finite is not a reading.
    expect(sampleValue(parse, 'fx_value', { v: 'nan' })).toBeNull();
    expect(sampleValue(parse, 'fx_value', { v: 'pinf' })).toBeNull();
    expect(sampleValue(parse, 'fx_value', { v: 'exp' })).toBe(3_214_570);
    expect(sampleValue(parse, 'fx_value', { v: 'absent' })).toBeNull();
  });

  test('malformed lines are skipped one by one; the first TYPE wins', () => {
    const parse = parsePrometheus(seed('malformed.txt'), all);
    expect(pairs(parse)).toEqual([['fx_malformed_ok', {}, 8], ['fx_malformed_ok', {}, 9]]);
    expect([...parse.types]).toEqual([['fx_malformed_ok', 'gauge']]);
  });

  test('tabs, blanks, CRLF and a missing final newline', () => {
    for (const text of [seed('whitespace.txt'), seed('whitespace.txt').replaceAll('\n', '\r\n')]) {
      expect(pairs(parsePrometheus(text, all))).toEqual([['fx_space_total', {}, 1], ['fx_space_total', { tab: 'yes' }, 2], ['fx_space_total', { indent: 'yes' }, 3]]);
    }
    expect(pairs(parsePrometheus(seed('no-trailing-newline.txt'), all))).toEqual([['fx_no_newline_total', {}, 1], ['fx_no_newline_total', { last: 'line' }, 2]]);
  });

  test('histograms: ordered by le, one label set, null when incomplete', () => {
    const parse = parsePrometheus(seed('histogram.txt'), all);
    expect(histogram(parse, 'fx_latency_seconds')).toEqual({ buckets: [[0.1, 3], [0.5, 7], [1, 9], [Infinity, 9]], sum: 2.75, count: 9 });
    expect(histogram(parse, 'fx_broken_seconds')).toBeNull();   // not cumulative
    expect(histogram(parse, 'fx_open_seconds')).toBeNull();     // no +Inf bucket
    expect(histogram(parse, 'fx_rpc_seconds')).toBeNull();      // a summary
    expect(histogram(parse, 'fx_absent_seconds')).toBeNull();
    expect(sampleValue(parse, 'fx_rpc_seconds', { quantile: '0.99' })).toBe(0.2);
    expect(parse.types.get('fx_rpc_seconds')).toBe('summary');
    const splash = parsePrometheus(readFileSync(join(FIXTURES, 'splash/1.1.0/metrics.ready-idle.txt'), 'utf8'), all);
    const ttft = histogram(splash, 'splash_ttft_seconds')!;
    expect([ttft.count, ttft.sum, ttft.buckets.length, ttft.buckets.at(-1)]).toEqual([54, 702.2493940821583, 19, [Infinity, 54]]);
    expect([...splash.types.values()].filter(kind => kind === 'histogram')).toHaveLength(11);
  });

  test('the allowlist: a family\'s _bucket/_sum/_count follow its base name, nothing else is kept', () => {
    const allow = (name: string) => name === 'fx_latency_seconds';
    const parse = parsePrometheus(seed('histogram.txt'), { allow });
    expect(new Set(parse.samples.map(sample => sample.name))).toEqual(new Set(['fx_latency_seconds_bucket', 'fx_latency_seconds_sum', 'fx_latency_seconds_count']));
    expect([...parse.types]).toEqual([['fx_latency_seconds', 'histogram']]);
    expect(histogram(parse, 'fx_latency_seconds')?.count).toBe(9);
  });

  test('llama-server scrapes: exponent counters, labelled per-position series, and the windowed gauges left out', () => {
    const text = readFileSync(join(FIXTURES, 'llama-server/b10519/metrics.large-counters.txt'), 'utf8');
    const every = parsePrometheus(text, all);
    expect(every.samples).toHaveLength(text.split('\n').filter(line => line && !line.startsWith('#')).length);
    expect(sampleValue(every, 'llamacpp:prompt_tokens_total')).toBe(3_214_570);
    expect(sampleValue(every, 'llamacpp:spec_decode_num_accepted_tokens_per_pos_total', { position: '1' })).toBe(305_162);
    expect(every.types.get('llamacpp:n_busy_slots_per_decode')).toBe('gauge');
    const kept = parsePrometheus(text, { allow: name => LLAMA_METRICS.has(name) });
    expect(new Set(kept.samples.map(sample => sample.name))).toEqual(new Set(LLAMA_METRICS));
    expect(kept.samples.some(sample => /_tokens_seconds$/.test(sample.name))).toBe(false);
    expect(sampleValue(kept, 'llamacpp:requests_deferred')).toBe(2);
  });

  test('the byte bound is UTF-8 and keeps whole lines; the sample bound stops the parse', () => {
    const text = seed('unicode.txt');
    const cut = Buffer.byteLength(text.split('\n').slice(0, 2).join('\n')) + 5;   // inside the third line
    const parse = parsePrometheus(text, { ...all, maxBytes: cut });
    expect([parse.truncated, parse.samples.map(sample => sample.labels.name)]).toEqual([true, ['日本語のラベル']]);
    expect(parsePrometheus(text, all).samples).toHaveLength(3);
    const many = Array.from({ length: PROMETHEUS_MAX_SAMPLES + 50 }, (_, index) => `fx_many{i="${index}"} ${index}`).join('\n');
    const bounded = parsePrometheus(many, all);
    expect([bounded.samples.length, bounded.truncated, bounded.samples.at(-1)?.value]).toEqual([PROMETHEUS_MAX_SAMPLES, true, PROMETHEUS_MAX_SAMPLES - 1]);
    // Disallowed names never count toward the bound.
    expect(parsePrometheus(many, { allow: () => false })).toEqual({ samples: [], types: new Map(), truncated: false });
    const huge = `fx_first 1\n${'x'.repeat(PROMETHEUS_MAX_BYTES)}\nfx_after 2\n`;
    expect(pairs(parsePrometheus(huge, all))).toEqual([['fx_first', {}, 1]]);
  });
});

// A small deterministic generator (mulberry32): the same seed always makes the same corpus.
const random = (seedValue: number) => () => {
  let t = (seedValue += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
};
const ALPHABET = ['{', '}', '"', '\\', ',', '=', ' ', '\t', '\n', '\r', '#', 'e', '+', '-', '.', 'I', 'n', 'f', 'N', 'a', '0', '9', 'é', '🦙', 'le', '_bucket'];
const mutate = (text: string, next: () => number): string => {
  const pick = (max: number) => Math.floor(next() * max);
  let out = text;
  for (let step = 0, steps = 1 + pick(8); step < steps; step += 1) {
    const at = pick(out.length + 1);
    switch (pick(7)) {
      case 0: out = out.slice(0, at) + ALPHABET[pick(ALPHABET.length)] + out.slice(at); break;
      case 1: out = out.slice(0, at) + out.slice(at + 1 + pick(20)); break;
      case 2: out = out.slice(0, at) + out.slice(at, at + pick(200)).repeat(1 + pick(4)) + out.slice(at); break;
      case 3: { const lines = out.split('\n'); lines.sort(() => next() - 0.5); out = lines.join('\n'); break; }
      case 4: out = out.replaceAll('\n', '\r\n'); break;
      case 5: out = out.slice(0, at); break;
      default: out = out.slice(0, at) + String.fromCharCode(pick(0x3000)) + out.slice(at + 1);
    }
  }
  return out;
};
const valid = (parse: PromParse, allow: (name: string) => boolean, maxSamples = PROMETHEUS_MAX_SAMPLES): void => {
  expect(parse.samples.length).toBeLessThanOrEqual(maxSamples);
  for (const sample of parse.samples) {
    expect(allow(sample.name) || allow(sample.name.replace(/_(?:bucket|sum|count)$/, ''))).toBe(true);
    expect(typeof sample.value).toBe('number');
    expect(/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(sample.name)).toBe(true);
    for (const [key, value] of Object.entries(sample.labels)) {
      expect(/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)).toBe(true);
      expect(typeof value).toBe('string');
    }
  }
  for (const [name, kind] of parse.types) expect([allow(name), ['counter', 'gauge', 'histogram', 'summary', 'untyped'].includes(kind)]).toEqual([true, true]);
};

describe('fuzz', () => {
  test('seeded mutations of every exposition in the repository never throw and hold every bound', () => {
    const next = random(0x7f3a);
    const allows = [() => true, (name: string) => LLAMA_METRICS.has(name), (name: string) => name.startsWith('fx_') || name.startsWith('splash_ttft')];
    let runs = 0;
    for (const file of EXPOSITIONS) {
      const text = readFileSync(file, 'utf8');
      for (let round = 0; round < 150; round += 1) {
        const allow = allows[round % allows.length]!, input = mutate(text, next), maxSamples = 1 + Math.floor(next() * 40);
        valid(parsePrometheus(input, { allow }), allow);
        valid(parsePrometheus(input, { allow, maxSamples, maxBytes: 1 + Math.floor(next() * 600) }), allow, maxSamples);
        runs += 1;
      }
    }
    expect(runs).toBe(EXPOSITIONS.length * 150);
  });

  test('random bytes and pathological shapes stay linear', () => {
    const next = random(42);
    for (let round = 0; round < 300; round += 1) {
      const length = Math.floor(next() * 400);
      const input = Array.from({ length }, () => next() < 0.7 ? ALPHABET[Math.floor(next() * ALPHABET.length)] : String.fromCharCode(Math.floor(next() * 128))).join('');
      valid(parsePrometheus(input, all), () => true);
    }
    const shapes = [
      `fx_long{a="${'x'.repeat(PROMETHEUS_MAX_BYTES - 64)}"} 1\n`,                             // one line near the bound
      'fx_tiny 1\n'.repeat(100_000),                                                             // many tiny lines
      `fx_labels{${Array.from({ length: 5_000 }, (_, index) => `l${index}="v"`).join(',')}} 1\n`,  // far past the label cap
      `fx_escape{a="${'\\'.repeat(400_000)}"} 1\n`,                                              // escapes all the way
      '{'.repeat(1_000_000), '#'.repeat(1_000_000), `# TYPE ${'x'.repeat(1_000_000)} counter\n`,
    ];
    for (const input of shapes) {
      const started = performance.now(), parse = parsePrometheus(input, all);
      valid(parse, () => true);
      expect(performance.now() - started, input.slice(0, 20)).toBeLessThan(1_500);
    }
    expect(parsePrometheus('fx_tiny 1\n'.repeat(100_000), all)).toMatchObject({ truncated: true });
    expect(parsePrometheus(shapes[2]!, all).samples).toEqual([]);
  });
});

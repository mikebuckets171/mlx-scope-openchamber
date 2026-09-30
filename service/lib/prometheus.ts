// Owner: ad-llama-ollama. Prometheus text 0.0.4 (plan §5.3): bounded, name-allowlisted; label values never reach the wire.

export const PROMETHEUS_MAX_BYTES = 2 * 1024 * 1024;
export const PROMETHEUS_MAX_SAMPLES = 5_000;
export type PromType = 'counter' | 'gauge' | 'histogram' | 'summary' | 'untyped';
export interface PromSample { name: string; labels: Readonly<Record<string, string>>; value: number }   // NaN and ±Inf kept as numbers
export interface PromParse { samples: PromSample[]; types: ReadonlyMap<string, PromType>; truncated: boolean }
export interface PromOptions { allow: (name: string) => boolean; maxBytes?: number; maxSamples?: number }
export interface PromHistogram { buckets: Array<[le: number, count: number]>; sum: number; count: number }

const TYPES: readonly PromType[] = ['counter', 'gauge', 'histogram', 'summary', 'untyped'];
const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*/;
const FAMILY_SUFFIX = /_(?:bucket|sum|count)$/;
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const TIMESTAMP = /^-?\d{1,19}$/;
const MAX_LABELS = 32;

/** Go's ParseFloat as the exposition format uses it: decimal, exponent, NaN and ±Inf; nothing JavaScript adds (hex, ""). */
export const promNumber = (token: string): number | null => {
  if (DECIMAL.test(token)) return Number(token);
  const word = token.toLowerCase();
  if (word === 'nan') return Number.NaN;
  if (word === 'inf' || word === '+inf' || word === '+infinity' || word === 'infinity') return Number.POSITIVE_INFINITY;
  return word === '-inf' || word === '-infinity' ? Number.NEGATIVE_INFINITY : null;
};

/** `{a="x",b="y\"z"}` from `start` (the brace); the labels and the index after `}`, or null when malformed. */
const readLabels = (line: string, start: number): { labels: Record<string, string>; end: number } | null => {
  const labels: Record<string, string> = Object.create(null);
  let index = start + 1, size = 0;
  for (;;) {
    while (line[index] === ' ' || line[index] === '\t') index += 1;
    if (line[index] === '}') return { labels, end: index + 1 };
    const name = LABEL_NAME.exec(line.slice(index, index + 256))?.[0];
    if (!name || Object.hasOwn(labels, name) || ++size > MAX_LABELS) return null;
    index += name.length;
    while (line[index] === ' ' || line[index] === '\t') index += 1;
    if (line[index] !== '=') return null;
    index += 1;
    while (line[index] === ' ' || line[index] === '\t') index += 1;
    if (line[index] !== '"') return null;
    let value = '';
    for (index += 1; ; index += 1) {
      const char = line[index];
      if (char === undefined) return null;
      if (char === '"') break;
      if (char !== '\\') { value += char; continue; }
      const next = line[++index];
      if (next === undefined) return null;
      // 0.0.4 escapes are \\, \" and \n; any other backslash stays literal.
      value += next === 'n' ? '\n' : next === '\\' || next === '"' ? next : `\\${next}`;
    }
    labels[name] = value;
    index += 1;
    while (line[index] === ' ' || line[index] === '\t') index += 1;
    if (line[index] === ',') { index += 1; continue; }
    if (line[index] !== '}') return null;
  }
};

/** A family's `_bucket`/`_sum`/`_count` follow its base name through the allowlist. */
const allowed = (name: string, allow: (name: string) => boolean): boolean =>
  allow(name) || FAMILY_SUFFIX.test(name) && allow(name.replace(FAMILY_SUFFIX, ''));

/**
 * Parses exposition text, keeping only allowlisted names (a family's `_bucket`/`_sum`/`_count` follow its base name).
 * Lenient per line: a malformed line is skipped, never fatal. Past `maxBytes` (UTF-8) only the whole lines before the
 * bound are read, and parsing stops at `maxSamples` kept samples; either sets `truncated`.
 */
export const parsePrometheus = (text: string, options: PromOptions): PromParse => {
  const maxBytes = options.maxBytes ?? PROMETHEUS_MAX_BYTES, maxSamples = options.maxSamples ?? PROMETHEUS_MAX_SAMPLES;
  const types = new Map<string, PromType>(), samples: PromSample[] = [];
  let body = typeof text === 'string' ? text : '', truncated = false;
  if (Buffer.byteLength(body, 'utf8') > maxBytes) {
    const head = Buffer.from(body, 'utf8').subarray(0, maxBytes).toString('utf8');
    body = head.slice(0, Math.max(0, head.lastIndexOf('\n')));
    truncated = true;
  }
  for (const raw of body.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const trimmed = line.trimStart();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) {
      const [hash, keyword, name, kind, extra] = trimmed.split(/[ \t]+/);
      if (hash === '#' && keyword === 'TYPE' && name && NAME.exec(name)?.[0] === name && extra === undefined
        && TYPES.includes(kind as PromType) && !types.has(name) && allowed(name, options.allow)) types.set(name, kind as PromType);
      continue;
    }
    const name = NAME.exec(trimmed)?.[0];
    if (!name || !allowed(name, options.allow)) continue;
    let rest = trimmed.slice(name.length), labels: Record<string, string> = {};
    const start = rest.search(/\S/);
    // A name glued to anything but `{` (`foo.bar 1`, `foo-1`) is not a sample.
    if (start < 0 || start === 0 && rest[0] !== '{') continue;
    if (rest[start] === '{') {
      const read = readLabels(rest, start);
      if (!read) continue;
      labels = { ...read.labels };
      rest = rest.slice(read.end);
    }
    const tokens = rest.trim().split(/[ \t]+/);
    if (tokens.length > 2 || tokens.length === 2 && !TIMESTAMP.test(tokens[1]!)) continue;
    const value = promNumber(tokens[0]!);
    if (value === null) continue;
    if (samples.length >= maxSamples) { truncated = true; break; }
    samples.push({ name, labels, value });
  }
  return { samples, types, truncated };
};

const includes = (labels: Readonly<Record<string, string>>, want: Readonly<Record<string, string>>): boolean =>
  Object.entries(want).every(([key, value]) => Object.hasOwn(labels, key) && labels[key] === value);

/** The first sample with this name whose labels include `labels`; null when absent or not finite. */
export const sampleValue = (parse: PromParse, name: string, labels: Readonly<Record<string, string>> = {}): number | null => {
  const sample = parse.samples.find(item => item.name === name && includes(item.labels, labels));
  return sample && Number.isFinite(sample.value) ? sample.value : null;
};

const signature = (labels: Readonly<Record<string, string>>, skip: string): string =>
  JSON.stringify(Object.entries(labels).filter(([key]) => key !== skip).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));

/**
 * A histogram family by base name, buckets ordered by `le`; null when incomplete. With several label sets, the first
 * bucket's set is used. Complete means: a `+Inf` bucket equal to `_count`, cumulative counts, finite `_sum`.
 */
export const histogram = (parse: PromParse, name: string): PromHistogram | null => {
  const first = parse.samples.find(item => item.name === `${name}_bucket` && Object.hasOwn(item.labels, 'le'));
  if (!first) return null;
  const set = signature(first.labels, 'le');
  const buckets = new Map<number, number>();
  for (const item of parse.samples) {
    if (item.name !== `${name}_bucket` || signature(item.labels, 'le') !== set) continue;
    const le = promNumber(item.labels.le ?? '');
    if (le === null || Number.isNaN(le) || !Number.isFinite(item.value) || item.value < 0 || buckets.has(le)) return null;
    buckets.set(le, item.value);
  }
  const series = (suffix: string) => parse.samples.find(item => item.name === `${name}${suffix}` && signature(item.labels, '') === set);
  const sum = series('_sum')?.value, count = series('_count')?.value;
  const ordered = [...buckets].sort(([a], [b]) => a - b);
  if (sum === undefined || count === undefined || !Number.isFinite(sum) || !Number.isFinite(count) || count < 0) return null;
  if (ordered.at(-1)?.[0] !== Number.POSITIVE_INFINITY || ordered.at(-1)?.[1] !== count) return null;
  if (ordered.some(([, value], index) => index > 0 && value < ordered[index - 1]![1])) return null;
  return { buckets: ordered, sum, count };
};

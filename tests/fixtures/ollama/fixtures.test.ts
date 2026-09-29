// Guards the Ollama fixture corpus: every body parses, matches the api/types.go shapes at v0.40.0-rc0 (field names,
// types and Go struct order), is byte-for-byte what gin's json.Marshal writes, and carries each planted privacy canary
// exactly where SOURCE.md says. The adapter tests (Stage 4) load these files and prove the canaries never leak.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dir, '0.40.0');
const files = readdirSync(DIR).filter(name => name !== 'SOURCE.md').sort();
const text = (file: string) => readFileSync(join(DIR, file), 'utf8');
const json = (file: string): any => JSON.parse(text(file));
const source = readFileSync(join(DIR, 'SOURCE.md'), 'utf8');

const DIGEST = /^[0-9a-f]{64}$/;
// Go time.Time MarshalJSON: RFC 3339, optional fraction with trailing zeros trimmed, Z or ±hh:mm.
const GO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d*[1-9])?(Z|[+-]\d{2}:\d{2})$/;
const RUNNERS = ['ggml', 'llamacpp', 'mlx'];
const CAPABILITIES = ['completion', 'tools', 'insert', 'vision', 'embedding', 'thinking', 'image', 'audio'];
const PS_KEYS = ['name', 'model', 'size', 'digest', 'details', 'expires_at', 'size_vram', 'context_length', 'runner'];
const TAG_KEYS = ['name', 'model', 'remote_model', 'remote_host', 'modified_at', 'size', 'digest', 'details', 'capabilities'];
const DETAIL_KEYS = ['parent_model', 'format', 'family', 'families', 'parameter_size', 'quantization_level', 'context_length', 'embedding_length', 'runner'];
const DETAIL_REQUIRED = DETAIL_KEYS.slice(0, 6);
// Synthetic names only: example-*, publisher/Example-*, hf.co/publisher/*, or a labelled canary.
const SYNTHETIC_NAME = /^(hf\.co\/publisher\/Example-[\w.-]+|publisher\/(Example-[\w.-]+|CANARY-MODEL-7f3a)|example-[\w.-]+):[\w.-]+$/;

/** Keys must be a subsequence of Go's struct order (omitempty fields may be absent, never reordered). */
function expectGoOrder(value: Record<string, unknown>, order: string[], required: string[]) {
  const keys = Object.keys(value);
  for (const key of required) expect(keys).toContain(key);
  for (const key of keys) expect(order).toContain(key);
  expect(keys).toEqual(order.filter(key => keys.includes(key)));
}

function expectDetails(details: any, route: 'ps' | 'tags') {
  expect(typeof details).toBe('object');
  expectGoOrder(details, DETAIL_KEYS, DETAIL_REQUIRED);
  for (const key of ['parent_model', 'format', 'family', 'parameter_size', 'quantization_level']) expect(typeof details[key]).toBe('string');
  expect(details.families === null || (Array.isArray(details.families) && details.families.every((f: unknown) => typeof f === 'string'))).toBe(true);
  if (route === 'ps') {
    // PsHandler builds details from the config only (server/routes.go:2454-2460).
    expect(details.parent_model).toBe('');
    expect(details).not.toHaveProperty('context_length');
    expect(details).not.toHaveProperty('embedding_length');
    expect(details).not.toHaveProperty('runner');
  } else {
    if ('context_length' in details) expect(Number.isSafeInteger(details.context_length) && details.context_length > 0).toBe(true);
    if ('embedding_length' in details) expect(Number.isSafeInteger(details.embedding_length) && details.embedding_length > 0).toBe(true);
    if ('runner' in details) expect(RUNNERS).toContain(details.runner);
  }
}

function expectPsRow(row: any) {
  expectGoOrder(row, PS_KEYS, PS_KEYS.slice(0, 8));
  expect(typeof row.name).toBe('string');
  expect(row.model).toBe(row.name);
  expect(row.name).toMatch(SYNTHETIC_NAME);
  expect(Number.isSafeInteger(row.size) && row.size > 0).toBe(true);
  expect(Number.isSafeInteger(row.size_vram) && row.size_vram >= 0).toBe(true);
  expect(row.size_vram).toBeLessThanOrEqual(row.size);
  expect(Number.isSafeInteger(row.context_length) && row.context_length > 0).toBe(true);
  expect(row.digest).toMatch(DIGEST);
  expect(row.expires_at).toMatch(GO_TIME);
  expect(Number.isNaN(Date.parse(row.expires_at))).toBe(false);
  if ('runner' in row) expect(RUNNERS).toContain(row.runner);
  // The MLX runner reports the same value for both sizes (mlxrunner/client.go:536-539).
  if (row.runner === 'mlx') expect(row.size_vram).toBe(row.size);
  expectDetails(row.details, 'ps');
}

function expectTagRow(row: any) {
  expectGoOrder(row, TAG_KEYS, ['name', 'model', 'modified_at', 'size', 'digest', 'details']);
  expect(row.model).toBe(row.name);
  expect(row.name).toMatch(SYNTHETIC_NAME);
  expect(row.modified_at).toMatch(GO_TIME);
  expect(Number.isSafeInteger(row.size) && row.size > 0).toBe(true);
  expect(row.digest).toMatch(DIGEST);
  if ('capabilities' in row) {
    expect(row.capabilities.length).toBeGreaterThan(0);
    for (const capability of row.capabilities) expect(CAPABILITIES).toContain(capability);
  }
  if ('remote_host' in row) expect(typeof row.remote_model).toBe('string');
  expectDetails(row.details, 'tags');
}

const psFiles = files.filter(f => f.startsWith('api-ps.'));
const tagFiles = files.filter(f => f.startsWith('api-tags.') && f !== 'api-tags.error-500.json');
const versionFiles = files.filter(f => f.startsWith('api-version.'));

describe('corpus', () => {
  test('has the expected variants, named <route>.<variant>.json', () => {
    expect(files).toEqual([
      'api-ps.canary.json', 'api-ps.cpu-only.json', 'api-ps.keep-alive-forever.json', 'api-ps.none.json',
      'api-ps.one-model.json', 'api-ps.partial-offload.json', 'api-ps.two-models.json',
      'api-tags.canary.json', 'api-tags.empty.json', 'api-tags.error-500.json', 'api-tags.manifest-list.json', 'api-tags.small.json',
      'api-version.default.json', 'api-version.rc.json', 'api-version.source-build.json',
    ]);
    for (const file of files) expect(file).toMatch(/^api-(ps|tags|version)\.[a-z0-9-]+\.json$/);
  });

  test('every file has a provenance row in SOURCE.md', () => {
    for (const file of files) expect(source).toContain(`| \`${file}\` |`);
    expect(source).toContain('v0.40.0-rc0');
    expect(source).toContain('75b952780f90807f651eb2f1f817e5a40126e81d');
    expect(source).toContain('GPU-resident (Ollama-reported)');
  });

  test.each(files)('%s parses and is exactly what gin json.Marshal writes (compact, no trailing newline)', file => {
    const body = text(file);
    const parsed = JSON.parse(body);
    expect(JSON.stringify(parsed)).toBe(body);
    expect(body.endsWith('\n')).toBe(false);
  });

  test('no private data beyond the labelled canaries', () => {
    for (const file of files) {
      const body = text(file);
      for (const match of body.matchAll(/\/Users\/[A-Za-z0-9._-]+/g)) expect(match[0]).toBe('/Users/fixture');
      expect(body).not.toMatch(/"pid"|Bearer |\bsk-[A-Za-z0-9]{8,}|api_key|CANARY-PROMPT/);
    }
  });
});

describe('/api/version', () => {
  test.each(versionFiles)('%s is {version: string}', file => {
    const body = json(file);
    expect(Object.keys(body)).toEqual(['version']);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });
  test('variants cover release, pre-release and the source-build default', () => {
    expect(json('api-version.default.json').version).toBe('0.40.0');
    expect(json('api-version.rc.json').version).toBe('0.40.0-rc0');
    expect(json('api-version.source-build.json').version).toBe('0.0.0');
  });
});

describe('/api/ps', () => {
  test.each(psFiles)('%s matches ProcessResponse and is sorted by expires_at, latest first', file => {
    const body = json(file);
    expect(Object.keys(body)).toEqual(['models']);
    expect(Array.isArray(body.models)).toBe(true);
    body.models.forEach(expectPsRow);
    const expiries = body.models.map((row: any) => Date.parse(row.expires_at));
    expect(expiries).toEqual([...expiries].sort((a, b) => b - a));
  });

  test('none is an empty array, never null', () => {
    expect(text('api-ps.none.json')).toBe('{"models":[]}');
  });
  test('one-model is fully GPU-resident', () => {
    const { models } = json('api-ps.one-model.json');
    expect(models).toHaveLength(1);
    expect(models[0].size_vram).toBe(models[0].size);
    expect(models[0].details.format).toBe('gguf');
  });
  test('two-models holds an MLX and a GGUF row', () => {
    const { models } = json('api-ps.two-models.json');
    expect(models).toHaveLength(2);
    expect(models.map((m: any) => m.runner)).toEqual(['mlx', 'ggml']);
    expect(models[0].details.families).toBeNull();
    expect(models[0].details.family).toBe('');
    expect(new Set(models.map((m: any) => m.name)).size).toBe(2);
  });
  test('cpu-only reports zero GPU-resident bytes', () => {
    const { models } = json('api-ps.cpu-only.json');
    expect(models).toHaveLength(1);
    expect(models[0].size_vram).toBe(0);
    expect(models[0].size).toBeGreaterThan(0);
    expect(models[0].expires_at.endsWith('Z')).toBe(true);
  });
  test('partial-offload is strictly between 0 and size', () => {
    const [row] = json('api-ps.partial-offload.json').models;
    expect(row.size_vram).toBeGreaterThan(0);
    expect(row.size_vram).toBeLessThan(row.size);
  });
  test('keep-alive-forever expires about 292 years out (now + MaxInt64 ns)', () => {
    const [row] = json('api-ps.keep-alive-forever.json').models;
    expect(row.expires_at).toBe('2319-01-09T12:49:29.273080807-08:00');
    expect(new Date(row.expires_at).getUTCFullYear()).toBeGreaterThan(2300);
  });
});

describe('/api/tags', () => {
  test.each(tagFiles)('%s matches ListResponse and is sorted by modified_at, name, digest', file => {
    const body = json(file);
    expect(Object.keys(body)).toEqual(['models']);
    body.models.forEach(expectTagRow);
    const keyed = body.models.map((row: any) => [Date.parse(row.modified_at), row.name, row.digest] as const);
    const sorted = [...keyed].sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) || (a[2] < b[2] ? -1 : 1));
    expect(keyed).toEqual(sorted);
  });

  test('empty is an empty array', () => {
    expect(text('api-tags.empty.json')).toBe('{"models":[]}');
  });
  test('small is a short local inventory with chat and embedding models across runners', () => {
    const { models } = json('api-tags.small.json');
    expect(models.length).toBeGreaterThanOrEqual(2);
    expect(models.length).toBeLessThanOrEqual(5);
    expect(models.some((m: any) => m.capabilities?.includes('embedding'))).toBe(true);
    expect(new Set(models.map((m: any) => m.details.runner))).toEqual(new Set(['mlx', 'ggml']));
    for (const row of models) {
      expect(row).not.toHaveProperty('remote_host');
      expect(row.details.parent_model).toBe('');
    }
  });
  test('manifest-list repeats one name with a row per runner', () => {
    const { models } = json('api-tags.manifest-list.json');
    expect(models).toHaveLength(2);
    expect(new Set(models.map((m: any) => m.name)).size).toBe(1);
    expect(new Set(models.map((m: any) => m.digest)).size).toBe(2);
    expect(new Set(models.map((m: any) => m.modified_at)).size).toBe(1);
    expect(models.map((m: any) => m.details.runner).sort()).toEqual(['ggml', 'mlx']);
  });
  test('error-500 is the ListHandler {error} body', () => {
    const body = json('api-tags.error-500.json');
    expect(Object.keys(body)).toEqual(['error']);
    expect(typeof body.error).toBe('string');
  });
});

describe('privacy canaries', () => {
  const get = (value: any, path: Array<string | number>) => path.reduce((node, key) => node?.[key], value);
  const PLANTED: Array<{ file: string; path: Array<string | number>; canary: string; cls: 'A' | 'B' }> = [
    { file: 'api-ps.canary.json', path: ['models', 0, 'name'], canary: 'CANARY-MODEL-7f3a', cls: 'B' },
    { file: 'api-ps.canary.json', path: ['models', 0, 'model'], canary: 'CANARY-MODEL-7f3a', cls: 'B' },
    { file: 'api-tags.canary.json', path: ['models', 0, 'name'], canary: 'CANARY-MODEL-7f3a', cls: 'B' },
    { file: 'api-tags.canary.json', path: ['models', 0, 'model'], canary: 'CANARY-MODEL-7f3a', cls: 'B' },
    { file: 'api-tags.canary.json', path: ['models', 0, 'details', 'parent_model'], canary: 'CANARY-PATH-7f3a', cls: 'A' },
    { file: 'api-tags.canary.json', path: ['models', 1, 'remote_host'], canary: 'CANARY-HOST-7f3a', cls: 'A' },
    { file: 'api-tags.error-500.json', path: ['error'], canary: 'CANARY-PATH-7f3a', cls: 'A' },
    { file: 'api-tags.error-500.json', path: ['error'], canary: '/Users/fixture', cls: 'A' },
  ];

  test.each(PLANTED)('$file $path carries $canary (class $cls)', ({ file, path, canary }) => {
    const value = get(json(file), path);
    expect(typeof value).toBe('string');
    expect(value).toContain(canary);
  });

  test('every CANARY-*-7f3a occurrence is a planted, documented one', () => {
    const planted = new Set(PLANTED.map(p => `${p.file}#${p.path.join('.')}`));
    const found: string[] = [];
    const walk = (file: string, node: unknown, path: Array<string | number>) => {
      if (typeof node === 'string') { if (/CANARY-[A-Z]+-7f3a/.test(node)) found.push(`${file}#${path.join('.')}`); return; }
      if (node && typeof node === 'object') for (const [key, child] of Object.entries(node)) walk(file, child, [...path, Array.isArray(node) ? Number(key) : key]);
    };
    for (const file of files) walk(file, json(file), []);
    expect(found.length).toBeGreaterThan(0);
    for (const hit of found) expect(planted.has(hit)).toBe(true);
    for (const { file, canary } of PLANTED) {
      expect(source).toContain(`\`${file}\``);
      expect(source).toContain(canary);
    }
  });

  test('realistic (non-canary) variants carry no canary', () => {
    for (const file of files.filter(f => !f.includes('.canary.') && f !== 'api-tags.error-500.json')) {
      expect(text(file)).not.toMatch(/CANARY|\/Users\//);
    }
  });
});

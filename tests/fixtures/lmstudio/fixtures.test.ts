// Structural checks for the LM Studio / Bionic fixture corpus. These tests read the fixtures only; adapter behaviour
// (what is kept, what is dropped, what reaches the wire) is proven by the adapter tests that consume this corpus.
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dir;
const BIONIC = path.join(ROOT, 'bionic-1.1.6');
const STOCK = path.join(ROOT, 'lmstudio-0.4.25');
const read = (name: string): string => readFileSync(path.join(BIONIC, name), 'utf8');
const json = <T = unknown>(name: string): T => JSON.parse(read(name)) as T;
type Row = Record<string, unknown>;

const CANARY = /CANARY-[A-Z-]+-7f3a/g;
const PROMPT_CANARY = 'CANARY-PROMPT-7f3a';
const OUTPUT_CANARY = 'CANARY-OUTPUT-7f3a';
/** service/lmstudio-activity.ts MAX_LOG_LINE_BYTES: longer lms log records are discarded unread. */
const MAX_LOG_LINE_BYTES = 16 * 1024;
const LOADED_ID = 'publisher/example-27b-splash';
const LOADED_BYTES = 18_683_107_738;

const fixtureFiles = readdirSync(BIONIC).filter(name => name !== 'SOURCE.md').sort();
const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const keysOf = (value: unknown): string[] => Object.keys(value as Row);

describe('corpus layout and provenance', () => {
  test('every file follows <route-or-command>.<variant>.<ext> and SOURCE.md accounts for each one', () => {
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(17);
    const source = read('SOURCE.md');
    for (const name of fixtureFiles) {
      expect(name).toMatch(/^[a-z0-9-]+\.[a-z0-9-]+\.(json|txt)$/);
      expect(source).toContain(`\`${name}\``);
    }
    const listed = [...source.matchAll(/`([a-z0-9-]+\.[a-z0-9-]+\.(?:json|txt))`/g)].map(match => match[1]);
    for (const name of listed) expect(fixtureFiles).toContain(name);
    expect(source).toMatch(/Bionic 1\.1\.6/);
  });

  test('the LM Studio 0.4.25 folder holds notes only', () => {
    expect(readdirSync(STOCK)).toEqual(['SOURCE.md']);
    expect(readFileSync(path.join(STOCK, 'SOURCE.md'), 'utf8')).toMatch(/0\.4\.25/);
  });

  test('no private data: synthetic ids, no home paths, PIDs, keys, UUIDs or ANSI colour', () => {
    const notes = [read('SOURCE.md'), readFileSync(path.join(STOCK, 'SOURCE.md'), 'utf8')];
    for (const text of [...fixtureFiles.map(read), ...notes]) {
      expect(text).not.toMatch(/\/Users\/(?!fixture\b)|\/home\/|~\//);
      expect(text).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
      expect(text).not.toContain('\u001b[');
    }
    for (const name of fixtureFiles) {
      expect(read(name)).not.toMatch(/"pid"|\bpid=|instanceReference|api_?key|Bearer |Authorization|cookie/i);
      expect(read(name)).not.toMatch(/"(id|key|modelKey|identifier)":\s*"(?!publisher\/example-|example-|text-embedding-example-)/);
    }
  });
});

describe('HTTP bodies are byte-exact (Bionic sends no trailing newline)', () => {
  test('GET /lmstudio-greeting is the compact 17-byte greeting', () => {
    expect(read('lmstudio-greeting.ok.json')).toBe('{"lmstudio":true}');
    expect(json<Row>('lmstudio-greeting.ok.json')).toEqual({ lmstudio: true });
  });

  test('REST inventory and error bodies are 2-space JSON without a final newline', () => {
    for (const name of fixtureFiles.filter(file => file.startsWith('api-'))) {
      const text = read(name);
      expect(text.endsWith('\n')).toBe(false);
      expect(text).toBe(JSON.stringify(JSON.parse(text), null, 2));
    }
  });
});

describe('GET /api/v0/models (SPIKES S8 generation-change source)', () => {
  const V0 = ['api-v0-models.all-not-loaded.json', 'api-v0-models.one-loaded.json', 'api-v0-models.loading.json', 'api-v0-models.empty.json'];
  const MODEL_KEYS = ['id', 'object', 'type', 'publisher', 'arch', 'compatibility_type', 'quantization', 'state', 'max_context_length'];
  const states = (name: string) => json<{ data: Row[] }>(name).data.map(row => row.state);

  test.each(V0)('%s has the live key order and per-model types', name => {
    const body = json<Row>(name);
    expect(keysOf(body)).toEqual(['data', 'object']);
    expect(body.object).toBe('list');
    expect(Array.isArray(body.data)).toBe(true);
    for (const row of body.data as Row[]) {
      const withCapabilities = [...MODEL_KEYS, 'capabilities'];
      expect(keysOf(row)).toEqual(row.type === 'embeddings' ? MODEL_KEYS : withCapabilities);
      expect(typeof row.id).toBe('string');
      expect(row.object).toBe('model');
      expect(['llm', 'vlm', 'embeddings']).toContain(row.type as string);
      expect(typeof row.publisher).toBe('string');
      expect(typeof row.arch).toBe('string');
      expect(['splash', 'mlx', 'gguf']).toContain(row.compatibility_type as string);
      expect(typeof row.quantization).toBe('string');
      expect(['loaded', 'not-loaded', 'loading']).toContain(row.state as string);
      expect(isInt(row.max_context_length) && (row.max_context_length as number) > 0).toBe(true);
      if (row.type !== 'embeddings') expect(row.capabilities).toEqual(['tool_use']);
    }
  });

  test('variants differ only in the one model whose state moves not-loaded → loading → loaded', () => {
    expect(states('api-v0-models.all-not-loaded.json').every(state => state === 'not-loaded')).toBe(true);
    expect(states('api-v0-models.loading.json')).toEqual(['loading', 'not-loaded', 'not-loaded', 'not-loaded', 'not-loaded']);
    expect(states('api-v0-models.one-loaded.json')).toEqual(['loaded', 'not-loaded', 'not-loaded', 'not-loaded', 'not-loaded']);
    expect(json<{ data: Row[] }>('api-v0-models.one-loaded.json').data[0]?.id).toBe(LOADED_ID);
    const strip = (name: string) => json<{ data: Row[] }>(name).data.map(({ state: _state, ...rest }) => rest);
    expect(strip('api-v0-models.loading.json')).toEqual(strip('api-v0-models.all-not-loaded.json'));
    expect(strip('api-v0-models.one-loaded.json')).toEqual(strip('api-v0-models.all-not-loaded.json'));
    expect(json<Row>('api-v0-models.empty.json')).toEqual({ data: [], object: 'list' });
  });

  test('covers splash, mlx and gguf formats, publisher-scoped and bare ids, and an embedding without capabilities', () => {
    const rows = json<{ data: Row[] }>('api-v0-models.all-not-loaded.json').data;
    expect(new Set(rows.map(row => row.compatibility_type))).toEqual(new Set(['splash', 'mlx', 'gguf']));
    expect(rows.some(row => String(row.id).includes('/'))).toBe(true);
    expect(rows.some(row => !String(row.id).includes('/'))).toBe(true);
    expect(rows.filter(row => row.type === 'embeddings').every(row => !('capabilities' in row))).toBe(true);
  });
});

describe('GET /api/v1/models', () => {
  test('Splash inventory: typed models, one loaded instance, splash format', () => {
    const body = json<{ models: Row[] }>('api-v1-models.splash.json');
    expect(keysOf(body)).toEqual(['models']);
    const LLM_KEYS = ['type', 'publisher', 'key', 'display_name', 'architecture', 'quantization', 'size_bytes', 'params_string',
      'loaded_instances', 'max_context_length', 'format', 'capabilities', 'description'];
    const EMBEDDING_KEYS = ['type', 'publisher', 'key', 'display_name', 'quantization', 'size_bytes', 'params_string',
      'loaded_instances', 'max_context_length', 'format'];
    const instances: Row[] = [];
    for (const model of body.models) {
      expect(keysOf(model)).toEqual(model.type === 'llm' ? LLM_KEYS : EMBEDDING_KEYS);
      expect(['llm', 'embedding']).toContain(model.type as string);
      expect(typeof model.key).toBe('string');
      expect(typeof model.display_name).toBe('string');
      const quantization = model.quantization as Row;
      expect(typeof quantization.name).toBe('string');
      expect(isInt(quantization.bits_per_weight)).toBe(true);
      expect(isInt(model.size_bytes) && (model.size_bytes as number) > 0).toBe(true);
      expect(model.params_string === null || typeof model.params_string === 'string').toBe(true);
      expect(isInt(model.max_context_length)).toBe(true);
      expect(['splash', 'mlx', 'gguf']).toContain(model.format as string);
      expect(Array.isArray(model.loaded_instances)).toBe(true);
      if (model.type === 'llm') {
        expect(typeof (model.capabilities as Row).vision).toBe('boolean');
        expect(typeof (model.capabilities as Row).trained_for_tool_use).toBe('boolean');
        expect(model.description).toBeNull();
      }
      for (const instance of model.loaded_instances as Row[]) {
        expect(typeof instance.id).toBe('string');
        expect(isInt((instance.config as Row).context_length)).toBe(true);
        instances.push({ ...instance, size: model.size_bytes, key: model.key });
      }
    }
    expect(body.models.filter(model => model.format === 'splash')).toHaveLength(2);
    expect(instances).toEqual([{ id: LOADED_ID, key: LOADED_ID, size: LOADED_BYTES,
      config: { context_length: 262144, parallel: 4, reasoning_budget_message: '' } }]);
  });

  test('the HTTP 200 route-missing body is recognisable and carries no inventory', () => {
    const body = json<Row>('api-v1-models.route-missing.json');
    expect(body).toEqual({ error: 'Unexpected endpoint or method. (GET /api/v1/models)' });
    expect(String(body.error)).toMatch(/^Unexpected endpoint\b/i);
    expect('models' in body || 'data' in body).toBe(false);
  });
});

describe('lms ps --json (stdout)', () => {
  const PS_KEYS = ['type', 'modelKey', 'format', 'displayName', 'publisher', 'path', 'sizeBytes', 'indexedModelIdentifier',
    'deviceIdentifier', 'paramsString', 'architecture', 'quantization', 'identifier', 'ttlMs', 'lastUsedTime', 'vision',
    'trainedForToolUse', 'maxContextLength', 'contextLength', 'status', 'queued', 'parallel'];

  test('stdout is one compact JSON line ending in a single newline', () => {
    for (const name of fixtureFiles.filter(file => file.startsWith('lms-ps-json.'))) {
      const text = read(name);
      expect(text.endsWith('\n')).toBe(true);
      expect(text.slice(0, -1)).not.toContain('\n');
      expect(text).toBe(`${JSON.stringify(JSON.parse(text))}\n`);
      expect(Array.isArray(JSON.parse(text))).toBe(true);
    }
    expect(read('lms-ps-json.empty.txt')).toBe('[]\n');
  });

  test.each(['lms-ps-json.one-loaded.txt', 'lms-ps-json.generating.txt'])('%s has one loaded LLM instance with sizes', name => {
    const [instance, ...rest] = json<Row[]>(name);
    expect(rest).toEqual([]);
    expect(keysOf(instance)).toEqual(PS_KEYS);
    const row = instance as Row;
    expect(row.type).toBe('llm');
    expect(['gguf', 'safetensors', 'onnx', 'ggml', 'pte', 'mlx_placeholder', 'torch_safetensors', 'yuzu']).toContain(row.format as string);
    expect(row.format).toBe('yuzu');
    for (const key of ['modelKey', 'displayName', 'publisher', 'path', 'indexedModelIdentifier', 'identifier', 'architecture', 'paramsString']) {
      expect(typeof row[key]).toBe('string');
    }
    expect(row.path).not.toMatch(/^[/~]|^[a-z]:\\/i);
    expect(row.sizeBytes).toBe(LOADED_BYTES);
    expect(row.identifier).toBe(LOADED_ID);
    expect(row.deviceIdentifier).toBeNull();
    expect(row.quantization).toEqual({ name: '4bit', bits: 4 });
    expect(row.ttlMs === null || isInt(row.ttlMs)).toBe(true);
    expect(isInt(row.lastUsedTime)).toBe(true);
    expect(typeof row.vision).toBe('boolean');
    expect(typeof row.trainedForToolUse).toBe('boolean');
    expect(isInt(row.maxContextLength) && isInt(row.contextLength)).toBe(true);
    expect((row.contextLength as number) <= (row.maxContextLength as number)).toBe(true);
    expect(['idle', 'processingPrompt', 'generating', 'computingEmbedding']).toContain(row.status as string);
    expect(isInt(row.queued) && (row.queued as number) >= 0).toBe(true);
    expect(row.parallel === null || isInt(row.parallel)).toBe(true);
  });

  test('idle and generating variants describe the same instance', () => {
    const [idle] = json<Row[]>('lms-ps-json.one-loaded.txt');
    const [busy] = json<Row[]>('lms-ps-json.generating.txt');
    expect(idle).toMatchObject({ status: 'idle', queued: 0 });
    expect(busy).toMatchObject({ status: 'generating', queued: 1 });
    const stable = ({ status: _s, queued: _q, lastUsedTime: _t, ...rest }: Row) => rest;
    expect(stable(busy as Row)).toEqual(stable(idle as Row));
  });

  test('matches the loaded model in the v0 and v1 inventories', () => {
    const [instance] = json<Row[]>('lms-ps-json.one-loaded.txt');
    const v0 = json<{ data: Row[] }>('api-v0-models.one-loaded.json').data.find(row => row.state === 'loaded');
    const v1 = json<{ models: Row[] }>('api-v1-models.splash.json').models.find(model => (model.loaded_instances as Row[]).length > 0);
    expect(v0?.id).toBe((instance as Row).identifier);
    expect(v1?.key).toBe((instance as Row).modelKey);
    expect(v1?.size_bytes).toBe((instance as Row).sizeBytes);
    expect(v0?.max_context_length).toBe((instance as Row).maxContextLength);
  });
});

describe('lms runtime ls (stdout table)', () => {
  const text = read('lms-runtime-ls.bionic-splash.txt');
  const lines = text.split('\n');

  test('columnify layout: fixed-width columns, trailing pad spaces kept, one final newline', () => {
    expect(text.endsWith('\n') && !text.endsWith('\n\n')).toBe(true);
    lines.pop();
    const header = lines[0]!;
    expect(header).toMatch(/^LLM ENGINE {2,}SELECTED {4}MODEL FORMAT$/);
    const selectedAt = header.indexOf('SELECTED');
    const formatAt = header.indexOf('MODEL FORMAT');
    for (const line of lines) expect([...line].length).toBe(header.length);
    const rows = lines.slice(1).map(line => {
      const chars = [...line];
      return {
        engine: chars.slice(0, selectedAt).join('').trimEnd(),
        selected: chars.slice(selectedAt, formatAt).join('').trim(),
        format: chars.slice(formatAt).join('').trim(),
        raw: line,
      };
    });
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      expect(row.engine).toMatch(/^[a-z0-9.-]+@\d+\.\d+\.\d+$/);
      expect(['✓', '']).toContain(row.selected);
      expect(['GGUF', 'MLX', 'GGML', 'PTE', 'yuzu']).toContain(row.format);
    }
    expect(rows.some(row => row.raw.endsWith(' '))).toBe(true);
    const splash = rows.find(row => row.engine.startsWith('splash-'));
    expect(splash).toMatchObject({ engine: 'splash-mac-arm64-apple-metal-advsimd@0.0.5', selected: '✓', format: 'yuzu' });
    expect(new Set(rows.map(row => row.format))).toEqual(new Set(['GGUF', 'MLX', 'yuzu']));
    expect(rows.filter(row => row.selected === '✓')).toHaveLength(3);
  });
});

describe('lms log stream -s server --json (stdout NDJSON)', () => {
  const LOGS = fixtureFiles.filter(file => file.startsWith('lms-log-stream-server.'));
  const lines = (name: string) => {
    const text = read(name);
    expect(text.endsWith('\n')).toBe(true);
    return text.slice(0, -1).split('\n');
  };
  const content = (line: string) => (JSON.parse(line) as { data: { content: string } }).data.content;
  const HEAD = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]\[(DEBUG|INFO|WARN|ERROR)\](?:\[([^\]]+)\])? /;

  test.each(LOGS)('%s: every line is a server.log DiagnosticsLogEvent in CLI key order', name => {
    let previous = 0;
    for (const line of lines(name)) {
      const record = JSON.parse(line) as { timestamp: number; data: { type: string; content: string; level: string } };
      expect(keysOf(record)).toEqual(['timestamp', 'data']);
      expect(keysOf(record.data)).toEqual(['type', 'content', 'level']);
      expect(isInt(record.timestamp)).toBe(true);
      expect(record.timestamp).toBeGreaterThanOrEqual(previous);
      previous = record.timestamp;
      expect(record.data.type).toBe('server.log');
      expect(['debug', 'info', 'warn', 'error']).toContain(record.data.level);
      const head = HEAD.exec(record.data.content);
      expect(head).not.toBeNull();
      expect(head![2]!.toLowerCase()).toBe(record.data.level);
      const wall = new Date(record.timestamp).toISOString().replace('T', ' ').slice(0, 19);
      expect(head![1]).toBe(wall);
    }
  });

  test('only the oversized fixture line exceeds MAX_LOG_LINE_BYTES', () => {
    for (const name of LOGS) {
      for (const line of lines(name)) {
        const oversized = Buffer.byteLength(line) > MAX_LOG_LINE_BYTES;
        expect(oversized).toBe(line.includes('Accumulated 1050 tokens'));
      }
    }
    const [big] = lines('lms-log-stream-server.drop-oversized.txt');
    expect(Buffer.byteLength(big!)).toBeGreaterThan(MAX_LOG_LINE_BYTES + 4096);
  });

  test('redacted streaming lifecycle: request start, prompt progress, Done summary, finished', () => {
    const messages = lines('lms-log-stream-server.lifecycle.txt').map(line => content(line).replace(HEAD, ''));
    expect(messages).toEqual([
      'Received request: POST to /v1/chat/completions with body [Sensitive]',
      'Running chat completion on conversation with 3 messages.',
      'Streaming response...',
      'Prompt processing progress: 0.0%',
      'Prompt processing progress: 37.5%',
      'Prompt processing progress: 100.0%',
      '12:00:14 Done · input 1,536 · cached 1,024 · output 812 · TTFT 1.8s · 64.2 tok/s',
      'Finished streaming response',
    ]);
    const tags = lines('lms-log-stream-server.lifecycle.txt').map((line): string | null => (HEAD.exec(content(line))![3] as string | undefined) ?? null);
    expect(tags).toEqual([null, LOADED_ID, LOADED_ID, LOADED_ID, LOADED_ID, LOADED_ID, null, LOADED_ID]);
  });

  test('redacted non-streaming request ends with "Generated prediction"', () => {
    const messages = lines('lms-log-stream-server.non-streaming.txt').map(line => content(line).replace(HEAD, ''));
    expect(messages[1]).toMatch(/^Running chat completion on conversation with 1 messages\.$/);
    expect(messages.filter(message => message.startsWith('Prompt processing progress: '))).toHaveLength(2);
    expect(messages.filter(message => /^\d{2}:\d{2}:\d{2} Done · /.test(message))).toHaveLength(1);
    expect(messages.at(-1)).toBe('Generated prediction: [Sensitive]');
    expect(messages).not.toContain('Finished streaming response');
  });

  test('canaries are planted only in the lines that must be dropped', () => {
    for (const name of fixtureFiles) {
      const planted = name.startsWith('lms-log-stream-server.drop-') || name === 'lms-log-stream-server.sensitive-on.txt';
      if (!planted) expect(read(name).match(CANARY)).toBeNull();
    }
    const [body] = lines('lms-log-stream-server.drop-request-body.txt');
    expect(content(body!)).toContain(PROMPT_CANARY);
    expect(content(body!)).toContain('\n'); // pretty-printed request body: a multi-line record
    expect(content(body!)).toMatch(/^\[[^\]]+\]\[DEBUG\] Received request: POST to \/v1\/chat\/completions with body \{/);

    const tokens = lines('lms-log-stream-server.drop-incoming-tokens.txt').map(content);
    expect(tokens.length).toBeGreaterThanOrEqual(3);
    for (const token of tokens) {
      expect(token).toContain(OUTPUT_CANARY);
      expect(token).toMatch(/\] Accumulated \d+ tokens? /);
      expect(token).not.toContain('\n'); // newlines in generated text are escaped as a literal backslash-n
    }
    expect(tokens.some(token => token.includes('\\n'))).toBe(true);
    // Generated text that imitates the Splash summary must never be read as a completion.
    expect(tokens.some(token => /\] Accumulated \d+ tokens .*\bDone · input \d/.test(token))).toBe(true);

    const [big] = lines('lms-log-stream-server.drop-oversized.txt');
    expect(content(big!)).toContain(OUTPUT_CANARY);
    expect(content(big!).match(CANARY)!.length).toBeGreaterThan(1000);
  });

  test('sensitive-on stream = the redacted lifecycle shape with every must-drop line interleaved', () => {
    const all = lines('lms-log-stream-server.sensitive-on.txt');
    const dropped = ['drop-request-body', 'drop-incoming-tokens', 'drop-oversized']
      .flatMap(variant => lines(`lms-log-stream-server.${variant}.txt`));
    for (const line of dropped) expect(all).toContain(line);
    const kept = all.filter(line => !dropped.includes(line));
    expect(all.filter(line => line.match(CANARY))).toEqual(dropped);
    for (const line of kept) expect(line.match(CANARY)).toBeNull();
    expect(kept.map(line => content(line).replace(HEAD, '').replace(/^\d{2}:\d{2}:\d{2} (Done · ).*$/, '$1'))).toEqual([
      'Running chat completion on conversation with 2 messages.',
      'Streaming response...',
      'Prompt processing progress: 0.0%',
      'Prompt processing progress: 100.0%',
      'Done · ',
      'Finished streaming response',
    ]);
    expect(content(dropped[0]!).match(new RegExp(PROMPT_CANARY, 'g'))).toHaveLength(2);
  });
});

test('the byte-exact guard for editors stays in place', () => {
  expect(existsSync(path.join(ROOT, '.editorconfig'))).toBe(true);
});

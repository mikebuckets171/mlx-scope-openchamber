// Test support only: every 1.x reading the 1.6 panel can show, from the golden host and from the real service code.
import { readFileSync } from 'node:fs';
import type { RuntimeConnectionConfig, RuntimeConnections } from '../../../service/config.ts';
import { LMStudioClient } from '../../../service/lmstudio.ts';
import type { LMStudioActivityView } from '../../../service/lmstudio-activity.ts';
import { RuntimeClient } from '../../../service/runtime-client.ts';
import { SystemSampler } from '../../../service/system.ts';
import type { ConnectionInfo, Runtime } from '../../runtime.ts';
import type { MacMemory, SystemSnapshot } from '../../system.ts';
import { normalizeOmlxTelemetry, type TelemetrySnapshot } from '../../telemetry.ts';
import corpus from '../../../tests/fixtures/omlx-monitoring.json';

export type V1State = { name: string; body: TelemetrySnapshot & { system?: SystemSnapshot | null }; service: boolean };
export const EPOCH = Date.UTC(2026, 0, 15, 9, 30);

// The golden host (tests/browser/host.html) runs here unchanged, so its payloads are exactly the ones the goldens render.
const HOST = /<script>([\s\S]*?)<\/script><\/body>/.exec(readFileSync(new URL('../../../tests/browser/host.html', import.meta.url), 'utf8'))![1]!;
type Listener = (event: unknown) => unknown;
const hostPayloads = (query: string, provider: string | undefined, steps: number): TelemetrySnapshot[] => {
  let now = EPOCH + 10_000, listener: Listener | null = null;
  const replies: Array<{ payload?: { body?: string } }> = [], store = new Map<string, string>();
  const contentWindow = { postMessage: (message: { payload?: { body?: string } }) => { replies.push(message); } };
  const scope = { previewAutoProvider: provider, addEventListener: (type: string, handler: Listener) => { if (type === 'message') listener = handler; } };
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); }, clear: () => store.clear() };
  new Function('window', 'document', 'location', 'sessionStorage', 'Date', HOST)(scope, { querySelector: () => ({ contentWindow }) },
    { search: `?${query}`, href: 'http://fixture.invalid/' }, storage, { now: () => now });
  const payloads: TelemetrySnapshot[] = [];
  for (let step = 0; step < steps; step += 1, now += 500) {
    const before = replies.length;
    void listener!({ source: contentWindow, data: { channel: 'openchamber.sdk', type: 'service-request', id: step, payload: {} } });
    if (replies.length > before && replies.at(-1)!.payload?.body) payloads.push(JSON.parse(replies.at(-1)!.payload!.body!));
  }
  return payloads;
};
/** tests/browser/goldens.spec.ts CASES, then the other preview states. */
const HOST_CASES: Array<[string, string, string?]> = [
  ['omlx-decode', 'state=decode'], ['omlx-prefill', 'state=prefill'], ['omlx-idle', 'state=idle'], ['omlx-offline', 'state=offline'],
  ['omlx-auth', 'state=auth'], ['omlx-stalled', 'state=stalled'], ['omlx-multi', 'multi=1'], ['omlx-not-loaded', 'state=notLoaded'],
  ['dflash-preparing', 'state=dflash-preparing'], ['splash-ready', 'connections=1', 'splash'], ['splash-loading', 'connections=1&splashReady=0', 'splash'],
  ['bionic-decode', 'connections=1&bionic=decode', 'bionic'], ['bionic-prefill', 'connections=1&bionic=prefill', 'bionic'],
  ['bionic-idle', 'connections=1&bionic=idle', 'bionic'], ['lmstudio-inventory', 'connections=1', 'studio'],
  ['vllm-mlx-live', 'connections=1&vllm=live&state=decode', 'vllm'], ['mlx-lm-inventory', 'connections=1', 'mlx'],
  ['setup-missing', 'connections=1&setup=missing'], ['custom-needs-runtime', 'connections=1', 'custom'], ['service-denied', 'state=offline&denied=1'],
  ['queued', 'state=queued'], ['processing', 'state=processing'], ['prefill-stale', 'state=prefill-stale'], ['prefill-missing', 'state=prefill-missing'],
  ['prefill-malformed', 'state=prefill-malformed'], ['dflash', 'state=dflash'], ['reconnect', 'state=reconnect'], ['multi-resident', 'multi=resident'],
  ['multi-prefill', 'multi=1&state=prefill'], ['native-missing', 'native=missing'], ['linux', 'system=linux'], ['no-host', 'system=missing'],
  ['stats-stale', 'stats=stale'], ['long-name', 'long=1'], ['bionic-none', 'connections=1&bionic=none', 'bionic'], ['omlx-connection', 'connections=1'],
  ['vllm-prefill', 'connections=1&vllm=live&state=prefill', 'vllm'], ['vllm-inventory', 'connections=1', 'vllm'],
];
export const hostStates = (): V1State[] => HOST_CASES.flatMap(([name, query, provider]) =>
  hostPayloads(query, provider, 8).map((body, step) => ({ name: `host ${name} #${step}`, body, service: false })));

// Real service code with synthetic runtimes: RuntimeClient, the adapters, SystemSampler and the oMLX normalizer.
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
type Routes = Record<string, unknown>;
const link = (id: string, runtime: Runtime | null, apiKey: string | null = null): RuntimeConnectionConfig => ({
  id, label: `Local ${id}`, runtime, config: { baseURL: new URL('http://127.0.0.1:8000/'), apiKey, preferredModel: null,
    issue: apiKey ? 'none' : 'missing_credential', source: 'opencode', configStatus: 'present', authStatus: 'present', error: null } });
const read = async (config: RuntimeConnections | RuntimeConnectionConfig, routes: Routes | Array<Routes>, polls = 1) => {
  let now = EPOCH, poll = 0;
  const client = new RuntimeClient({ now: () => now, readConfig: async () => 'connections' in config ? config : { connections: [config], issue: 'none', error: null },
    fetchImpl: async url => {
      const table = Array.isArray(routes) ? routes[Math.min(poll, routes.length - 1)]! : routes, path = new URL(String(url)).pathname;
      if (!(path in table)) return json({ error: 'Unexpected endpoint' }, 404);
      const value = table[path];
      if (value instanceof Error) throw value;
      return typeof value === 'number' ? json({}, value) : json(value);
    } });
  const results: TelemetrySnapshot[] = [];
  for (; poll < polls; poll += 1, now += 1_000) results.push(await client.snapshot());
  return results;
};
const splash = (overrides: Record<string, unknown> = {}) => ({ '/status': { ready: true, maximum_context_tokens: 262_144,
  instance: { model: 'example/Example-27B-Splash' }, requests: { submitted: 18, completed: 17, cancelled: 1, failed: 0 },
  metrics: { decode_tokens_per_second: 47.2 }, memory_actual: { current_bytes: 12_500_000_000, peak_bytes: 13_000_000_000 }, ...overrides } });
const vllmRequest = (extra: Record<string, unknown> = {}) => ({ request_id: 'fixture-request', status: 'running', phase: 'generation',
  prompt_tokens: 1000, completion_tokens: 100, tokens_per_second: 50, elapsed_s: 3, cached_tokens: 500, cache_hit_type: 'prefix', ...extra });
const vllm = (status: Record<string, unknown>, health: Record<string, unknown> = { status: 'healthy', model_loaded: true,
  model_name: 'example-model', engine_type: 'batched', model_type: 'llm' }) => ({ '/health': health, '/v1/status': { status: 'running',
  model: 'example-model', num_running: 1, num_waiting: 0, requests: [vllmRequest()], total_requests_processed: 10, uptime_s: 100,
  cache: { max_memory_mb: 2048, current_memory_mb: 1024.5, entry_count: 4 }, ...status } });
const omlxCase = (name: string) => corpus.cases.find(item => item.name === name)! as { activity: unknown; stats?: unknown; contextWindows?: Record<string, number> };
const omlx = (name: string): Routes => { const item = omlxCase(name); return {
  '/health': { status: 'healthy', engine_pool: { model_count: 1 } }, '/admin/api/activity': item.activity,
  '/admin/api/stats': item.stats ?? 404, '/v1/models/status': { models: Object.entries(item.contextWindows ?? {}).map(([id, limit]) => ({ id, max_context_window: limit })) } }; };

const runtimeStates = async (): Promise<Array<[string, TelemetrySnapshot]>> => {
  const states: Array<[string, TelemetrySnapshot[]]> = [
    ['splash idle', await read(link('splash', 'splash'), splash())],
    ['splash busy', await read(link('splash', 'splash'), splash({ requests: { submitted: 21, completed: 17, cancelled: 1, failed: 1 } }))],
    ['splash loading', await read(link('splash', 'splash'), splash({ ready: false, requests: { completed: 10 }, instance: { model: '/models/example' } }))],
    ['splash unsupported', await read(link('splash', 'splash'), { '/status': { status: 'ready' } })],
    ['mlx-lm', await read(link('mlx', 'mlx-lm'), { '/health': { status: 'ok' }, '/v1/models': { object: 'list', data: [{ id: 'example/Example-4bit' }] } })],
    ['mlx-lm no catalog', await read(link('mlx', 'mlx-lm'), { '/health': { status: 'ok' }, '/v1/models': 500 })],
    ['mlx-lm down', await read(link('mlx', 'mlx-lm'), { '/health': { status: 'down' } })],
    ['vllm decode', await read(link('vllm', 'vllm-mlx'), [vllm({}), vllm({ requests: [vllmRequest({ completion_tokens: 125 })] })], 2)],
    ['vllm mllm prefill', await read(link('vllm', 'vllm-mlx'), [0.2, 0.4].map(progress => vllm({ requests: [vllmRequest({ phase: 'prefill', completion_tokens: 0, progress })] },
      { status: 'healthy', model_loaded: true, model_name: 'example-model', engine_type: 'batched', model_type: 'mllm' })), 2)],
    ['vllm queued', await read(link('vllm', 'vllm-mlx'), vllm({ num_running: 0, num_waiting: 2, requests: [] }))],
    ['vllm concurrent', await read(link('vllm', 'vllm-mlx'), vllm({ num_running: 2, requests: [vllmRequest(), vllmRequest({ request_id: 'fixture-second' })] }))],
    ['vllm not loaded', await read(link('vllm', 'vllm-mlx'), vllm({ status: 'not_loaded', residency: { state: 'loading' } }))],
    ['vllm registry', await read(link('vllm', 'vllm-mlx'), vllm({ model_manager: { models: [{ id: '/models/example-a', loaded: true }, { id: 'example-b', loaded: false }] } }))],
    ['lmstudio', await read(link('studio', 'lmstudio'), { '/api/v1/models': { models: [
      { type: 'llm', key: 'fixture/model', format: 'mlx', max_context_length: 32768, loaded_instances: [{ id: 'fixture/loaded', config: { context_length: 8192 } }] },
      { type: 'llm', key: 'fixture/other', format: 'gguf', max_context_length: 4096, loaded_instances: [] }] } })],
    ['lmstudio legacy', await read(link('bionic', 'lmstudio'), { '/api/v1/models': { error: 'Unexpected endpoint or method.' }, '/api/v0/models': { object: 'list',
      data: [{ id: 'fixture-splash', type: 'llm', state: 'loaded', compatibility_type: 'splash', max_context_length: 262144 }] } })],
    ['omlx decode', await read(link('omlx', 'omlx'), omlx('decode with request-matched cache'))],
    ['omlx prefill', await read(link('omlx', 'omlx'), omlx('prefill with request-matched cache'))],
    ['omlx detected', await read(link('auto', null), omlx('resident idle'))],
    ['omlx auth', await read(link('omlx', 'omlx', 'fixture-key'), { ...omlx('resident idle'), '/admin/api/login': 401 })],
    ['omlx unreachable', await read(link('omlx', 'omlx'), { '/health': new TypeError('fetch failed') })],
    ['custom unsupported', await read(link('custom', null), { '/health': 404, '/api/v1/models': 404, '/status': 404, '/v1/models': { data: [] } })],
    ['nothing configured', await read({ connections: [], issue: 'missing_endpoint', error: 'Add a local provider.' }, {})],
    ['invalid endpoint', await read({ ...link('bad', 'omlx'), config: { ...link('bad', 'omlx').config, baseURL: null, issue: 'invalid_endpoint', error: 'Invalid.' } }, {})],
  ];
  return states.flatMap(([name, list]) => list.map((body, index): [string, TelemetrySnapshot] => [`${name} #${index}`, body]));
};

const view = (overrides: Partial<LMStudioActivityView>): LMStudioActivityView => ({ active: null, concurrent: false, activeRequests: 0,
  lastRequest: null, completedRequests: 0, averageDecodeTPS: null, cacheEfficiencyPercent: null, ...overrides });
const lastRequest = { model: 'fixture-splash', tokensPerSecond: 38.6, ttftSeconds: 0.47, promptTokens: 18_400, cachedTokens: 11_260, outputTokens: 1092, finishedAt: EPOCH - 42_000 };
const lmstudioStates = async (): Promise<Array<[string, TelemetrySnapshot]>> => {
  const inventory = { object: 'list', data: [{ id: 'fixture-splash', type: 'llm', state: 'loaded', compatibility_type: 'splash', max_context_length: 262144 },
    { id: 'fixture-other', type: 'llm', state: 'not-loaded', compatibility_type: 'gguf', max_context_length: 8192 }] };
  const views: Array<[string, LMStudioActivityView]> = [
    ['idle after a response', view({ lastRequest, completedRequests: 3, averageDecodeTPS: 37.9, cacheEfficiencyPercent: 61.2 })],
    ['prefill', view({ active: { model: 'fixture-splash', phase: 'prefill', progress: 0.42, startedAt: EPOCH - 6_400, requests: 1 }, activeRequests: 1 })],
    ['decode', view({ active: { model: 'fixture-splash', phase: 'decode', progress: null, startedAt: EPOCH - 9_000, requests: 1 }, activeRequests: 1, lastRequest, completedRequests: 1 })],
    ['concurrent', view({ concurrent: true, activeRequests: 2, lastRequest, completedRequests: 1, averageDecodeTPS: 38.6 })],
  ];
  const result: Array<[string, TelemetrySnapshot]> = [];
  for (const [name, activity] of views) {
    const body = await new LMStudioClient(async path => path === '/api/v1/models' ? { error: 'Unexpected endpoint or method.' } : inventory,
      () => EPOCH, { touch() {}, view: () => activity }).snapshot();
    // runtime-client's connection for a Bionic provider serving Splash models.
    const connection: ConnectionInfo = { selected: 'bionic', label: 'Splash (Bionic)', runtime: 'lmstudio', generation: '00000000-0000-4000-8000-000000000003',
      choices: [{ id: 'bionic', label: 'Splash (Bionic)', runtime: 'lmstudio' }], diagnostic: 'ready',
      coverage: body.available && body.phase !== 'unknown' ? 'requests' : 'inventory', engine: 'splash', host: 'bionic' };
    result.push([`lmstudio activity ${name}`, { ...body, connection }]);
  }
  return result;
};

const corpusStates = (): Array<[string, TelemetrySnapshot]> => corpus.cases.flatMap(raw => {
  const item = raw as { name: string; activity: unknown; stats?: unknown; contextWindows?: Record<string, number>; invalid?: boolean };
  const body = item.invalid ? null : normalizeOmlxTelemetry(item.stats ?? null, item.activity, new Map(Object.entries(item.contextWindows ?? {})),
    null, EPOCH, item.stats ? 'fresh' : 'unavailable');
  const connection: ConnectionInfo = { selected: 'omlx', label: 'oMLX', runtime: 'omlx', generation: '00000000-0000-4000-8000-000000000004',
    choices: [{ id: 'omlx', label: 'oMLX', runtime: 'omlx' }], diagnostic: 'ready', coverage: 'requests', engine: null, host: null };
  return body ? [[`oMLX corpus ${item.name}`, { ...body, traceEpoch: 3, connection }]] : [];
});

const cpu = (idle: number, user: number) => [{ model: 'Apple M-series · fixture', speed: 0, times: { idle, user, nice: 0, sys: 0, irq: 0 } }];
const hosts = async (): Promise<Array<SystemSnapshot | null>> => {
  const sample = async (platform: string, native: () => Promise<MacMemory>, free = 12.4e9, total = 51_539_607_552) => {
    let now = EPOCH, reads = 0;
    const sampler = new SystemSampler({ now: () => now, hostPlatform: platform, readCPUs: () => cpu(800 + 610 * reads, 200 + 390 * reads++),
      readFree: () => free, readTotal: () => total, native: { sample: native } });
    const first = await sampler.sample();
    now += 2_000;
    return [first, await sampler.sample()];
  };
  const mac: MacMemory = { wiredGB: 4_831_838_208 / 1e9, compressedGB: 3_006_477_107 / 1e9, swapUsedGB: 1_181_116_006 / 1e9, sampledAt: EPOCH - 3_000 };
  return [null, ...await sample('darwin', async () => mac), ...await sample('darwin', async () => { throw new Error('no native'); }),
    ...await sample('darwin', async () => ({ wiredGB: null, compressedGB: null, swapUsedGB: null, sampledAt: EPOCH })),
    ...await sample('linux', async () => mac), ...await sample('darwin', async () => mac, 60e9, 48e9)];
};

/** The service's real `/snapshot` bodies: a runtime reading plus a host reading, as service/server.ts joins them. */
export const serviceStates = async (): Promise<V1State[]> => {
  const [systems, runtimes] = [await hosts(), [...await runtimeStates(), ...await lmstudioStates(), ...corpusStates()]];
  return runtimes.map(([name, body], index) => ({ name: `service ${name}`, body: { ...body, system: systems[index % systems.length] }, service: true }));
};

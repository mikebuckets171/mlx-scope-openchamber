import { expect, test } from 'bun:test';
import type { RuntimeKind } from '../../src/contract/runtime.ts';
import type { Runtime } from '../../src/runtime.ts';
import { HttpFailure } from '../http.ts';
import { DETECT_ORDER, type RuntimeGet, type RuntimeReply } from './adapter-v2.ts';
import { hintFor } from './hints.ts';
import { DESCRIPTORS, descriptorOf, descriptorsWith, detect, type Detection } from './registry.ts';

type Reply = RuntimeReply | 'network';
const ok = (body: unknown): RuntimeReply => ({ status: 200, body: body as RuntimeReply['body'], routeMissing: false });
const status = (code: number, body: unknown = null): RuntimeReply => ({ status: code, body: body as RuntimeReply['body'], routeMissing: false });
const MISSING: RuntimeReply = { status: 200, body: { error: 'Unexpected endpoint or method. (GET /x)' }, routeMissing: true };
/** A server answering only the listed paths; anything else is a 404 (or LM Studio's 200 route-missing body). */
const server = (routes: Record<string, Reply>, unknown: RuntimeReply = status(404)) => {
  const calls: string[] = [];
  const get: RuntimeGet = async path => {
    calls.push(path);
    const reply = routes[path] ?? unknown;
    if (reply === 'network') throw new HttpFailure('runtime_unreachable', 'The runtime did not answer.');
    return reply;
  };
  return { get, calls };
};
const RUNTIMES = {
  omlx: { '/health': ok({ status: 'healthy', engine_pool: { model_count: 1 } }) },
  'omlx loading': { '/health': status(503, { status: 'loading', engine_pool: { model_count: 0 } }) },
  vllm: { '/health': ok({ model_loaded: true, engine_type: 'batched', available_models: ['x'] }), '/v1/models': ok({ data: [{ owned_by: 'vllm-mlx' }] }) },
  'vllm without health': { '/v1/models': ok({ data: [{ owned_by: 'vllm-mlx' }, { owned_by: 'vllm-mlx-embedding' }] }) },
  bionic: { '/lmstudio-greeting': ok({ lmstudio: true }), '/api/v1/models': ok({ models: [] }) },
  'old lm studio': { '/api/v1/models': ok({ models: [] }) },
  splash: { '/health': ok({ status: 'ok' }), '/status': ok({ ready: false }) },
} satisfies Record<string, Record<string, Reply>>;

test('each runtime is identified by its own fingerprint, with the probe and confidence that made it', async () => {
  const expected: Record<keyof typeof RUNTIMES, [RuntimeKind, Detection['confidence'], Detection['probe']]> = {
    omlx: ['omlx', 'high', '/health'], 'omlx loading': ['omlx', 'high', '/health'], vllm: ['vllm-mlx', 'medium', '/health'],
    'vllm without health': ['vllm-mlx', 'high', '/v1/models'], bionic: ['lmstudio', 'high', '/lmstudio-greeting'],
    'old lm studio': ['lmstudio', 'medium', '/lmstudio-greeting'], splash: ['splash', 'medium', '/status'],
  };
  for (const [name, routes] of Object.entries(RUNTIMES)) {
    const [runtime, confidence, probe] = expected[name as keyof typeof RUNTIMES];
    expect(await detect(DESCRIPTORS, server(routes).get), name).toEqual({ runtime, confidence, probe });
    // LM Studio answers unknown routes with a 200 error body; that is "absent", exactly like a 404.
    expect(await detect(DESCRIPTORS, server(routes, MISSING).get), `${name} (route-missing bodies)`).toEqual({ runtime, confidence, probe });
  }
});

test('one pass fetches each path at most once, in plan §5.1 order, and stops at the first identification', async () => {
  const nothing = server({});
  expect(await detect(DESCRIPTORS, nothing.get)).toEqual({ runtime: null, locked: false });
  expect(nothing.calls).toEqual(['/health', '/lmstudio-greeting', '/api/v1/models', '/status', '/v1/models']);
  // Probes with no descriptor step yet (/props, /api/version) are sent only once their adapters declare them.
  expect(DETECT_ORDER).toEqual(['/health', '/props', '/api/version', '/lmstudio-greeting', '/status', '/v1/models']);
  const splash = server(RUNTIMES.splash);
  await detect(DESCRIPTORS, splash.get);
  expect(splash.calls).toEqual(['/health', '/lmstudio-greeting', '/api/v1/models', '/status']);
  const bionic = server(RUNTIMES.bionic);
  await detect(DESCRIPTORS, bionic.get);
  expect(bionic.calls).toEqual(['/health', '/lmstudio-greeting']);
});

test('the hinted descriptor goes first, and a wrong hint costs nothing but its own probes', async () => {
  const hinted = server(RUNTIMES.splash);
  expect(await detect(DESCRIPTORS, hinted.get, 'splash')).toMatchObject({ runtime: 'splash' });
  expect(hinted.calls).toEqual(['/status']);
  const wrong = server(RUNTIMES.vllm);
  expect(await detect(DESCRIPTORS, wrong.get, 'splash')).toEqual({ runtime: 'vllm-mlx', confidence: 'medium', probe: '/health' });
  expect(wrong.calls).toEqual(['/status', '/health']);
  // mlx-lm has no fingerprint: a hint alone never identifies it, and the pass carries on.
  const mlx = server({ '/health': ok({ status: 'ok' }), '/v1/models': ok({ object: 'list', data: [{ id: 'x', owned_by: 'mlx' }] }) });
  expect(await detect(DESCRIPTORS, mlx.get, 'mlx-lm')).toEqual({ runtime: null, locked: false });
});

test('401/403 means an authenticated runtime is present; a request that cannot complete ends the pass', async () => {
  expect(await detect(DESCRIPTORS, server({ '/status': status(401) }).get)).toEqual({ runtime: null, locked: true });
  expect(await detect(DESCRIPTORS, server({ '/v1/models': status(403) }).get)).toEqual({ runtime: null, locked: true });
  // A locked probe does not hide a public fingerprint later in the order.
  expect(await detect(DESCRIPTORS, server({ '/lmstudio-greeting': status(401), ...RUNTIMES.splash }).get)).toMatchObject({ runtime: 'splash' });
  // LM Studio with authentication: the greeting is public, so it is identified even though its models need the key.
  expect(await detect(DESCRIPTORS, server({ '/lmstudio-greeting': ok({ lmstudio: true }), '/api/v1/models': status(401) }).get)).toMatchObject({ runtime: 'lmstudio' });
  for (const [failing, calls] of [['/health', ['/health']], ['/status', ['/health', '/lmstudio-greeting', '/api/v1/models', '/status']]] as const) {
    const down = server({ [failing]: 'network' });
    await expect(detect(DESCRIPTORS, down.get)).rejects.toMatchObject({ reason: 'runtime_unreachable' });
    expect(down.calls).toEqual([...calls]);
  }
});

test('every combination of probe replies: one GET per path, and the answer the fingerprints give', async () => {
  const replies: Record<string, Record<string, Reply>> = {
    '/health': { omlx: RUNTIMES.omlx['/health'], vllm: RUNTIMES.vllm['/health'], generic: ok({ status: 'ok' }), missing: MISSING, '401': status(401), '404': status(404), '500': status(500), network: 'network' },
    '/lmstudio-greeting': { greeting: ok({ lmstudio: true }), false: ok({ lmstudio: false }), missing: MISSING, '404': status(404), '401': status(401) },
    '/api/v1/models': { models: ok({ models: [] }), missing: MISSING, '404': status(404), '401': status(401) },
    '/status': { splash: ok({ ready: true }), 'not boolean': ok({ ready: 'yes' }), '404': status(404), '405': status(405), network: 'network' },
    '/v1/models': { vllm: RUNTIMES['vllm without health']['/v1/models'], mixed: ok({ data: [{ owned_by: 'vllm-mlx' }, { owned_by: 'mlx' }] }), empty: ok({ data: [] }), '401': status(401) },
  };
  const paths = Object.keys(replies);
  const combos = paths.reduce<Array<Record<string, Reply>>>((rows, path) => rows.flatMap(row => Object.values(replies[path]!).map(reply => ({ ...row, [path]: reply }))), [{}]);
  expect(combos.length).toBe(8 * 5 * 4 * 5 * 4);
  const seen = new Set<string>();
  for (const routes of combos) {
    const { get, calls } = server(routes);
    const result = await detect(DESCRIPTORS, get).catch(() => 'unreachable' as const);
    expect(new Set(calls).size, JSON.stringify(routes)).toBe(calls.length);
    const is = (path: string, reply: Reply) => routes[path] === reply;
    const absent = (path: string) => [MISSING, status(404)].some(reply => JSON.stringify(reply) === JSON.stringify(routes[path]));
    // What a full pass must have fetched: every probe, plus the LM Studio follow-up only when there is no greeting.
    const fetched = ['/health', '/lmstudio-greeting', '/status', '/v1/models', ...absent('/lmstudio-greeting') ? ['/api/v1/models'] : []];
    const expected = is('/health', replies['/health']!.network!) ? 'unreachable'
      : is('/health', replies['/health']!.omlx!) ? 'omlx' : is('/health', replies['/health']!.vllm!) ? 'vllm-mlx'
        : is('/lmstudio-greeting', replies['/lmstudio-greeting']!.greeting!) ? 'lmstudio'
          : absent('/lmstudio-greeting') && is('/api/v1/models', replies['/api/v1/models']!.models!) ? 'lmstudio'
            : is('/status', replies['/status']!.network!) ? 'unreachable' : is('/status', replies['/status']!.splash!) ? 'splash'
              : is('/v1/models', replies['/v1/models']!.vllm!) ? 'vllm-mlx'
                : fetched.some(path => { const reply = routes[path]; return reply !== undefined && reply !== 'network' && [401, 403].includes(reply.status); }) ? 'locked' : 'none';
    const actual = result === 'unreachable' ? result : result.runtime ?? (result.locked ? 'locked' : 'none');
    expect(actual, JSON.stringify(routes)).toBe(expected);
    seen.add(actual);
  }
  expect([...seen].sort()).toEqual(['lmstudio', 'locked', 'none', 'omlx', 'splash', 'unreachable', 'vllm-mlx']);
});

const legacyHint = (id: string, name: unknown): Runtime | null => {
  const value = `${id} ${typeof name === 'string' ? name : ''}`.toLowerCase();
  const providerName = typeof name === 'string' ? name.trim() : '';
  if (/bionic|lm[\s_-]*studio/.test(value)) return 'lmstudio';
  if (id.trim().toLowerCase() === 'splash' || /splash/i.test(providerName)) return 'splash';
  if (/vllm[\s_-]*mlx/.test(value)) return 'vllm-mlx';
  if (/omlx/.test(value)) return 'omlx';
  return /mlx[\s_-]*lm/.test(value) ? 'mlx-lm' : null;
};
test('provider hints keep their 1.6 precedence, and splish (the owner\'s Splash fork) now hints Splash', () => {
  const ids = ['omlx', 'lmstudio', 'bionic', 'splash', ' Splash ', 'vllm-mlx', 'vllm_mlx', 'mlx-lm', 'mlx lm', 'custom', 'my-omlx', 'lm-studio-omlx', 'splash-omlx'];
  const names = [undefined, '', 'oMLX', 'LM Studio', 'Splash (Bionic)', 'Splash', 'vLLM MLX', 'mlx_lm server', 'Local', 42];
  for (const id of ids) for (const name of names) expect(hintFor(id, name), `${id} / ${String(name)}`).toBe(legacyHint(id, name));
  expect([hintFor('splish', ''), hintFor('local', 'Splish'), hintFor('splish-local', 'Local')]).toEqual(['splash', 'splash', 'splash']);
  for (const item of DESCRIPTORS.filter(entry => !['llama-server', 'ollama'].includes(entry.id))) expect(item.hints('x', `${item.id} server`), item.id).toBe(true);
});

test('the registry lists every runtime once, with the 1.6 cadences and the identity intervals', () => {
  expect(DESCRIPTORS.map(item => item.id)).toEqual(['omlx', 'lmstudio', 'mlx-lm', 'vllm-mlx', 'splash', 'llama-server', 'ollama']);
  const cadence = (id: RuntimeKind, activity = false) => descriptorOf(DESCRIPTORS, id)!.cadence({ activity, tier: 'full', recovering: false });
  expect([cadence('omlx'), cadence('lmstudio'), cadence('lmstudio', true), cadence('mlx-lm'), cadence('vllm-mlx'), cadence('splash')])
    .toEqual([450, 5_000, 1_000, 2_000, 450, 2_000]);
  expect(DESCRIPTORS.map(item => [item.id, item.identityEveryMs])).toEqual([['omlx', 300_000], ['lmstudio', 60_000], ['mlx-lm', 60_000],
    ['vllm-mlx', 60_000], ['splash', 60_000], ['llama-server', 60_000], ['ollama', 60_000]]);
  // The LM Studio bridge gets the service's log stream per port.
  const ports: number[] = [];
  const lmstudio = descriptorOf(descriptorsWith({ activity: port => { ports.push(port); return null; } }), 'lmstudio')!;
  lmstudio.create({ connection: { id: 'bionic', port: 1234 } } as never);
  expect(ports).toEqual([1234]);
});

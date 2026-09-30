// Test support only (ad-llama-ollama): a scripted loopback runtime serving fixture files, the AdapterContextV2 around
// it, and the v2 body a reading becomes, for the round-trip tests. Nothing here is bundled.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classAKeys, obj } from '../../../src/contract/guards.ts';
import { honestyViolations, parseSnapshotV2, type SnapshotV2 } from '../../../src/contract/snapshot.ts';
import type { RuntimeKind } from '../../../src/contract/runtime.ts';
import { unitViolations } from '../../../src/contract/units.ts';
import type { AdapterContextV2, AdapterReadingV2, ReadContext } from '../../core/adapter-v2.ts';
import { HttpFailure } from '../../http.ts';

export const EPOCH = 1_790_690_700_000;
export type Route = { status: number; file?: string; text?: string } | 'network';
export interface FakeRuntime {
  context: AdapterContextV2;
  routes: Record<string, Route>;
  log: string[];                             // every path requested, in order
  served: Set<string>;                       // every fixture file served
  clock: { now: number; mono: number };
  advance(ms: number): void;
  paths(): string[];                         // requested paths since the last call
}

/** `routes` maps a request path to a fixture under `root` (or literal text); anything else is a 404. */
export const fakeRuntime = (root: string, routes: Record<string, Route> = {}): FakeRuntime => {
  const log: string[] = [], served = new Set<string>(), clock = { now: EPOCH, mono: 10_000 };
  let mark = 0;
  const answer = (path: string, maxBytes?: number): { status: number; text: string } => {
    log.push(path);
    const route = routes[path] ?? { status: 404, text: '{"error":"not found"}' };
    if (route === 'network') throw new HttpFailure('runtime_unreachable', 'The runtime did not answer.');
    if (route.file) served.add(route.file);
    const text = route.text ?? (route.file ? readFileSync(join(root, route.file), 'utf8') : '');
    if (maxBytes !== undefined && Buffer.byteLength(text) > maxBytes) throw new HttpFailure('runtime_unreachable', 'Response too large');
    return { status: route.status, text };
  };
  const context = {
    connection: { id: 'fixture', port: 18_080 },
    get: async (path: string) => {
      const { status, text } = answer(path);
      let body: unknown = null;
      try { body = JSON.parse(text); } catch { body = null; }
      // requestJSON keeps objects only: an array body (llama /slots) arrives as null.
      return { status, body: obj(body), routeMissing: typeof obj(body)?.error === 'string' && String(obj(body)!.error).startsWith('Unexpected endpoint or method.') };
    },
    getText: async (path: string, maxBytes?: number) => answer(path, maxBytes),
    config: {} as AdapterContextV2['config'], fetchImpl: (() => { throw new Error('no fetch in adapter tests'); }) as AdapterContextV2['fetchImpl'],
    exec: async () => { throw new Error('no exec in adapter tests'); },
    now: () => clock.now, monotonic: () => clock.mono, timeoutMs: 3_000, budgetMs: 8_000,
  } satisfies AdapterContextV2;
  return {
    context, routes, log, served, clock,
    advance(ms) { clock.now += ms; clock.mono += ms; },
    paths() { const recent = log.slice(mark); mark = log.length; return recent; },
  };
};

export const readContext = (runtime: FakeRuntime, tier: ReadContext['tier'] = 'full'): ReadContext =>
  ({ deadline: runtime.clock.mono + 8_000, tier, detail: tier === 'full' });

const INSTANCE = '5c1e0a7b';
const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1).map(([key, item]) => [key, sorted(item)])) : value;
/** Key order is the parser's business; values are not. */
export const canonical = (value: unknown): string => JSON.stringify(sorted(value));
/** The v2 body a reading becomes (what composeSnapshot adds is fixed here). */
export const bodyOf = (reading: AdapterReadingV2, runtime: RuntimeKind): SnapshotV2 => ({
  contractVersion: 2, serverNow: reading.at, service: { version: '2.0.0-test', instance: INSTANCE },
  connection: { id: 'fixture', label: 'Fixture', runtime, ...reading.identity, generation: 1, choices: [],
    detection: { basis: 'probe', confidence: 'high', probe: runtime === 'ollama' ? '/api/version' : '/props' } },
  status: reading.status, capabilities: reading.capabilities, runtime: reading.runtime, host: null,
  completions: { instance: INSTANCE, cursor: reading.completions.length, reset: false,
    items: reading.completions.map((draft, index) => ({ ...draft, seq: index + 1, host: {} })) },
  marksHead: 0, alerts: [], alertLog: [], lease: { leader: true, epoch: 1, ttlMs: 12_000, leaderSurface: 'panel' }, nextPollMs: 500,
});

/**
 * The round trip: the body parses, nothing in it is withheld or rewritten by the frame's parser (honesty, units, class A),
 * and it stays under the route limit. Returns the JSON text for canary checks.
 */
export const roundTrip = (reading: AdapterReadingV2, runtime: RuntimeKind): { text: string; parsed: SnapshotV2 } => {
  const body = bodyOf(reading, runtime), text = JSON.stringify(body);
  const parsed = parseSnapshotV2(JSON.parse(text));
  if (!parsed) throw new Error(`the ${runtime} body does not parse: ${text.slice(0, 400)}`);
  const problems = [...honestyViolations(body), ...unitViolations(body), ...classAKeys(body)];
  if (problems.length) throw new Error(`${runtime}: ${problems.join('; ')}`);
  if (canonical(parsed) !== canonical(JSON.parse(text))) {
    throw new Error(`${runtime}: the frame's parser changed the body\n${text}\n${JSON.stringify(parsed)}`);
  }
  if (text.length >= 256_000) throw new Error(`${runtime}: ${text.length} characters`);
  return { text, parsed };
};

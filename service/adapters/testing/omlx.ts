// Test support only: a scripted oMLX behind `fetchImpl`, fed from the fixture corpus (tests/fixtures/omlx), and the
// v2 envelope a reading travels in, so adapter tests can run it through parseSnapshotV2 as a frame would.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterContextV2, AdapterReadingV2 } from '../../core/adapter-v2.ts';
import type { SnapshotV2 } from '../../../src/contract/snapshot.ts';
import type { OmlxConfig } from '../../config.ts';

const ROOT = join(import.meta.dir, '../../../tests/fixtures/omlx');
export type Version = '0.7.0rc1' | '0.6.4';
export const fixture = (version: Version, file: string): unknown => JSON.parse(readFileSync(join(ROOT, version, file), 'utf8'));
export const fixtureFiles = (version: Version, prefix: string): string[] =>
  readdirSync(join(ROOT, version)).filter(file => file.startsWith(prefix) && file.endsWith('.json')).sort();

/** Every privacy canary the corpus plants (SOURCE.md), and the shapes of class A values. */
export const LEAKS = [/CANARY/, /7f3a/i, /\/Users\//, /fixture-main-key/, /fixture-sub-key/, /omlx_admin_session/, /session-cookie/];
export const leaks = (value: unknown): string[] => { const text = JSON.stringify(value); return LEAKS.filter(pattern => pattern.test(text)).map(String); };

/** A route answer: a fixture body with its HTTP status (and a login cookie), or a thrown network failure. */
export type Answer = { status: number; body: unknown; cookie?: string } | 'network';
export type Route = Answer | ((request: { method: string; headers: Record<string, string>; body: string | null }) => Answer);
export interface Call { method: string; path: string; headers: Record<string, string>; body: string | null }
export const ok = (body: unknown): Answer => ({ status: 200, body });
export const from = (version: Version, file: string, status = 200): Answer => ({ status, body: fixture(version, file) });

/** Routes by path (with its query); unknown paths answer FastAPI's 404. Every call is recorded. */
export const fakeOmlx = (routes: Record<string, Route>) => {
  const calls: Call[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input)), path = `${url.pathname}${url.search}`, method = init?.method ?? 'GET';
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const call = { method, path, headers, body: typeof init?.body === 'string' ? init.body : null };
    calls.push(call);
    const route = routes[path];
    const answer = route === undefined ? { status: 404, body: { detail: 'Not Found' } } : typeof route === 'function' ? route(call) : route;
    if (answer === 'network') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(answer.body), { status: answer.status,
      headers: { 'Content-Type': 'application/json', ...answer.cookie ? { 'set-cookie': `omlx_admin_session=${answer.cookie}; Path=/; HttpOnly` } : {} } });
  };
  return { fetchImpl, calls, routes };
};
/** The main key logs in; a sub key is refused (oMLX: main-key login only, S6). */
export const login = (key = 'fixture-main-key'): Route => request =>
  request.body !== null && JSON.parse(request.body).api_key === key ? { status: 200, body: { success: true }, cookie: 'session-cookie' }
    : { status: 401, body: { detail: 'Invalid API key' } };
/** Admin reads need the cookie `login` hands out; anything else gets oMLX's 401 (`require_admin`). */
export const admin = (answer: Answer): Route => request =>
  request.headers.Cookie === 'omlx_admin_session=session-cookie' ? answer : from('0.7.0rc1', 'admin-api-activity.unauthorized.json', 401);

export const clock = (start = Date.UTC(2026, 8, 29, 5, 30)) => {
  const state = { now: start, mono: 1_000_000 };
  return { state, advance: (ms: number) => { state.now += ms; state.mono += ms; } };
};
const unused = async (): Promise<never> => { throw new Error('the oMLX adapter makes its own requests'); };
export const contextFor = (fetchImpl: AdapterContextV2['fetchImpl'], time = clock(), apiKey: string | null = 'fixture-main-key'): AdapterContextV2 => ({
  connection: { id: 'omlx', port: 8000 }, get: unused, getText: unused, fetchImpl, exec: async () => null,
  config: { baseURL: new URL('http://127.0.0.1:8000/'), apiKey, preferredModel: null, error: null, issue: 'none', source: 'opencode',
    configStatus: 'present', authStatus: 'present' } satisfies OmlxConfig,
  now: () => time.state.now, monotonic: () => time.state.mono, timeoutMs: 3_000, budgetMs: 8_000,
});

export const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
/** The /v2/snapshot body a reading becomes, before svc-2b's compose adds host, completions and alerts. */
export const envelope = (reading: AdapterReadingV2): SnapshotV2 => wire<SnapshotV2>({
  contractVersion: 2, serverNow: reading.at, service: { version: '2.0.0', instance: '5c1e0a7b' },
  connection: { id: 'omlx', label: 'Local oMLX', runtime: 'omlx', ...reading.identity, generation: 1, choices: [],
    detection: { basis: 'probe', confidence: 'high', probe: '/health' } },
  status: reading.status, capabilities: reading.capabilities, runtime: reading.runtime, host: null,
  completions: { instance: '5c1e0a7b', cursor: 0, reset: false, items: reading.completions.map((draft, index) => ({ ...draft, seq: index + 1, host: {} })) },
  marksHead: 0, alerts: [], alertLog: [], lease: { leader: true, epoch: 0, ttlMs: 12_000, leaderSurface: 'panel' }, nextPollMs: 500,
});

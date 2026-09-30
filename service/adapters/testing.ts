// Test support only: an adapter context over a route table, for the v2 adapters' unit tests.
import type { OmlxConfig } from '../config.ts';
import type { AdapterContextV2, RuntimeReply } from '../core/adapter-v2.ts';

export type Route = unknown | number | Error | RuntimeReply;
/** A reply for each path: a body (200), a bare status, a thrown error, or a whole reply; a missing path is a 404. */
export const routeContext = (routes: () => Record<string, Route>, clock: { now: number }, id = 'local', port = 8000) => {
  const paths: string[] = [];
  const config: OmlxConfig = { baseURL: new URL(`http://127.0.0.1:${port}/`), apiKey: null, preferredModel: null, error: null, issue: 'missing_credential',
    source: 'opencode', configStatus: 'present', authStatus: 'present' };
  const context: AdapterContextV2 = {
    connection: { id, port }, config, fetchImpl: fetch, exec: async () => null, now: () => clock.now, monotonic: () => clock.now,
    timeoutMs: 3_000, budgetMs: 8_000, getText: async () => ({ status: 404, text: '' }),
    get: async path => {
      paths.push(path);
      const value = routes()[path];
      if (value instanceof Error) throw value;
      if (value === undefined) return { status: 404, body: { detail: 'Not Found' }, routeMissing: false };
      if (typeof value === 'number') return { status: value, body: null, routeMissing: false };
      const reply = value as Partial<RuntimeReply>;
      if (typeof reply.status === 'number' && 'routeMissing' in reply) return structuredClone(reply as RuntimeReply);
      return { status: 200, body: structuredClone(value) as RuntimeReply['body'], routeMissing: false };
    },
  };
  return { context, paths };
};
export const READ = { deadline: Number.POSITIVE_INFINITY, tier: 'full', detail: false } as const;

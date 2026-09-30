import fixtures from '../../docs/design/2.0-mock-fixtures.json';

// Owner: ui-core. The approved G2 mock's v2 fixtures (docs/design/2.0-mock-fixtures.json) as `/v2/snapshot` bodies, for the
// presenter tests, the 2.0 fixture host (tests/browser/v2-host.html) and the 2.0 goldens. Synthetic: no real model, path
// or identifier. Times are shifted so the fixture's `serverNow` is the caller's `now`.

type Json = Record<string, unknown>;
interface State { title: string; snapshot: string; patch?: Json; view?: Json }
const source = fixtures as unknown as { serverNow: number; snapshots: Record<string, Json>; states: Record<string, State> };
export const MOCK_NOW = source.serverNow;
export const MOCK_STATES = Object.keys(source.states);
export const mockTitle = (state: string): string => source.states[state]?.title ?? state;
/** Panel-side state the mock drew (attribution labels, Next reply, paused): produced by the frame, never by the service. */
export const mockView = (state: string): Json => source.states[state]?.view ?? {};

const merge = (a: unknown, b: unknown): unknown => b === undefined ? a : b === null || typeof b !== 'object' || Array.isArray(b) ? b
  : Object.fromEntries([...new Set([...Object.keys((a ?? {}) as Json), ...Object.keys(b as Json)])].map(key => [key, merge((a as Json | undefined)?.[key], (b as Json)[key])]));
const TIME = /(?:At|^serverNow|^since|^until|^at)$/;
const shift = (value: unknown, offset: number, key = ''): unknown => {
  if (Array.isArray(value)) return value.map(item => shift(item, offset));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shift(v, offset, k)]));
  return typeof value === 'number' && TIME.test(key) && value > 1e12 ? value + offset : value;
};

export interface MockOptions { now?: number; since?: number; lease?: Json; nextPollMs?: number }
/** One state as the service would answer: `since` drops completions the frame already has; the cursor stays. */
export const mockBody = (state: string, options: MockOptions = {}): Json => {
  const entry = source.states[state] ?? source.states.decode!;
  const body = shift(merge(source.snapshots[entry.snapshot], entry.patch), (options.now ?? MOCK_NOW) - MOCK_NOW) as Json;
  const completions = body.completions as { items: Array<{ seq: number }> };
  if (options.since !== undefined) completions.items = completions.items.filter(item => item.seq > options.since!);
  if (options.lease) body.lease = { ...(body.lease as Json), ...options.lease };
  if (options.nextPollMs !== undefined) body.nextPollMs = options.nextPollMs;
  return body;
};

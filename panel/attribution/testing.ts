// Test support only: the real SDK HostClient over a synthetic parent frame (so replays behave as the SDK makes them),
// and minimal valid `/v2/snapshot` bodies. Synthetic ids and names; nothing here reaches a bundle.
import { connectHost, type HostClient, type SessionLifecyclePhase, type SessionSnapshot } from '@openchamber/sdk';
import type { CompletionV2 } from '../../src/contract/completion.ts';
import { parseSnapshotV2, type SnapshotV2 } from '../../src/contract/snapshot.ts';

export const INSTANCE = '5c1e0a7b';
export const T0 = 1_790_690_000_000;
export const CHAT = { id: 'ses_fixture_chat_a', title: 'Secret chat title', busy: false, model: 'splish/publisher/Qwen3.8-27B-4bit' };
export const OTHER = { id: 'ses_fixture_chat_b', title: 'Another secret title', busy: false, model: 'splish/publisher/Qwen3.8-27B-4bit' };

type Listener = (event: MessageEvent) => void;
export interface FakeHost {
  host: HostClient;
  ready(session: SessionSnapshot | null): void;
  session(session: SessionSnapshot | null): void;
  lifecycle(sessionId: string, phase: SessionLifecyclePhase): void;
  /** S2: each busy/idle transition re-sends `ready`, then the session, then the lifecycle phase (2–3 deliveries). */
  transition(session: SessionSnapshot, phase?: SessionLifecyclePhase): void;
  listeners(): number;
}

export const fakeHost = (): FakeHost => {
  const listeners = new Set<Listener>();
  const target = {
    addEventListener: (type: string, listener: Listener) => { if (type === 'message') listeners.add(listener); },
    removeEventListener: (type: string, listener: Listener) => { if (type === 'message') listeners.delete(listener); },
    parent: { postMessage: () => {} },
  };
  const host = connectHost({ target: target as never, acceptSource: () => true });
  const send = (type: string, payload: unknown) => {
    for (const listener of [...listeners]) listener(new MessageEvent('message', { data: { channel: 'openchamber.sdk', v: 1, type, payload } }));
  };
  const ready = (session: SessionSnapshot | null) => send('ready', { theme: { mode: 'dark', tokens: {} }, locale: 'en-US', directory: null, session,
    surface: 'status', connection: { connected: true, account: '' }, settings: {}, item: null });
  return {
    host, ready, session: session => send('session', { session }), lifecycle: (sessionId, phase) => send('session-lifecycle', { sessionId, phase }),
    transition: (session, phase = session.busy ? 'started' : 'completed') => {
      ready(session); send('session', { session }); send('session-lifecycle', { sessionId: session.id, phase });
    },
    listeners: () => listeners.size,
  };
};

export type Step = Partial<CompletionV2> & Pick<CompletionV2, 'seq' | 'finishedAt'>;
export const step = (value: Step): CompletionV2 => ({ startedAt: null, model: 'mlx-community/Qwen3.8-27B-4bit', basis: 'reported',
  overlapped: false, host: {}, outputTokens: 400, decodeTps: 40, ...value });

export interface BodyOptions {
  at: number;                                // runtime.sampledAt and serverNow
  active?: number | null;                    // null: no `server.requests` capability
  state?: 'ready' | 'degraded' | 'failing' | 'recovering';
  items?: CompletionV2[];
  instance?: string;
  connection?: string;                       // connection id (the provider)
  choices?: string[];
  models?: string[];                         // resident models
  nextPollMs?: number;
  stream?: boolean;                          // completions `reported` by an event stream
  generation?: number;
}

/** A minimal body, run through the real parser so tests see exactly what the panel's client accepts. */
export const body = (options: BodyOptions): SnapshotV2 => {
  const { at, active = 0, instance = INSTANCE, connection = 'splish', items = [] } = options;
  const capabilities: Record<string, unknown> = { 'server.completions': { scope: 'server', basis: options.stream ? 'reported' : 'last-observed' },
    'server.residency': { scope: 'server', basis: 'reported' } };
  if (active !== null) capabilities['server.requests'] = { scope: 'server', basis: 'reported' };
  const parsed = parseSnapshotV2({
    contractVersion: 2, serverNow: at, service: { version: '2.0.0', instance },
    connection: { id: connection, label: 'Splish', runtime: 'lmstudio', generation: options.generation ?? 1,
      choices: (options.choices ?? [connection]).map(id => ({ id, label: id, runtime: 'lmstudio' })), detection: { basis: 'hint', confidence: 'medium' } },
    status: { state: options.state ?? 'ready', reason: options.state === 'failing' ? 'runtime_unreachable' : null, params: {} },
    capabilities,
    runtime: { sampledAt: at, phase: active ? 'decode' : 'idle', request: null, server: { active: active ?? 0, queued: 0 }, memory: {},
      residency: (options.models ?? ['mlx-community/Qwen3.8-27B-4bit']).map(model => ({ model, phase: 'idle', source: 'runtime' })),
      slots: [], catalog: [], engines: [] },
    host: null, completions: { instance, cursor: items.at(-1)?.seq ?? 0, reset: false, items },
    marksHead: 0, alerts: [], alertLog: [], lease: { leader: true, epoch: 1, ttlMs: 12_000, leaderSurface: 'panel' }, nextPollMs: options.nextPollMs ?? 500,
  });
  if (!parsed) throw new Error('testing.body: the synthetic body does not parse');
  return parsed;
};

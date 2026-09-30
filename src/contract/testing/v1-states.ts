// Test support only: every 1.x reading the preview host (tests/browser/host.html) can show. The 1.x service clients are
// gone since the 2.0 adapters took over (service/adapters/*); their own fixture tests cover what the service reads.
import { readFileSync } from 'node:fs';
import type { SystemSnapshot } from '../../system.ts';
import type { TelemetrySnapshot } from '../../telemetry.ts';

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
  // The host answers `/v2/snapshot` through the bridge; an identity bridge hands back the 1.x reading it would convert.
  const bridge = { toSnapshotV2: (reading: unknown) => reading };
  new Function('window', 'document', 'location', 'sessionStorage', 'Date', 'ScopeConvert', HOST)(scope, { querySelector: () => ({ contentWindow }) },
    { search: `?${query}`, href: 'http://fixture.invalid/' }, storage, { now: () => now }, bridge);
  const payloads: TelemetrySnapshot[] = [];
  for (let step = 0; step < steps; step += 1, now += 500) {
    const before = replies.length;
    void listener!({ source: contentWindow, data: { channel: 'openchamber.sdk', type: 'service-request', id: step, payload: { method: 'GET', path: '/v2/snapshot' } } });
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

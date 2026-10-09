import { createChatObserver } from './demand.js';
import { COMPANION_VERSION, PROTOCOL } from './chat.js';
import { randomUUID } from 'node:crypto';
import { createStore, key } from './store.js';
import { observeStream } from './stream.js';

const SHARED = Symbol.for(`mlx-scope.prompt-progress.${COMPANION_VERSION}.${PROTOCOL}`);
const PATHS = new Set(['/v1/chat/completions', '/v1/responses', '/v1/messages']);
const KINDS = new Set(['primary', 'compaction', 'title', 'generate']);
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

function options(input = {}) {
  const providerID = typeof input.providerID === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(input.providerID) ? input.providerID : 'splish';
  const url = new URL(input.baseURL ?? 'http://127.0.0.1:8000/v1');
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/+$/, '') !== '/v1') throw new Error('MLX Scope progress requires a loopback Splash /v1 endpoint.');
  const canonical = new URL(url.origin); if (canonical.hostname === 'localhost') canonical.hostname = '127.0.0.1';
  return { providerID, origin: url.origin, endpointKey: key('endpoint', canonical.origin) };
}

function eligible(event, config) {
  if (event.model?.providerID !== config.providerID || !KINDS.has(event.kind)
    || typeof event.sessionID !== 'string' || event.sessionID.length === 0 || event.sessionID.length > 256
    || typeof event.model.id !== 'string' || event.model.id.length > 1024) return false;
  const request = event.request;
  try {
    const url = new URL(request.url);
    return request.method === 'POST' && url.origin === config.origin && PATHS.has(url.pathname.replace(/\/+$/, ''))
      && !url.search && !url.hash && !url.username && !url.password
      && request.headers.get('x-opencode-session-id') === event.sessionID
      && request.headers.get('content-type')?.toLowerCase().includes('application/json');
  } catch { return false; }
}

async function jsonBody(request) {
  if (Number(request.headers.get('content-length')) > MAX_REQUEST_BYTES) return null;
  const reader = request.clone().body?.getReader();
  if (!reader) return null;
  let length = 0; const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > MAX_REQUEST_BYTES) { void reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body = JSON.parse(new TextDecoder().decode(bytes));
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch { return null; } finally { reader.releaseLock(); }
}

export function makePlugin({ storeFactory = createStore, observerFactory = createChatObserver, shared = globalThis, warn = message => console.warn(message) } = {}) {
  return {
    id: 'mlx-scope-prompt-progress',
    async setup(ctx) {
      const config = ctx.options?.promptProgress === false ? null : options(ctx.options), active = new Map(), prepared = new WeakSet();
      const holder = shared[SHARED] ??= { store: storeFactory({ warn }), refs: 0 };
      holder.refs += 1;
      const store = holder.store;
      let detach;
      const registrations = [];
      let released = false;
      const teardown = async () => {
        if (released) return; released = true;
        try { detach?.(); } catch { /* Release remaining resources even if a host disposer fails. */ }
        for (const registration of registrations) try { await registration?.dispose?.(); } catch { /* passive cleanup */ }
        for (const close of active.values()) try { close(); } catch { /* passive cleanup */ }
        if (--holder.refs === 0) {
          if (shared[SHARED] === holder) delete shared[SHARED];
          try { await holder.chat?.close(); } finally { await store.close(); }
        }
      };
      try {
        if (ctx.app && ctx.event?.subscribe) {
          holder.chat ??= observerFactory({ warn });
          detach = await holder.chat.attach(ctx);
          registrations.push(await ctx.session.hook('http.request', event => holder.chat.authorizeHttp(event, ctx)));
          // Released 2.0.25 invokes this metadata hook for every model call, including socket reuse.
          // Observe the destination only; frames, headers and the socket itself remain untouched.
          if (ctx.app.version === '2.0.25') registrations.push(await ctx.session.hook('experimental.ws.handshake', event => holder.chat.authorizeWebSocket(event, ctx)));
        }
        if (config) {
          registrations.push(await ctx.session.hook('http.request', async event => {
            if (!eligible(event, config) || event.request.signal.aborted) return;
            const body = await jsonBody(event.request);
            if (!body || body.stream !== true || event.request.signal.aborted) return;
            const headers = new Headers(event.request.headers); headers.delete('content-length');
            event.request = new Request(event.request, { headers, body: JSON.stringify({ ...body, return_progress: true }) });
            prepared.add(event.request);
          }, { providerID: config.providerID }));
          registrations.push(await ctx.session.hook('http.response', event => {
            if (!eligible(event, config) || !prepared.has(event.request)) return;
            const requestID = randomUUID();
            const metadata = { requestID, sessionKey: key('session', event.sessionID), providerID: config.providerID,
              endpointKey: config.endpointKey, modelKey: key('model', event.model.id), kind: event.kind };
            event.response = observeStream(event.response, { metadata, store, signal: event.request.signal,
              onObserver: finish => active.set(requestID, finish), onClose: () => active.delete(requestID) });
          }, { providerID: config.providerID }));
        }
        return teardown;
      } catch (error) {
        try { await teardown(); } catch { /* Preserve the setup failure after releasing owned resources. */ }
        throw error;
      }
    },
  };
}

export default makePlugin();

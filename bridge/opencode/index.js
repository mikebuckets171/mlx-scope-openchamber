import { createChatObserver } from './demand.js';
import { COMPANION_VERSION, PROTOCOL } from './chat.js';
import { randomUUID } from 'node:crypto';
import { createStore, key } from './store.js';
import { observeStream } from './stream.js';
import { acceptsRuntime, featureSupport } from './compatibility.js';

const sharedKey = revision => Symbol.for(`mlx-scope.prompt-progress.${COMPANION_VERSION}.${PROTOCOL}.${typeof revision === 'string' && /^[a-f0-9]{64}$/.test(revision) ? revision : 'unmanaged'}`);
const PATHS = new Set(['/v1/chat/completions', '/v1/responses', '/v1/messages']);
const KINDS = new Set(['primary', 'compaction', 'title', 'generate']);
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
// Splash requests that stop carrying OpenCode's session header can no longer be matched to a chat.
const SESSION_HEADER_LIMIT = 3;

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

/** Whether a primary Splash call proves its chat. Other providers and unrelated requests prove nothing either way. */
function sessionHeader(event, config) {
  if (event.model?.providerID !== config.providerID || event.kind !== 'primary' || event.request?.method !== 'POST') return 'other';
  try {
    const url = new URL(event.request.url);
    if (url.origin !== config.origin || !PATHS.has(url.pathname.replace(/\/+$/, ''))) return 'other';
    return event.request.headers.get('x-opencode-session-id') ? 'present' : 'missing';
  } catch { return 'other'; }
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
      const SHARED = sharedKey(ctx.options?.scopeRevision);
      const active = new Map(), prepared = new WeakSet();
      const features = featureSupport(ctx.app?.version), accepted = acceptsRuntime(ctx.app?.version);
      let config = null, missingHeaders = 0;
      if (accepted && ctx.options?.promptProgress !== false) {
        try { config = options(ctx.options); }
        catch {
          features['prompt-progress'] = { support: 'unavailable', available: false, check: { state: 'failed', reason: 'options' } };
          warn('MLX Scope prompt progress options are unavailable; chat observation remains available.');
        }
      }
      const holder = shared[SHARED] ??= { store: storeFactory({ warn }), refs: 0 };
      holder.refs += 1;
      const store = holder.store;
      let detach;
      const registrations = [];
      const chatRegistrations = [];
      const install = async (id, action, chat = false) => {
        if (!accepted) return;
        const added = [], hookAPI = typeof ctx.session?.hook === 'function';
        try {
          if (!hookAPI) throw new Error('No hook API');
          await action(async (...args) => { const registration = await ctx.session.hook(...args); added.push(registration); });
          registrations.push(...added); if (chat) chatRegistrations.push(...added);
          features[id].available = true; features[id].check = { state: 'waiting' };
        } catch {
          for (const registration of added) try { await registration?.dispose?.(); } catch { /* release this feature only */ }
          features[id] = { support: 'unavailable', available: false, check: { state: 'failed', reason: hookAPI ? 'hook-rejected' : 'hook-missing' } };
          warn(`MLX Scope ${id} is unavailable; other monitoring remains available.`);
        }
      };
      /** Prompt-progress evidence is per helper load; a withdrawal stops request changes immediately. */
      const progress = (state, reason) => {
        const feature = features['prompt-progress'];
        if (!feature.available || feature.check?.state === state) return;
        if (state === 'failed') {
          Object.assign(feature, { available: false, check: { state, reason } });
          warn('MLX Scope prompt progress paused: OpenCode no longer identifies the chat on Splash requests. Chat estimates remain available.');
        } else feature.check = { state };
        void holder.chat?.report?.().catch(() => {});
      };
      const progressStore = { update: value => { progress('passed'); store.update(value); }, remove: requestID => store.remove(requestID) };
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
        if (ctx.app) {
          try { holder.chat ??= observerFactory({ warn }); }
          catch { warn('MLX Scope chat observation is unavailable; runtime monitoring remains available.'); }
          if (holder.chat && typeof ctx.event?.subscribe === 'function') {
            await install('http-delivery', hook => hook('http.request', event => holder.chat.authorizeHttp(event, ctx)), true);
            // This experimental adapter is qualified independently, including per-call metadata on reused sockets.
            await install('websocket-delivery', hook => hook('experimental.ws.handshake', event => holder.chat.authorizeWebSocket(event, ctx)), true);
          } else if (accepted) for (const id of ['http-delivery', 'websocket-delivery'])
            features[id] = holder.chat ? { support: 'unavailable', available: false, check: { state: 'failed', reason: 'events-missing' } }
              : { support: 'unavailable', available: false };
        }
        if (config) {
          await install('prompt-progress', async hook => {
          await hook('http.request', async event => {
            if (released || !features['prompt-progress'].available) return;
            const proof = sessionHeader(event, config);
            if (proof === 'present') missingHeaders = 0;
            else if (proof === 'missing' && ++missingHeaders >= SESSION_HEADER_LIMIT) { progress('failed', 'session-header'); return; }
            if (!eligible(event, config) || event.request.signal.aborted) return;
            const body = await jsonBody(event.request);
            if (!body || body.stream !== true || event.request.signal.aborted) return;
            const headers = new Headers(event.request.headers); headers.delete('content-length');
            event.request = new Request(event.request, { headers, body: JSON.stringify({ ...body, return_progress: true }) });
            prepared.add(event.request);
          }, { providerID: config.providerID });
          await hook('http.response', event => {
            if (released) return;
            if (!eligible(event, config) || !prepared.has(event.request)) return;
            const requestID = randomUUID();
            const metadata = { requestID, sessionKey: key('session', event.sessionID), providerID: config.providerID,
              endpointKey: config.endpointKey, modelKey: key('model', event.model.id), kind: event.kind };
            event.response = observeStream(event.response, { metadata, store: progressStore, signal: event.request.signal,
              onObserver: finish => active.set(requestID, finish), onClose: () => active.delete(requestID) });
          }, { providerID: config.providerID });
          });
        }
        // An accepted watcher contract is not proof that this process activated a newly installed revision.
        if (ctx.app && holder.chat) {
          try { detach = await holder.chat.attach(ctx, features); }
          catch {
            for (const registration of chatRegistrations) {
              registrations.splice(registrations.indexOf(registration), 1);
              try { await registration?.dispose?.(); } catch { /* leave the prompt observer intact */ }
            }
            for (const id of ['http-delivery', 'websocket-delivery']) features[id] = { support: 'unavailable', available: false, check: { state: 'failed', reason: 'events-missing' } };
            warn('MLX Scope chat observation is unavailable; runtime monitoring remains available.');
          }
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

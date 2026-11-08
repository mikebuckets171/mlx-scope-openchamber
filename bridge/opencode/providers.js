import { key } from './store.js';

const PROVIDER_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const LM_STUDIO = /bionic|lm[\s_-]*studio/;

/**
 * The same id/name rule the service uses to call a connection Splash (service/core/hints.ts), including the LM Studio
 * rule that takes precedence over it; a test keeps the two together.
 */
export const namesSplash = (id, name) => !LM_STUDIO.test(`${id} ${name}`.toLowerCase())
  && (id.trim().toLowerCase() === 'splash' || /splash/i.test(name) || /splish/i.test(`${id} ${name}`));

/** A Splash provider's loopback `/v1` endpoint. Throws when the address is not one Scope may read or alter. */
export function splashOptions(input = {}) {
  const providerID = typeof input.providerID === 'string' && PROVIDER_ID.test(input.providerID) ? input.providerID : 'splish';
  const url = new URL(input.baseURL ?? 'http://127.0.0.1:8000/v1');
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/+$/, '') !== '/v1') throw new Error('MLX Scope progress requires a loopback Splash /v1 endpoint.');
  const canonical = new URL(url.origin); if (canonical.hostname === 'localhost') canonical.hostname = '127.0.0.1';
  return { providerID, origin: url.origin, endpointKey: key('endpoint', canonical.origin) };
}

/** Only a provider's id, name and base URL are read from OpenCode's list. Its settings hold keys; nothing else is touched. */
function splashConfig(row) {
  const id = typeof row?.id === 'string' ? row.id : '', name = typeof row?.name === 'string' ? row.name : '';
  if (!PROVIDER_ID.test(id) || !namesSplash(id, name)) return null;
  try { return splashOptions({ providerID: id, baseURL: row.settings?.baseURL }); } catch { return null; }
}

const waitFor = (promise, ms) => {
  let timer;
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer));
};

/**
 * Which providers are Splash, read from OpenCode when a request arrives. OpenCode loads configured providers after its
 * plugins start (a plugin sees only its own at setup), so the list is read lazily and kept for `ttlMs`. Requests that
 * arrive during the very first read share one wait of at most `firstWaitMs`; every other lookup answers at once from the
 * last read while a fresh one runs behind it, even if the list never answers. A failed read changes nothing and is
 * retried after `retryMs`. A lookup never throws.
 */
export function createSplashLookup({ list, now = Date.now, ttlMs = 30_000, retryMs = 5_000, firstWaitMs = 750 }) {
  let snapshot = null, flight = null, attemptedAt = -Infinity, firstWait = null;
  const refresh = () => flight ??= (async () => {
    attemptedAt = now();
    try {
      const byId = new Map();
      for (const row of (await list()).slice(0, 256)) if (typeof row?.id === 'string') byId.set(row.id, splashConfig(row));
      snapshot = { at: now(), byId };
    } catch { /* keep the last read; the next attempt is at least retryMs away */ }
    finally { flight = null; }
  })();
  return async providerID => {
    if (typeof providerID !== 'string' || !PROVIDER_ID.test(providerID)) return null;
    // A provider the last read did not list may have just been added; look again, but never more often than retryMs.
    if (now() - attemptedAt >= retryMs && (!snapshot || now() - snapshot.at >= ttlMs || !snapshot.byId.has(providerID))) void refresh();
    if (!snapshot && flight) await (firstWait ??= waitFor(flight, firstWaitMs));
    return snapshot?.byId.get(providerID) ?? null;
  };
}

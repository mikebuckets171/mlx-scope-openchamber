import { CHAT_DIRECTORY, HASH, readPrivateJSON, atomicPrivateJSON, createChatStore } from './chat-store.js';
import { COMPANION_VERSION, PROTOCOL, createChatTracker } from './chat.js';

export function parseDemand(value, now = Date.now()) {
  if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.updatedAtMs) || !Number.isSafeInteger(value.expiresAtMs)
    || value.updatedAtMs < 0 || value.updatedAtMs > now || value.expiresAtMs <= now
    || value.expiresAtMs - value.updatedAtMs > 15_000 || !Array.isArray(value.watched) || value.watched.length > 16) return [];
  const seen = new Set(), watched = [];
  for (const item of value.watched) {
    if (!item || !HASH.test(item.sessionKey) || !HASH.test(item.providerKey) || !HASH.test(item.modelKey)) return [];
    const match = `${item.sessionKey}:${item.providerKey}:${item.modelKey}`;
    if (!seen.has(match)) { seen.add(match); watched.push({ sessionKey: item.sessionKey, providerKey: item.providerKey, modelKey: item.modelKey }); }
  }
  return watched;
}

/** One demand poll and at most one public subscription per OpenCode process, across plugin locations. */
export function createChatObserver({ directory = CHAT_DIRECTORY, now = Date.now, warn = () => {},
  storeFactory = createChatStore, readDemand = () => readPrivateJSON(directory, 'demand.json'),
  heartbeat = value => atomicPrivateJSON(directory, 'heartbeat.json', value), intervalMs = 1_000 } = {}) {
  const clients = new Map(); let store, tracker, timer, running = false, closed = false, controller, subscriptionClient, lastHeartbeat = -Infinity;
  const info = ctx => ({ schemaVersion: 1, companionVersion: COMPANION_VERSION,
    protocol: ctx.app?.version === '2.0.25' ? PROTOCOL : 'unsupported',
    runtimeVersion: typeof ctx.app?.version === 'string' && /^\d+\.\d+\.\d+(?:[-.\w]*)?$/.test(ctx.app.version) ? ctx.app.version.slice(0, 80) : 'unknown',
    loadedAtMs: now(), supported: ctx.app?.version === '2.0.25' && typeof ctx.event?.subscribe === 'function' });
  let loadedInfo;
  function stop() {
    controller?.abort(); controller = undefined; subscriptionClient = undefined;
    tracker?.clear();
  }
  function subscribe(client) {
    const current = new AbortController(); controller = current; subscriptionClient = client;
    void (async () => {
      try {
        for await (const event of client.event.subscribe({ signal: current.signal })) {
          if (current.signal.aborted || controller !== current) break;
          tracker.event(event);
        }
      } catch { /* Subscription failures never escape into inference; next demand tick retries. */ }
      finally {
        if (controller === current) { controller = undefined; subscriptionClient = undefined; tracker.clear(); }
      }
    })();
  }
  async function tick() {
    if (running || closed || clients.size === 0) return;
    running = true;
    try {
      const demand = parseDemand(await readDemand().catch(() => null), now());
      const client = [...clients.values()].find(ctx => info(ctx).supported);
      if (!demand.length || !client) { stop(); await store?.flush(); return; }
      tracker.setWatched(demand); tracker.tick();
      if (!controller || !clients.has(subscriptionClient)) {
        if (controller) stop();
        tracker.setWatched(demand); subscribe(client);
      }
      if (now() - lastHeartbeat >= 5_000) {
        lastHeartbeat = now(); await heartbeat({ ...loadedInfo, updatedAtMs: now(), expiresAtMs: now() + 15_000 }).catch(() => {});
      }
      await store.flush();
    } finally { running = false; }
  }
  return {
    async attach(ctx) {
      if (closed) throw new Error('Closed observer');
      clients.set(ctx, ctx);
      if (!store) {
        loadedInfo = info(ctx);
        store = storeFactory({ directory, now, warn, runtimeVersion: loadedInfo.runtimeVersion });
        tracker = createChatTracker({ now, publish: value => store.update(value), remove: key => store.remove(key) });
        await heartbeat(loadedInfo).catch(() => {});
        timer = setInterval(() => void tick().catch(() => {}), intervalMs); timer.unref?.();
      }
      await tick();
      return () => { clients.delete(ctx); if (subscriptionClient === ctx) stop(); };
    },
    authorizeHttp(event) { tracker?.authorizeHttp(event); },
    tick,
    async close() { closed = true; clearInterval(timer); stop(); clients.clear(); await store?.close(); },
  };
}

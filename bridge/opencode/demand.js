import { key } from './store.js';
import { CHAT_DIRECTORY, HASH, readPrivateJSON, atomicPrivateJSON, createChatStore } from './chat-store.js';
import { COMPANION_VERSION, PROTOCOL, MAX_CHATS, createChatTracker } from './chat.js';

export function parseDemand(value, now = Date.now()) {
  if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.updatedAtMs) || !Number.isSafeInteger(value.expiresAtMs)
    || value.updatedAtMs < 0 || value.updatedAtMs > now || value.expiresAtMs <= now
    || value.expiresAtMs - value.updatedAtMs > 15_000 || !Array.isArray(value.watched) || value.watched.length > 16) return [];
  const seen = new Set(), watched = [];
  for (const item of value.watched) {
    if (!item || !HASH.test(item.sessionKey) || !HASH.test(item.providerKey) || !HASH.test(item.modelKey)) return [];
    if (item.destination !== undefined && item.destination !== 'remote') return [];
    const match = `${item.sessionKey}:${item.providerKey}:${item.modelKey}:${item.destination ?? 'local'}`;
    if (!seen.has(match)) { seen.add(match); watched.push({ sessionKey: item.sessionKey, providerKey: item.providerKey, modelKey: item.modelKey,
      ...item.destination === 'remote' ? { destination: 'remote' } : {} }); }
  }
  return watched;
}

const locationKey = ctx => typeof ctx.location?.directory === 'string'
  ? key('location', `${ctx.location.directory}\0${ctx.location.workspaceID ?? ''}`) : 'legacy-test-context';

/** One demand poll/store per process; public event subscriptions are shared per qualified OpenCode Location. */
export function createChatObserver({ directory = CHAT_DIRECTORY, now = Date.now, warn = () => {},
  storeFactory = createChatStore, readDemand = () => readPrivateJSON(directory, 'demand.json'),
  heartbeat = value => atomicPrivateJSON(directory, 'heartbeat.json', value), intervalMs = 1_000 } = {}) {
  const clients = new Map(), locations = new Map(); let store, timer, flight, closed = false, lastHeartbeat = -Infinity;
  const info = ctx => ({ schemaVersion: 1, companionVersion: COMPANION_VERSION,
    protocol: ctx.app?.version === '2.0.25' ? PROTOCOL : 'unsupported',
    runtimeVersion: typeof ctx.app?.version === 'string' && /^\d+\.\d+\.\d+(?:[-.\w]*)?$/.test(ctx.app.version) ? ctx.app.version.slice(0, 80) : 'unknown',
    loadedAtMs: now(), supported: ctx.app?.version === '2.0.25' && typeof ctx.event?.subscribe === 'function' });
  let loadedInfo;
  const counters = () => ({ primary: 0, primarySession: 0, primaryMatch: 0, events: 0, steps: 0, deltas: 0, lastEventAtMs: 0, lastPrimaryAtMs: 0 });
  const bump = (value, name) => { value[name] = Math.min(1_000_000, value[name] + 1); };
  function stop(location) {
    location.controller?.abort(); location.controller = undefined; location.client = undefined;
    location.tracker?.clear();
  }
  function subscribe(location, client) {
    const current = new AbortController(); location.controller = current; location.client = client;
    void (async () => {
      try {
        for await (const event of client.event.subscribe({ signal: current.signal })) {
          if (current.signal.aborted || location.controller !== current) break;
          if (typeof event?.data?.sessionID === 'string' && location.watched.some(item => item.sessionKey === key('session', event.data.sessionID))) {
            bump(location.counters, 'events'); location.counters.lastEventAtMs = now();
            if (event.type === 'session.step.started') bump(location.counters, 'steps');
            if (event.type === 'session.text.delta' || event.type === 'session.reasoning.delta') bump(location.counters, 'deltas');
          }
          location.tracker.event(event);
        }
      } catch { /* Subscription failures never escape into inference; next demand tick retries. */ }
      finally {
        if (location.controller === current) { location.controller = undefined; location.client = undefined; location.tracker.clear(); }
      }
    })();
  }
  async function collect() {
    if (closed || clients.size === 0) return;
    const demand = parseDemand(await readDemand().catch(() => null), now());
    const selected = new Set(demand.length ? [...locations.values()]
      .filter(location => [...location.clients].some(ctx => info(ctx).supported))
      .sort((a, b) => b.priority - a.priority).slice(0, MAX_CHATS) : []);
    for (const location of locations.values()) {
      location.watched = demand;
      if (!selected.has(location)) { stop(location); location.counters = counters(); continue; }
      const client = [...location.clients].find(ctx => info(ctx).supported);
      location.tracker ??= createChatTracker({ now, publish: value => store.update(value), remove: session => store.remove(session) });
      location.tracker.setWatched(demand); location.tracker.tick();
      if (!location.controller || !location.clients.has(location.client)) {
        if (location.controller) stop(location);
        location.tracker.setWatched(demand); subscribe(location, client);
      }
    }
    if (selected.size && now() - lastHeartbeat >= 5_000) {
      lastHeartbeat = now(); await heartbeat({ ...loadedInfo, updatedAtMs: now(), expiresAtMs: now() + 15_000,
        diagnostics: { locations: locations.size, watched: demand.length, subscriptions: [...selected].filter(item => item.controller).length,
          observers: [...selected].map(item => ({ ...item.counters, ...item.tracker.stats() })) } }).catch(() => {});
    }
    await store?.flush();
  }
  function tick() {
    if (flight) return flight;
    const current = collect().finally(() => { if (flight === current) flight = undefined; });
    flight = current; return current;
  }
  async function authorize(method, event, ctx) {
    if (closed || event?.kind !== 'primary') return;
    const location = clients.get(ctx) ?? (ctx === undefined ? locations.values().next().value : undefined);
    if (!location || ![...location.clients].some(client => info(client).supported)) return;
    if (event?.kind === 'primary') location.priority = now();
    // A visible view may publish demand immediately before dispatch, before the periodic poll.
    // Await any prior read, then refresh now. Never delay inference for observer failures.
    try {
      if (flight) await flight; await tick();
      if (location.watched.length) {
        const value = location.counters; bump(value, 'primary'); value.lastPrimaryAtMs = now();
        if (typeof event.sessionID === 'string') {
          const sessionKey = key('session', event.sessionID), matching = location.watched.filter(item => item.sessionKey === sessionKey);
          if (matching.length) bump(value, 'primarySession');
          if (typeof event.model?.providerID === 'string' && typeof event.model?.id === 'string' && matching.some(item =>
            item.providerKey === key('provider', event.model.providerID) && item.modelKey === key('model', event.model.id))) bump(value, 'primaryMatch');
        }
      }
      location.tracker?.[method](event);
    } catch { /* passive observer */ }
  }
  return {
    async attach(ctx) {
      if (closed) throw new Error('Closed observer');
      const id = locationKey(ctx);
      let location = locations.get(id);
      if (!location) { location = { clients: new Set(), priority: 0, watched: [], counters: counters() }; locations.set(id, location); }
      location.clients.add(ctx); clients.set(ctx, location);
      const detach = () => {
        clients.delete(ctx); location.clients.delete(ctx);
        if (location.client === ctx) stop(location);
        if (!location.clients.size) { stop(location); locations.delete(id); }
      };
      try {
        if (!store) {
          loadedInfo = info(ctx);
          store = storeFactory({ directory, now, warn, runtimeVersion: loadedInfo.runtimeVersion });
          await heartbeat(loadedInfo).catch(() => {});
          timer = setInterval(() => void tick().catch(() => {}), intervalMs); timer.unref?.();
        }
        await tick();
        return detach;
      } catch (error) { detach(); throw error; }
    },
    authorizeHttp(event, ctx) { return authorize('authorizeHttp', event, ctx); },
    authorizeWebSocket(event, ctx) { return authorize('authorizeWebSocket', event, ctx); },
    tick,
    async close() { closed = true; clearInterval(timer); if (flight) await flight.catch(() => {});
      for (const location of locations.values()) stop(location); clients.clear(); locations.clear(); await store?.close(); },
  };
}

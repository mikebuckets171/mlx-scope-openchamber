import { key } from './store.js';
import { CHAT_DIRECTORY, HASH, readPrivateJSON, atomicPrivateJSON, createChatStore } from './chat-store.js';
import { COMPANION_VERSION, PROTOCOL, MAX_CHATS, createChatTracker } from './chat.js';
import { acceptsRuntime, featureSupport } from './compatibility.js';

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

const REFUSALS = { permissions: 'not private to this account', owner: 'owned by another account', type: 'not a regular file',
  size: 'too large', access: 'unreadable' };
const DELIVERY = ['http-delivery', 'websocket-delivery'];
// Three released-schema violations with no completed step between them withdraw delivery for this process.
const SHAPE_LIMIT = 3;
// After demand stops, keep the quick cadence briefly so a returning view resumes at once.
const DEMAND_LINGER_MS = 15_000;
const locationKey = ctx => typeof ctx.location?.directory === 'string'
  ? key('location', `${ctx.location.directory}\0${ctx.location.workspaceID ?? ''}`) : 'legacy-test-context';

/**
 * One demand poll/store per process; public event subscriptions are shared per accepted OpenCode Location.
 * The poll runs every second only while a view demands telemetry; otherwise every five. A primary dispatch refreshes
 * demand itself, so the slower idle cadence never delays the first observed step.
 */
export function createChatObserver({ directory = CHAT_DIRECTORY, now = Date.now, warn = () => {},
  storeFactory = createChatStore, readDemand = rejected => readPrivateJSON(directory, 'demand.json', undefined, rejected),
  heartbeat = value => atomicPrivateJSON(directory, 'heartbeat.json', value), intervalMs = 1_000, idleIntervalMs = Math.max(intervalMs, 5_000) } = {}) {
  const clients = new Map(), locations = new Map(), availability = new WeakMap(), featureSets = new Set(), checks = new Map();
  let store, timer, flight, closed = false, lastHeartbeat = -Infinity, refused = false, lastDemandAt = -Infinity, shapeFailures = 0, live = false;
  // A refused demand file looks like "no demand" to tracking. Say so once in the host log; never name paths or contents.
  const rejected = reason => { if (refused) return; refused = true;
    warn(`MLX Scope chat tracking ignored its demand file (${REFUSALS[reason] ?? REFUSALS.access}); chat estimates stay off until Scope rewrites it.`); };
  /** Running checks are process-wide: every Location in this OpenCode process shares the same event contract. */
  const applyCheck = (features, id, check) => {
    const feature = features[id]; if (!feature || feature.check?.state === 'failed') return;
    if (check.state === 'failed') Object.assign(feature, { available: false, check });
    else if (feature.available) feature.check = check;
  };
  const info = ctx => {
    const features = availability.get(ctx) ?? featureSupport(ctx.app?.version), accepted = acceptsRuntime(ctx.app?.version);
    // Direct observer callers supply the event/dispatch adapter themselves; the plugin passes actual hook results.
    if (!availability.has(ctx) && accepted) for (const id of DELIVERY) if (features[id].check?.state !== 'failed') {
      features[id].available = true; features[id].check ??= { state: 'waiting' };
    }
    if (!availability.has(ctx)) for (const [id, check] of checks) applyCheck(features, id, check);
    return { schemaVersion: 1, companionVersion: COMPANION_VERSION,
    protocol: accepted ? PROTOCOL : 'unsupported', features,
    runtimeVersion: typeof ctx.app?.version === 'string' && /^\d+\.\d+\.\d+(?:[-.\w]*)?$/.test(ctx.app.version) ? ctx.app.version.slice(0, 80) : 'unknown',
    loadedAtMs: now(), supported: accepted && typeof ctx.event?.subscribe === 'function'
      && (features['http-delivery'].available || features['websocket-delivery'].available) };
  };
  const beat = async () => {
    const client = [...clients.keys()].find(ctx => info(ctx).supported) ?? clients.keys().next().value;
    if (!client || !loadedInfo) return;
    lastHeartbeat = now();
    await heartbeat({ ...info(client), loadedAtMs: loadedInfo.loadedAtMs, ...live ? { updatedAtMs: now(), expiresAtMs: now() + 15_000 } : {} }).catch(() => {});
  };
  /** Contract evidence from a tracker. A failure is final for this process; the next helper load checks again. */
  const verdict = (kind, transport) => {
    let changed = [];
    if (kind === 'passed' && DELIVERY.includes(transport)) { shapeFailures = 0; changed = [[transport, { state: 'passed' }]]; }
    else if (kind === 'event-shape' && ++shapeFailures >= SHAPE_LIMIT) {
      changed = DELIVERY.map(id => [id, { state: 'failed', reason: 'event-shape' }]);
      warn('MLX Scope chat estimates paused: OpenCode events no longer match the expected shape. Runtime monitoring remains available.');
    }
    changed = changed.filter(([id, check]) => checks.get(id)?.state !== 'failed' && checks.get(id)?.state !== check.state);
    if (!changed.length) return;
    for (const [id, check] of changed) { checks.set(id, check); for (const features of featureSets) applyCheck(features, id, check); }
    void beat();
  };
  let loadedInfo;
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
    if (![...clients.keys()].some(ctx => info(ctx).supported)) {
      for (const location of locations.values()) stop(location);
      return;
    }
    const demand = parseDemand(await readDemand(rejected).catch(error => {
      // Absence is the normal idle state; any other failure leaves tracking off just as silently, so report it once.
      if (error?.code !== 'ENOENT') rejected(error?.message === 'Unsafe cache permissions' ? 'permissions' : 'access');
      return null;
    }), now());
    if (demand.length) lastDemandAt = now();
    const selected = new Set(demand.length ? [...locations.values()]
      .filter(location => [...location.clients].some(ctx => info(ctx).supported))
      .sort((a, b) => b.priority - a.priority).slice(0, MAX_CHATS) : []);
    for (const location of locations.values()) {
      if (!selected.has(location)) { stop(location); continue; }
      const client = [...location.clients].find(ctx => info(ctx).supported);
      location.tracker ??= createChatTracker({ now, publish: value => store.update(value), remove: session => store.remove(session), check: verdict });
      location.tracker.setWatched(demand); location.tracker.tick();
      if (!location.controller || !location.clients.has(location.client)) {
        if (location.controller) stop(location);
        location.tracker.setWatched(demand); subscribe(location, client);
      }
    }
    live = selected.size > 0;
    if (live && now() - lastHeartbeat >= 5_000) await beat();
    await store?.flush();
  }
  function schedule() {
    if (closed || timer === undefined) return;
    clearTimeout(timer);
    timer = setTimeout(() => { void tick().catch(() => {}).finally(schedule); }, now() - lastDemandAt < DEMAND_LINGER_MS ? intervalMs : idleIntervalMs);
    timer.unref?.();
  }
  function tick() {
    if (flight) return flight;
    const current = collect().finally(() => { if (flight === current) flight = undefined; });
    flight = current; return current;
  }
  async function authorize(method, event, ctx) {
    if (closed || event?.kind !== 'primary') return;
    const features = ctx && availability.get(ctx);
    if (features && !features[method === 'authorizeHttp' ? 'http-delivery' : 'websocket-delivery'].available) return;
    const location = clients.get(ctx) ?? (ctx === undefined ? locations.values().next().value : undefined);
    if (!location || ![...location.clients].some(client => info(client).supported)) return;
    if (event?.kind === 'primary') location.priority = now();
    // A visible view may publish demand immediately before dispatch, before the periodic poll.
    // Await any prior read, then refresh now. Never delay inference for observer failures.
    try { if (flight) await flight; await tick(); location.tracker?.[method](event); } catch { /* passive observer */ }
  }
  return {
    async attach(ctx, features) {
      if (closed) throw new Error('Closed observer');
      if (features) {
        availability.set(ctx, features); featureSets.add(features);
        for (const [id, check] of checks) applyCheck(features, id, check);
      }
      const id = locationKey(ctx);
      let location = locations.get(id);
      if (!location) { location = { clients: new Set(), priority: 0 }; locations.set(id, location); }
      location.clients.add(ctx); clients.set(ctx, location);
      const detach = () => {
        clients.delete(ctx); location.clients.delete(ctx); if (features) featureSets.delete(features);
        if (location.client === ctx) stop(location);
        if (!location.clients.size) { stop(location); locations.delete(id); }
      };
      try {
        if (!store) {
          loadedInfo = info(ctx);
          store = storeFactory({ directory, now, warn, runtimeVersion: loadedInfo.runtimeVersion });
          await heartbeat(loadedInfo).catch(() => {});
        }
        if (timer === undefined && info(ctx).supported) { timer = null; schedule(); }
        await tick();
        return detach;
      } catch (error) { detach(); throw error; }
    },
    authorizeHttp(event, ctx) { return authorize('authorizeHttp', event, ctx); },
    authorizeWebSocket(event, ctx) { return authorize('authorizeWebSocket', event, ctx); },
    tick,
    /** Publish a feature's changed check now, rather than at the next live heartbeat. */
    report: () => beat(),
    async close() { closed = true; clearTimeout(timer); if (flight) await flight.catch(() => {});
      for (const location of locations.values()) stop(location); clients.clear(); locations.clear(); await store?.close(); },
  };
}

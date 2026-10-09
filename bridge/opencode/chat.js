import { key } from './store.js';

export const WINDOW_MS = 5_000;
export const MIN_WINDOW_MS = 2_000;
export const MAX_CHATS = 16;
export const PROTOCOL = 'opencode-2.0.25';
export const COMPANION_VERSION = '3.0.0';
const MAX_PARTS = 64, MAX_CHARACTERS = 10_000_000, MAX_DELTA = 65_536;
const safe = value => Number.isSafeInteger(value) && value >= 0;
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 1024;
const identity = data => ({ sessionKey: key('session', data.sessionID), providerKey: key('provider', data.model.providerID), modelKey: key('model', data.model.id) });
export const watchKey = item => `${item.sessionKey}:${item.providerKey}:${item.modelKey}`;
export function loopbackEndpoint(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash) return null;
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    return key('endpoint', url.origin);
  } catch { return null; }
}
/** Classify only the observed primary destination. Query strings are never retained or hashed (cloud URLs may carry keys). */
export function observedEndpoint(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return null;
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      const endpointKey = loopbackEndpoint(value);
      return endpointKey ? { endpointKey } : null;
    }
    return { endpointKey: key('endpoint', url.origin), destination: 'remote' };
  } catch { return null; }
}

// Unicode code points, including surrogate pairs split across event deltas. No text is retained.
function characters(text, state) {
  let n = 0, offset = 0;
  if (state.high) { n++; if (text.charCodeAt(0) >= 0xdc00 && text.charCodeAt(0) <= 0xdfff) offset = 1; state.high = false; }
  for (let i = offset; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 === text.length) { state.high = true; break; }
      const next = text.charCodeAt(i + 1); if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/** A bounded fold of the released 2.0.25 public events. Never stores event objects, deltas, or tool payloads. */
export function createChatTracker({ now = Date.now, publish = () => {}, remove = () => {} } = {}) {
  const watched = new Map(), routes = new Map(), chats = new Map(), calibration = new Map();
  const drop = sessionKey => { chats.delete(sessionKey); remove(sessionKey); };
  const resetWindow = state => { state.points = []; state.firstAt = undefined; state.lastDelta = undefined; };
  const clear = () => { for (const sessionKey of chats.keys()) drop(sessionKey); routes.clear(); watched.clear(); };
  function setWatched(items) {
    watched.clear();
    for (const item of items.slice(0, MAX_CHATS)) {
      const match = watchKey(item), destinations = watched.get(match) ?? new Set();
      destinations.add(item.destination ?? 'local'); watched.set(match, destinations);
    }
    for (const [sessionKey, state] of chats) if (!watched.has(state.match) || state.endpointKey && !watched.get(state.match).has(state.destination ?? 'local')) drop(sessionKey);
    for (const [match, route] of routes) if (!watched.has(match) || !watched.get(match).has(route.destination ?? 'local')) routes.delete(match);
  }
  function authorizeHttp(event) {
    // Corroborate the actual primary HTTP destination, not a provider name or inferred model alias.
    if (!watched.size || event.kind !== 'primary' || !id(event.sessionID) || !id(event.model?.providerID) || !id(event.model?.id)) return;
    const match = watchKey(identity(event)); if (!watched.has(match)) return;
    const endpoint = event.request?.method === 'POST' ? observedEndpoint(event.request.url) : null;
    if (!endpoint || !watched.get(match).has(endpoint.destination ?? 'local') || event.request.signal?.aborted) { routes.delete(match); drop(key('session', event.sessionID)); return; }
    if (routes.size >= MAX_CHATS && !routes.has(match)) return;
    const state = chats.get(key('session', event.sessionID));
    if (state?.match === match && !state.endpointKey) {
      state.endpointKey = endpoint.endpointKey; state.destination = endpoint.destination;
      state.calibrationKey = `${state.identity.providerKey}:${state.identity.modelKey}:${endpoint.endpointKey}`;
      emit(state, 'waiting'); return;
    }
    // A second primary dispatch to another destination cannot reuse the previous step's delivery window.
    if (state?.match === match && (state.endpointKey !== endpoint.endpointKey || state.destination !== endpoint.destination)) drop(key('session', event.sessionID));
    routes.set(match, { ...endpoint, at: now() });
  }
  const ratioFor = state => {
    const steps = calibration.get(state.calibrationKey) ?? [];
    return { ratio: steps.length >= 3 ? steps.reduce((n, step) => n + step.characters, 0) / steps.reduce((n, step) => n + step.tokens, 0) : 4,
      steps: steps.length >= 3 ? steps.length : 0 };
  };
  function emit(state, phase, rate, interval, reported = false) {
    const time = now(), fit = ratioFor(state);
    const measurement = { scope: 'chat', basis: reported ? 'reported-output' : fit.steps ? 'calibrated-characters' : 'estimated-characters',
      timingBasis: reported ? 'completed-step' : 'delivery-window', phase, freshness: reported ? 'last' : 'live',
      observedAtMs: time, expiresAtMs: time + (reported ? 15_000 : WINDOW_MS),
      observation: interval ?? { startedAtMs: time, endedAtMs: time },
      ...(Number.isFinite(rate) && rate >= 0 ? { tokensPerSecond: rate } : {}),
      ...(!reported && fit.steps ? { calibrationSteps: fit.steps } : {}) };
    state.phase = phase; state.updated = time; state.stale = false;
    publish({ ...state.identity, endpointKey: state.endpointKey, ...state.destination === 'remote' ? { destination: 'remote' } : {}, measurement });
  }
  function sample(state, amount, phase) {
    const time = now();
    if (state.lastDelta !== undefined && (time - state.lastDelta >= WINDOW_MS || time < state.lastDelta)) {
      resetWindow(state); state.eligible = false;
    }
    state.firstAt ??= time; state.lastDelta = time; state.total += amount;
    const last = state.points.at(-1);
    // At most 52 buckets, independent of provider event frequency.
    if (last && Math.floor(last.at / 100) === Math.floor(time / 100)) { last.at = time; last.total = state.total; }
    else state.points.push({ at: time, total: state.total });
    const start = Math.max(state.firstAt, time - WINDOW_MS);
    while (state.points.length > 2 && state.points[1].at <= start) state.points.shift();
    let baseline = state.points[0].total;
    const [first, second] = state.points;
    if (second && first.at < start) baseline += (second.total - first.total) * (start - first.at) / (second.at - first.at);
    const duration = time - start, fit = ratioFor(state);
    emit(state, phase, duration >= MIN_WINDOW_MS ? (state.total - baseline) / fit.ratio * 1000 / duration : undefined,
      { startedAtMs: start, endedAtMs: time });
  }
  function event(input) {
    if (!input || typeof input.type !== 'string' || !input.data || !id(input.data.sessionID)) return;
    const data = input.data, type = input.type, sessionKey = key('session', data.sessionID), time = now();
    // Incoming old envelopes or future/invalid clocks cannot contribute observations.
    if (!safe(input.created) || input.created > time || time - input.created > WINDOW_MS) { drop(sessionKey); return; }
    const state = chats.get(sessionKey);
    if (type === 'session.step.started') {
      drop(sessionKey);
      if (!id(data.model?.providerID) || !id(data.model?.id) || !id(data.assistantMessageID)
        || !safe(data.started) || data.started > time) return;
      const ident = identity(data), match = watchKey(ident), route = routes.get(match);
      if (!watched.has(match) || route && (!watched.get(match).has(route.destination ?? 'local') || time - route.at > 600_000) || chats.size >= MAX_CHATS) return;
      routes.delete(match); // One HTTP dispatch proves one step, never a later unobserved route.
      const next = { identity: ident, match, endpointKey: route?.endpointKey, destination: route?.destination,
        calibrationKey: route ? `${ident.providerKey}:${ident.modelKey}:${route.endpointKey}` : undefined,
        assistantKey: key('assistant', data.assistantMessageID), started: data.started,
        seen: new Set(), parts: new Map(), total: 0, text: 0, reasoning: 0, points: [], eligible: true, updated: time };
      chats.set(sessionKey, next); if (route) emit(next, 'waiting'); return;
    }
    if (!state) return;
    if (!state.endpointKey) { if (!type.startsWith('session.step.')) drop(sessionKey); return; }
    if (!id(input.id)) { drop(sessionKey); return; }
    const eventKey = key('event', input.id);
    if (state.seen.has(eventKey)) return;
    state.seen.add(eventKey); if (state.seen.size > 256) state.seen.delete(state.seen.values().next().value);
    if (['session.model.selected', 'session.agent.selected', 'session.deleted', 'session.moved', 'session.compaction.started',
      'session.execution.started', 'session.retry.scheduled', 'session.revert.committed'].includes(type)) { drop(sessionKey); return; }
    if (['session.execution.interrupted', 'session.execution.failed', 'session.step.failed'].includes(type)) {
      resetWindow(state); state.eligible = false; emit(state, 'cancelled'); return;
    }
    if (type === 'session.execution.succeeded') {
      if (state.phase !== 'complete') { resetWindow(state); emit(state, 'complete', undefined, undefined, true); }
      return;
    }
    if (state.phase === 'cancelled' || state.phase === 'complete') return;
    if (data.assistantMessageID !== undefined && (!id(data.assistantMessageID) || key('assistant', data.assistantMessageID) !== state.assistantKey)) { drop(sessionKey); return; }
    if (type.startsWith('session.tool.')) {
      state.eligible = false; resetWindow(state); emit(state, type === 'session.tool.success' || type === 'session.tool.failed' ? 'waiting' : 'tool'); return;
    }
    const partType = /^session\.(text|reasoning)\.(started|delta|ended)$/.exec(type);
    if (partType) {
      if (!safe(data.ordinal)) { drop(sessionKey); return; }
      const partKey = `${partType[1]}:${data.ordinal}`, part = state.parts.get(partKey), kind = partType[1], operation = partType[2];
      if (operation === 'started') {
        if (part || state.parts.size >= MAX_PARTS) { drop(sessionKey); return; }
        state.parts.set(partKey, { count: 0, high: false, ended: false }); return;
      }
      if (!part || part.ended) { drop(sessionKey); return; }
      if (operation === 'delta') {
        if (typeof data.delta !== 'string' || data.delta.length > MAX_DELTA) { drop(sessionKey); return; }
        if (!data.delta.length) return;
        const amount = characters(data.delta, part); part.count += amount; state[kind] += amount;
        if (state.text + state.reasoning > MAX_CHARACTERS) { drop(sessionKey); return; }
        sample(state, amount, kind === 'text' ? 'generating' : 'reasoning'); return;
      }
      if (part.high) { part.count++; state[kind]++; part.high = false; }
      part.ended = true;
      if (typeof data.text !== 'string' || data.text.length > MAX_CHARACTERS * 2 || characters(data.text, {}) !== part.count) {
        state.eligible = false; resetWindow(state); emit(state, 'waiting');
      }
      return;
    }
    if (type === 'session.step.streamed') {
      state.streamed = input.created; resetWindow(state); emit(state, 'waiting'); return;
    }
    if (type === 'session.step.ended') {
      resetWindow(state);
      const output = data.tokens?.output, reasoning = data.tokens?.reasoning;
      const total = output + reasoning, chars = state.text + state.reasoning;
      const eligible = state.eligible && ['stop', 'length'].includes(data.finish)
        && safe(output) && safe(reasoning) && total > 0 && chars > 0
        && (output > 0) === (state.text > 0) && (reasoning > 0) === (state.reasoning > 0)
        && state.parts.size > 0 && [...state.parts.values()].every(part => part.ended)
        && state.streamed !== undefined && state.streamed > state.started;
      if (eligible) {
        const ratio = chars / total;
        // Reject impossible/ambiguous reporting rather than poisoning calibration.
        if (ratio >= 0.25 && ratio <= 32) {
          let steps = calibration.get(state.calibrationKey);
          if (!steps) {
            if (calibration.size >= MAX_CHATS) calibration.delete(calibration.keys().next().value);
            calibration.set(state.calibrationKey, steps = []);
          }
          steps.push({ characters: chars, tokens: total }); if (steps.length > 10) steps.shift();
          emit(state, 'complete', total * 1000 / (state.streamed - state.started),
            { startedAtMs: state.started, endedAtMs: state.streamed }, true); return;
        }
      }
      emit(state, data.finish === 'tool-calls' ? 'tool' : 'complete', undefined, undefined, data.finish !== 'tool-calls');
      return;
    }
    // Events from unrelated domains never count as output. Unknown session output protocol clears the reading.
    if (/^session\.(?:text|reasoning|step)\./.test(type)) drop(sessionKey);
  }
  function tick() {
    const time = now();
    for (const [sessionKey, state] of chats) {
      if (time < state.updated || time - state.updated >= (state.phase === 'complete' || state.phase === 'cancelled' ? 15_000 : 600_000)) { drop(sessionKey); continue; }
      if (state.phase !== 'complete' && !state.stale && time - state.updated >= WINDOW_MS) {
        state.stale = true; if (state.lastDelta !== undefined) state.eligible = false;
        resetWindow(state); remove(sessionKey);
      }
    }
    for (const [match, route] of routes) if (time < route.at || time - route.at > 600_000) routes.delete(match);
  }
  return { setWatched, authorizeHttp, event, tick, clear,
    // Only bounded numeric diagnostics for deterministic tests; never expose stored matching keys here.
    stats: () => ({ chats: chats.size, routes: routes.size, calibrationModels: calibration.size,
      points: [...chats.values()].reduce((n, state) => n + state.points.length, 0) }) };
}

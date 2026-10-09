import { chatKey } from '../../src/contract/chat-key.ts';
import type { MediaJobV1, MediaSnapshotV1 } from '../../src/contract/media.ts';
declare global { interface Window { ScopeMediaFixtures: { respond(message: { payload: { path: string; method?: string; body?: string } }): { status: number; body: string } | null }; [key: string]: any } }
const params = new URLSearchParams(location.search);
window.previewAuxiliaryRequests = [];
window.previewMediaOverride = null;
window.previewMediaSetup = null;
window.previewMediaCancelled = false;
window.previewMediaHold = false;
window.previewMediaEnabled = true;
const job = (state: string): MediaJobV1 => {
  const now = Date.now(), terminal = ['completed', 'failed', 'cancelled'].includes(state);
  return { id: 'fixture-video', sourceId: 'comfyui', kind: 'video', name: 'Landscape study', state: terminal ? state as 'completed' | 'failed' | 'cancelled' : state === 'waiting' ? 'waiting' : state === 'queued' ? 'queued' : 'running',
    phase: terminal ? state as 'completed' | 'failed' | 'cancelled' : state === 'waiting' ? 'waiting' : state === 'queued' ? 'queued' : 'sampling',
    sampledAtMs: now, observedAtMs: now - (state === 'stale' ? 60_000 : 0), startedAtMs: now - 72_000,
    ...terminal ? { finishedAtMs: now - 1_000 } : {}, freshness: terminal ? 'last' : state === 'stale' ? 'stale' : 'live',
    progress: terminal || ['basic', 'waiting', 'queued', 'stale'].includes(state) ? null : { value: 8, total: 20, unit: 'steps', basis: 'phase' },
    ownership: state === 'other' ? {} : { sessionKey: chatKey('session', 'fixture-chat') },
    cancel: { supported: !terminal && state !== 'stale' }, ...state === 'waiting' ? { message: 'Waiting for the local chat to release the GPU.' } : {} };
};
window.ScopeMediaFixtures = { respond(message) {
  const path = message.payload.path;
  if (!['/v2/media', '/v2/media/cancel', '/v2/media/setup', '/v2/companion/setup'].includes(path)) return null;
  window.previewAuxiliaryRequests.push({ path, method: message.payload.method ?? 'GET' });
  const response = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
  if (path === '/v2/companion/setup') return response({ state: params.get('tracking') === 'ready' ? 'ready' : 'disabled', message: 'Enable delivery-speed estimates for local and cloud chats.',
    configured: false, managed: false, canEnable: true, canDisable: false, runtimeVersion: '2.0.25', companionVersion: null, protocol: null, live: false });
  if (path === '/v2/media/setup') {
    if (message.payload.method === 'POST') {
      const input = JSON.parse(message.payload.body ?? '{}');
      if (input.action === 'set-enabled' && !input.sourceId) window.previewMediaEnabled = input.enabled;
      else window.previewMediaSetup = { schemaVersion: 1, sources: [{ id: 'comfyui', label: 'ComfyUI', state: input.action === 'disable' ? 'available' : 'pending', message: 'Installed · activates next time ComfyUI starts. Basic monitoring continues.', canEnable: true, canDisable: input.action !== 'disable', managed: input.action !== 'disable', helperVersion: '1.0.0', runtimeVersion: '0.38.0', locations: [{ id: 'fixture', label: 'ComfyUI · 0.38.0' }] }] };
    }
    return response({ ...(window.previewMediaSetup ?? { schemaVersion: 1, sources: params.has('media') ? [{ id: 'comfyui', label: 'ComfyUI', state: 'available', message: 'Enable detailed progress to see measured work within each generation phase.', canEnable: true, canDisable: false, managed: false, helperVersion: null, runtimeVersion: '0.38.0', locations: [{ id: 'fixture', label: 'ComfyUI · 0.38.0' }] }] : [] }), enabled: window.previewMediaEnabled });
  }
  if (path === '/v2/media/cancel') {
    const input = JSON.parse(message.payload.body ?? '{}'); window.previewMediaCancelled = true;
    return response({ schemaVersion: 1, sourceId: input.sourceId, jobId: input.jobId, status: 'requested' });
  }
  const state = params.get('media') ?? 'none';
  if (!window.previewMediaEnabled) return response({ schemaVersion: 1, enabled: false, sampledAtMs: Date.now(), nextPollMs: 30_000, sources: [], jobs: [] });
  const snapshot: MediaSnapshotV1 = { schemaVersion: 1, sampledAtMs: Date.now(), nextPollMs: state === 'none' ? 30_000 : 1_000,
    sources: state === 'none' ? [] : [{ id: 'comfyui', kind: 'comfyui', label: 'ComfyUI', state: state === 'disconnected' ? 'disconnected' : 'ready', capabilities: { progress: state !== 'basic', cancel: true } }],
    jobs: ['none', 'empty', 'disconnected'].includes(state) ? [] : [job(window.previewMediaCancelled ? 'cancelled' : state)] };
  return response(window.previewMediaOverride ?? snapshot);
} };

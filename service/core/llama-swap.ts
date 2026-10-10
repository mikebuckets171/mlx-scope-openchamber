import type { RuntimeReply } from './adapter-v2.ts';

// llama-swap answers on the OpenCode provider's port and starts, stops and swaps the model servers behind it. Scope reads
// only its `GET /running` list, then the ready model's own loopback server with the usual adapter. It never calls
// `/upstream/…` or any other route that would start, stop or swap a model, and never sends the provider's key upstream.

export interface SwapBackend { model: string; origin: URL }
export type SwapState =
  | { kind: 'ready'; backend: SwapBackend }
  | { kind: 'loading' }                      // a model is starting (or stopping) and none is ready
  | { kind: 'idle' }                         // nothing is running; llama-swap starts a model on the next request
  | { kind: 'unsupported' };                 // a ready backend Scope must not read: remote, or several with no choice

const MAX_RUNNING = 16;
const TRANSITIONS = new Set(['starting', 'stopping']);
/** A numeric-loopback HTTP origin with an explicit port; anything else is never read. */
const loopbackOrigin = (value: unknown): URL | null => {
  if (typeof value !== 'string' || value.length > 200) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password) return null;
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return new URL(url.origin);
};

/**
 * llama-swap's `/running` list, or null when the reply is not llama-swap's. With several ready models, the provider's
 * configured model picks one; Scope never guesses between servers.
 */
export const swapState = (reply: RuntimeReply, preferredModel: string | null): SwapState | null => {
  const body = reply.status === 200 && !reply.routeMissing ? reply.body : null;
  const running = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).running : undefined;
  if (!Array.isArray(running) || running.length > MAX_RUNNING) return null;
  const rows = running.map(item => item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : null);
  if (rows.some(row => !row || typeof row.model !== 'string' || typeof row.state !== 'string')) return null;
  const ready = rows.filter(row => row!.state === 'ready').map(row => ({ model: String(row!.model).slice(0, 200), origin: loopbackOrigin(row!.proxy) }));
  if (ready.length) {
    const chosen = ready.length === 1 ? ready[0]! : ready.find(item => item.model === preferredModel) ?? null;
    return chosen?.origin ? { kind: 'ready', backend: { model: chosen.model, origin: chosen.origin } } : { kind: 'unsupported' };
  }
  return rows.some(row => TRANSITIONS.has(row!.state as string)) ? { kind: 'loading' } : { kind: 'idle' };
};

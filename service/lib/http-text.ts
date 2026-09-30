import { HttpFailure, type FetchImplementation } from '../http.ts';
import type { Json } from './parse.ts';

// Siblings of `requestJSON` with the same http.ts rules (manual redirects refused, a size cap, one timeout). They return
// every HTTP status instead of throwing on it, so detection and adapters can tell "absent" from "present but locked";
// only an unsafe, oversized, timed-out or unanswered request throws, and always as HttpFailure('runtime_unreachable').

export const TEXT_MAX_BYTES = 2 * 1024 * 1024;
/** The JSON cap requestJSON enforces. */
export const JSON_MAX_BYTES = 2_000_000;
export interface TextResponse { status: number; text: string }
/** A GET as detection and v2 adapters see it: `routeMissing` folds LM Studio's 200 "Unexpected endpoint" body into a 404. */
export interface JsonReply { status: number; body: Json | null; routeMissing: boolean }
type Options = { url: URL; fetchImpl: FetchImplementation; timeoutMs?: number; maxBytes?: number; init?: RequestInit };

const read = async ({ url, fetchImpl, timeoutMs = 3_000, maxBytes = TEXT_MAX_BYTES, init }: Options): Promise<{ status: number; bytes: Uint8Array }> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = async () => {
      const response = await fetchImpl(url.toString(), { ...init, method: 'GET', redirect: 'manual', signal: controller.signal });
      if (!response || response.status >= 300 && response.status < 400 || response.url !== '' && response.url !== url.toString()) {
        throw new HttpFailure('runtime_unreachable', 'The runtime returned an unsafe response.');
      }
      const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { await reader.cancel(); throw new HttpFailure('runtime_unreachable', 'The runtime response was too large.'); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return { status: response.status, bytes };
    };
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new HttpFailure('runtime_unreachable', 'The runtime request timed out.')); }, Math.max(1, timeoutMs));
    })]);
  } catch (error) {
    if (error instanceof HttpFailure) throw error;
    throw new HttpFailure('runtime_unreachable', 'The runtime did not answer.');
  } finally {
    clearTimeout(timer);
    // Headers can arrive before an unbounded body; release that stream whatever happened.
    controller.abort();
  }
};

/** A GET whose body is text (Prometheus exposition), with its status. */
export const requestText = async (options: Options): Promise<TextResponse> => {
  const { status, bytes } = await read(options);
  return { status, text: new TextDecoder().decode(bytes) };
};

const object = (value: unknown): Json | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;

/** A GET whose body should be a JSON object; anything else is a null body, never a throw. */
export const requestReply = async (options: Omit<Options, 'maxBytes'>): Promise<JsonReply> => {
  const { status, bytes } = await read({ ...options, maxBytes: JSON_MAX_BYTES });
  let body: Json | null = null;
  try { body = object(JSON.parse(new TextDecoder().decode(bytes))); } catch { body = null; }
  return { status, body, routeMissing: status === 200 && isRouteMissingBody(body) };
};

/** A 200 body that means "no such route" (LM Studio `{"error":"Unexpected endpoint or method. …"}`): treated as 404. */
export const isRouteMissingBody = (body: unknown): boolean => {
  const item = object(body);
  return item !== null && typeof item.error === 'string' && /^Unexpected endpoint\b/i.test(item.error) && !('models' in item) && !('data' in item);
};

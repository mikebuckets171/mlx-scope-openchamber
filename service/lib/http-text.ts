import type { FetchImplementation } from '../http.ts';

// Owner: svc-2b. Siblings of `requestJSON` with the same http.ts rules (manual redirects refused, 2 MB cap, timeout).

export const TEXT_MAX_BYTES = 2 * 1024 * 1024;
export interface TextResponse { status: number; text: string }

/** A GET whose body is text (Prometheus exposition). Throws HttpFailure like `requestJSON`. */
export const requestText = async (options: { url: URL; fetchImpl: FetchImplementation; timeoutMs?: number; maxBytes?: number; init?: RequestInit }): Promise<TextResponse> => {
  void options;
  throw new Error('requestText: not implemented (svc-2b)');
};

/** A 200 body that means "no such route" (LM Studio `{"error":"Unexpected endpoint or method. …"}`): treated as 404. */
export const isRouteMissingBody = (body: unknown): boolean => {
  const error = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as { error?: unknown }).error : undefined;
  return typeof error === 'string' && error.startsWith('Unexpected endpoint or method.');
};

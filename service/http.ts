type JsonObject = { readonly [key: string]: unknown };
export type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type JsonResponse = {
  status: number;
  body: JsonObject | null;
  setCookie: string | null;
};

type HttpFailureReason = 'authentication_failed' | 'runtime_unreachable';

export class HttpFailure extends Error {
  readonly reason: HttpFailureReason;
  readonly status: number | null;

  constructor(reason: HttpFailureReason, message: string, status: number | null = null) {
    super(message);
    this.name = 'HttpFailure';
    this.reason = reason;
    this.status = status;
  }
}

const asObject = (value: unknown): JsonObject | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
);

const responseIsRedirect = (status: number): boolean => status >= 300 && status < 400;

export const requestJSON = async ({
  url,
  init,
  fetchImpl,
  timeoutMs = 3_000,
  allowLoadingHealth = false,
}: {
  url: URL;
  init?: RequestInit;
  fetchImpl: FetchImplementation;
  timeoutMs?: number;
  allowLoadingHealth?: boolean;
}): Promise<JsonResponse> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = async (): Promise<JsonResponse> => {
      const response = await fetchImpl(url.toString(), {
        ...init,
        redirect: 'manual',
        signal: controller.signal,
      });
      if (!response || responseIsRedirect(response.status) || response.url !== '' && response.url !== url.toString()) {
        throw new HttpFailure('runtime_unreachable', 'The runtime returned an unsafe response.');
      }
      if (response.status === 401 || response.status === 403) {
        throw new HttpFailure('authentication_failed', 'The runtime requires a valid API key or rejected the supplied key.', response.status);
      }
      if (response.status !== 200 && !(allowLoadingHealth && response.status === 503)) {
        throw new HttpFailure('runtime_unreachable', `The runtime returned HTTP ${response.status}.`, response.status);
      }
      let body: JsonObject | null = null;
      try {
        const reader = response.body?.getReader();
        let size = 0;
        const chunks: Uint8Array[] = [];
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 2_000_000) {
              await reader.cancel();
              throw new Error('Response too large');
            }
            chunks.push(value);
          }
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        body = asObject(JSON.parse(new TextDecoder().decode(bytes)));
      } catch {
        throw new HttpFailure('runtime_unreachable', 'The runtime returned invalid JSON.');
      }
      return {
        status: response.status,
        body,
        setCookie: response.headers.get('set-cookie'),
      };
    };
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new HttpFailure('runtime_unreachable', 'The runtime request timed out.'));
        }, Math.max(1, timeoutMs));
      }),
    ]);
  } catch (error) {
    if (error instanceof HttpFailure) throw error;
    throw new HttpFailure('runtime_unreachable', 'The runtime did not answer.');
  } finally {
    clearTimeout(timer);
    // Rejected headers can arrive before an unbounded body. Release that stream
    // even when the request finishes before its timeout.
    controller.abort();
  }
};

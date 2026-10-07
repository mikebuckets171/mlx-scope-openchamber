# Optional Splash prompt progress companion

This OpenCode 2 plugin enables Splash's `return_progress` option on existing streaming requests. It observes the same HTTP response, without changing the model route, starting a proxy, or submitting a prompt. Scope can then show **Prompt progress** from `processed / total`; the completed portion includes cached prompt tokens. oMLX monitoring does not use this companion.

Add this directory to OpenCode's existing `plugins` list; keep the other entries:

```json
{
  "package": "/absolute/path/to/mlx-scope/bridge/opencode",
  "options": {
    "providerID": "splish",
    "baseURL": "http://127.0.0.1:8000/v1"
  }
}
```

Use the absolute path to the extracted companion directory and the provider name/base URL already configured for
Splash. OpenCode 2.0.22 can activate it when configuration changes without restarting the server; this was verified
while an existing response continued. Check OpenCode's plugin list for **mlx-scope-prompt-progress** before starting a
new reply. On other versions, follow that version's normal plugin reload steps when no reply is running. The default scope is provider `splish` at `http://127.0.0.1:8000/v1`. The object plugin form can set `options.providerID` and `options.baseURL`; the endpoint must be loopback. Existing active requests cannot acquire progress retroactively. Installation/reload is intentionally separate from running the tests.

The plugin uses the supported `session.hook('http.request')` and `session.hook('http.response')` APIs. The bundled OpenCode inspected on 2026-10-07 also routes AI SDK fetches through this hook chain; older OpenCode versions may only support the native provider path. No global fetch override is used. See [OpenCode plugin documentation](https://opencode.ai/v2/docs/build/plugins/#native-http).

## Local data contract

Each process owns one atomic JSON file at `~/.cache/mlx-scope/prompt-progress/<writerUUID>.json`. The directory has mode `0700`, files `0600`. Multiple OpenCode locations in a process share the writer; separate processes cannot overwrite each other. Files are removed when empty or unloaded. A crash may leave a file, but all its entries expire after 15 seconds. Consumers must ignore hidden temporary files, malformed documents, symlinks, oversized files, excess writers/entries, expired data, and future timestamps. Recommended read limits are 16 writer files, 16 entries per file, and 64 KiB per file. Cache writes are coalesced to at most one every 200 ms during normal operation.

```ts
type PromptProgressFile = {
  schemaVersion: 1;
  writerID: string; // UUID, also the filename stem
  updatedAtMs: number;
  expiresAtMs: number;
  entries: Array<{
    requestID: string; // random UUID for this response, never Splash's request ID
    sessionKey: string;
    providerID: string;
    endpointKey: string;
    modelKey: string;
    responseModelKey?: string;
    kind: 'primary' | 'compaction' | 'title' | 'generate';
    total: number;
    cache: number;
    processed: number;
    timeMs: number;
    observedAtMs: number;
    expiresAtMs: number;
  }>;
};
```

Every key is lowercase SHA-256 hex over UTF-8 `mlx-scope-${kind}-v1\0${value}`. The kinds and values are `session` / exact OpenCode session ID, `endpoint` / `new URL(configuredBaseURL).origin` with the literal hostname `localhost` normalized to `127.0.0.1` (no DNS lookup), and `model` / exact model ID. `modelKey` comes from the request's OpenCode model, while optional `responseModelKey` comes from the canonical model announced in a response frame. Consumers can match either; they must not guess aliases. Hashes and request IDs are for local matching and must not appear in exported diagnostics.

Counts must be safe integers, `0 <= cache <= processed <= total`, and `total > 0`. `timeMs` must be finite and nonnegative. Total/cache remain unchanged within a response, processed strictly increases, and time never decreases. Invalid progress ends observation for that response while the response itself continues unchanged. The observer also clears at the first output/reasoning/tool frame, finish/error, `[DONE]`, EOF, abort, or cancellation. It does not read ahead of the client. Frames over 64 KiB disable observation; generation continues.

The cache identifies a stream's endpoint and models, not the engine process. A Scope consumer must corroborate a fresh, ready Splash status, one active request in prefill, one matching primary progress record, matching endpoint/model, and consistent counts. Otherwise it shows no percentage. An unchanged record expires even if a long prefill command is still running. Multiple active requests cannot be safely attributed by server status alone. Native Scope does not know which OpenCode session the user has selected.

Only the fields above are persisted. No prompt, reply, request headers, credentials, raw session ID, or raw model ID is saved. Prompt bodies are parsed in memory solely to add the documented boolean option; bodies over 16 MiB are left untouched. Local hashes provide correlation, not anonymization against someone who already knows the identifiers.

## Verification

Run `node --test bridge/opencode/bridge.test.js` from the repository root. Tests cover fragmented SSE/UTF-8, all three supported API shapes, unchanged response bytes, backpressure, cancellation, malformed counters, memory bounds, private file permissions, TTL, multiple writers, unload, and provider isolation. They do not send model requests.

Primary Splash 1.3 evidence: installed `server/server.py` validates `return_progress` with `stream: true` (lines 141–149) and emits `prompt_progress` SSE (lines 1381–1391); `server/backend.py` constructs `{total, cache, processed, time_ms}` from the engine progress event (lines 716–725). `server/runtime.py` validates monotonic progress inside prefill (lines 262–280).

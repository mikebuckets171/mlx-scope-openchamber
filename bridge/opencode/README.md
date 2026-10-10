# Optional OpenCode companion

The 3.2 companion observes demand-gated HTTP and WebSocket chat delivery on **OpenCode 2.0.25**, for local and cloud
chats alike, and retains the existing Splash prompt-progress observer. Unsupported OpenCode versions disable chat
estimates while native runtime monitoring remains available. The plugin ID remains `mlx-scope-prompt-progress` to
update existing installations in place.

**3.2 scope:** local and cloud chat delivery. A cloud reading is delivery observed through OpenCode, including network
and provider buffering; it is never engine throughput, and a cloud chat never borrows a local engine measurement.

The Splash observer enables Splash's `return_progress` option on existing streaming requests. It observes the same HTTP response, without changing the model route, starting a proxy, or submitting a prompt. Scope can then show **Prompt progress** from `processed / total`; the completed portion includes cached prompt tokens. Native oMLX metrics do not require the companion.

Chat delivery estimates support proven loopback providers, including oMLX, using the supported
OpenCode event protocol. They measure delivery through OpenCode, including network buffering, rather than native engine
throughput. It adds no inference requests.

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

Run `node --test bridge/opencode/*.test.js` from the repository root. Tests cover fragmented SSE/UTF-8, all three supported API shapes, unchanged response bytes, backpressure, cancellation, malformed counters, memory bounds, private file permissions, TTL, multiple writers, unload, and provider isolation. They do not send model requests.

Primary Splash 1.3 evidence: installed `server/server.py` validates `return_progress` with `stream: true` (lines 141–149) and emits `prompt_progress` SSE (lines 1381–1391); `server/backend.py` constructs `{total, cache, processed, time_ms}` from the engine progress event (lines 716–725). `server/runtime.py` validates monotonic progress inside prefill (lines 262–280).


## Chat delivery telemetry (3.1)

Use Scope's deliberate Enable action to install the bundled companion at the stable global `addons/mlx-scope-prompt-progress` directory, retaining existing plugins and JSONC comments. Managed updates atomically replace the bundle and change only the entry's owned `options.scopeRevision` fingerprint, so OpenCode's normal configuration watcher can load the new generation even when file watches remain on the previous directory. Repeating Enable with an unchanged bundle preserves configuration bytes. The optional `promptProgress: false` setting disables Splash HTTP modification without disabling chat observation. Setup must never restart a running inference session automatically. The current stream cannot be recovered retroactively when monitoring becomes visible midway through a reply. A local chat can use its labeled engine fallback until a newly observed primary step; cloud tracking is disabled in 3.1 and creates no observation demand.

The observer uses the supported `ctx.event.subscribe({ signal })` API. OpenCode events are Location-scoped, so instances at the same directory/workspace share one subscription; distinct locations have separate subscriptions, bounded to sixteen active locations. They share one process-wide demand-file poll and telemetry writer. Subscriptions exist only while at least one matching visible Scope view has a valid lease.

The `http.request` hook reads primary POST request metadata. The qualified `experimental.ws.handshake` hook reads primary session/model/destination metadata on every model call, including cached WebSocket reuse. It does not read or change headers, socket frames, requests, responses, or the socket. This covers OpenCode 2.0.25's default OpenAI WebSocket transport. Local targets require a literal loopback origin; remote targets require an observed non-loopback origin. Each step needs its own corroborated destination. A primary dispatch refreshes demand before authorizing observation, so the first reply does not depend on the periodic poll's timing. The separate existing Splash HTTP observer still only adds `return_progress` for its explicitly configured provider.

Protocol qualification is exact for **2.0.25**. The released schema uses `session.step.started`, `session.step.streamed`, `session.step.ended`, `session.text.*`, `session.reasoning.*`, `session.tool.*`, and `session.execution.*`, with the envelope's numeric `created` timestamp and ordinal text/reasoning parts. These are different from old `session.next.*` events; old payloads are not interpreted as current telemetry. Public primary sources inspected for this implementation:

- [OpenCode plugin event API](https://opencode.ai/v2/docs/build/plugins/#events)
- [2.0.25 public session-event schema](https://github.com/anomalyco/opencode/blob/v2.0.25/packages/schema/src/session-event.ts)
- [2.0.25 event envelope](https://github.com/anomalyco/opencode/blob/v2.0.25/packages/schema/src/event.ts)
- [2.0.25 token usage normalization](https://github.com/anomalyco/opencode/blob/v2.0.25/packages/core/src/session/usage.ts)
- [2.0.25 native request hooks](https://github.com/anomalyco/opencode/blob/v2.0.25/packages/core/src/session/model-request.ts)
- [2.0.25 WebSocket transport and connection reuse](https://github.com/anomalyco/opencode/blob/v2.0.25/packages/core/src/session/model-transport.ts)

Live estimates count Unicode code points from observable text and reasoning deltas over a rolling five-second interval, requiring two seconds of observation. They begin at four characters per token. After three eligible steps, calibration uses the summed characters and reported tokens from the latest ten comparable steps for the same provider, model, and endpoint. HTTP(S) and WS(S) origins have separate calibration. It stays an estimate. Calibration requires complete observed parts, a streamed response boundary, unambiguous separate visible-output/reasoning counts, and no tool activity or missed/gapped output. Reasoning tokens without observable reasoning, tool payloads, title generation, compaction, auxiliary generation, replayed frames, and incompatible lifecycle events cannot train calibration. Calibration is bounded and lives only in process memory.

Completed-step averages use reported output plus reasoning tokens over dispatch-to-streamed time, including prompt processing. They are labeled `reported-output` / `completed-step`, never native engine decode speed. Short completed steps may therefore have a final average even when their live stream never met the two-second minimum. Cancellation immediately removes live speed; a five-second gap clears the rolling window. A completed last reading expires after fifteen seconds.

### Demand, readiness, and writer files

All chat files live in `~/.cache/mlx-scope/chat-telemetry`, with directory mode `0700` and files `0600`. The service atomically maintains `demand.json`:

```ts
type ChatDemand = {
  schemaVersion: 1;
  updatedAtMs: number;
  expiresAtMs: number; // > now, <= updatedAtMs + 15000
  watched: Array<{ // <= 16
    sessionKey: string; providerKey: string; modelKey: string;
    destination?: 'remote'; // absent for local targets
  }>;
};
```

Only matching watched sessions are tracked. Hashes use the existing key scheme above, adding kind `provider` / exact provider ID. The companion checks demand once per second. On expiration it aborts all event subscriptions, clears observations and route proofs, and removes its writer file. No event sampling or telemetry writes continue while hidden. One fixed startup heartbeat is written to `heartbeat.json`:

```ts
type CompanionHeartbeat = {
  schemaVersion: 1;
  companionVersion: '3.1.0';
  protocol: 'opencode-2.0.25' | 'unsupported';
  runtimeVersion: string;
  loadedAtMs: number;
  supported: boolean;
  updatedAtMs?: number; // refreshed at most every five seconds while demanded
  expiresAtMs?: number; // heartbeat update + 15000
};
```

A startup heartbeat identifies the loaded version; by itself it does not establish current liveness. The service must verify a fresh demanded heartbeat before claiming the companion is ready. No PID or process command line is written.

Each process also owns `<writerUUID>.json`, updated at most every 200 ms during normal operation:

```ts
type ChatTelemetryFile = {
  schemaVersion: 1;
  writerID: string;
  companionVersion: '3.1.0';
  protocol: 'opencode-2.0.25';
  runtimeVersion: '2.0.25';
  updatedAtMs: number;
  expiresAtMs: number; // update + 15000
  entries: Array<{ // <= 16
    sessionKey: string; providerKey: string; modelKey: string; endpointKey: string;
    destination?: 'remote'; // absent for local observations
    measurement: {
      scope: 'chat';
      basis: 'estimated-characters' | 'calibrated-characters' | 'reported-output';
      timingBasis: 'delivery-window' | 'completed-step';
      phase: 'waiting' | 'generating' | 'reasoning' | 'tool' | 'complete' | 'cancelled';
      tokensPerSecond?: number;
      observedAtMs: number;
      expiresAtMs: number; // <= observation + 5000 live, +15000 last
      observation: { startedAtMs: number; endedAtMs: number };
      freshness: 'live' | 'last';
      calibrationSteps?: number; // 3..10 only when calibrated
    };
  }>;
};
```

Only `generating`/`reasoning` may carry a live rate; `complete` may carry a last completed-step average. Quiet/cancelled states have no rate. Readers must reject symlinks, wrong owners/permissions, future/expired documents, unsupported protocols, excessive entries, and files larger than 64 KiB; scan at most 256 directory entries and accept at most sixteen fresh valid writers, ignoring expired crash remnants. Local readings require exactly one matching session/provider/model and configured endpoint, with no remote classification. Remote readings require exactly one matching session/provider/model and remote classification with a valid observed endpoint hash. Multiple matching endpoints or writers are ambiguous and produce no reading. Calibration remains specific to the observed endpoint. Use each observation's own expiry rather than the writer expiry to decide freshness. Matching hashes are local transport metadata and must never enter exported diagnostics. Conversation text, reasoning, tool content, credentials, raw model/session identifiers, and provider URLs are never written by chat telemetry.

Tests cover the released event shapes, minimum window, bounded rolling samples, Unicode splits, concurrent selected chats in separate locations, first-dispatch demand, HTTP/WebSocket matching, gaps, cancellation before and after step announcement, retries, tool exclusions, completion timing, calibration eligibility/limits, demand expiry, shared subscriptions, unsupported versions, private files, and prompt-progress opt-out. The existing Splash byte-preservation and backpressure tests remain unchanged.


To qualify the actual released runtime with a local synthetic SSE provider, run `node bridge/opencode/protocol-smoke.mjs /absolute/path/to/opencode`. Add `--remote` to exercise remote destination matching. In that mode the production observer sees a synthetic non-loopback `.invalid` URL before a test-only supported HTTP hook routes the request to the loopback receiver. Neither mode contacts a cloud provider. This optional smoke test uses isolated configuration/data/cache directories, submits four fixture replies only to its own loopback server, verifies exact matching, three-step calibration and completed-step averages, verifies hidden writes stop, and removes its test processes/data. It does not use a real model or change the live OpenCode installation.

Run `node bridge/opencode/protocol-ws-smoke.mjs /absolute/path/to/opencode` to qualify the released OpenAI default WebSocket path. A test-only routing hook sends synthetic calls to its own loopback socket. It verifies one cached connection, per-call metadata, continuation after a native read tool, live estimates, calibration, completion and hidden shutdown. It makes no real model or cloud request and leaves the live configuration unchanged.

For isolated companion overhead, run `node bridge/opencode/overhead.mjs /absolute/evidence/directory`. It compares three alternating enabled/disabled pairs with four concurrent synthetic chats in two distinct locations, reports process CPU/RSS and file/subscription bounds, and checks that demand expiry stops event delivery and telemetry writes. These measurements include the companion's Node harness, not the entire OpenCode process or real inference. The separate `scripts/measure-chat-overhead.mjs` probe measures service reads and demand writes against one fresh private fixture. Neither short probe establishes real-inference slowdown or long-duration stability.

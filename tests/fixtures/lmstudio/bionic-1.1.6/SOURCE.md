# LM Studio family · Bionic 1.1.6 fixtures

**Represents:** Bionic 1.1.6+3, the LM Studio-derived app whose `package.json` is still named `lm-studio`, serving Splash models through the `splash-mac-arm64-apple-metal-advsimd` 0.0.5 engine. The CLI is the `lms` bundled with it: lmstudio-ai/lms@1017bcb ("@Release-56", package version 0.4.0).

**Everything here is synthetic.**
- Model ids are `publisher/example-*`, `example-*` or `text-embedding-example-*`.
- Times are built on 2026-09-29T12:00:00Z (`1790683200000`). The wall clock inside each log `content` is the same instant in UTC.
- There are no paths, PIDs, keys or cookies.
- The only prompt or output text is the labelled canaries.

Stock LM Studio differences are in `../lmstudio-0.4.25/SOURCE.md`.

## How the shapes were learned (2026-09-29, read-only)

1. **Live GETs** to the owner's running Bionic 1.1.6 on :1234:
   - `/lmstudio-greeting`: exact bytes and `Content-Type: application/json; charset=utf-8`.
   - `/api/v0/models`: key order (`data` before `object`), 2-space pretty print, no final newline, per-model keys, and `capabilities` missing on embeddings.

   All values were replaced. `/api/v1/models` was **not** requested, because it is not in the approved GET list, so its fixtures are synthesized.
2. **`lms` against the running app, once each.** Both commands carried `LMS_API_SERVER_INFO_PATH` (the LM Studio home's `.internal/http-server.json`) and `--port <internal>`.
   - `lms ps --json` printed `[]` because no model was loaded.
   - `lms runtime ls` printed the engine table. Its layout is copied exactly, with synthetic versions.

   No inference was sent. Nothing was loaded, unloaded, started or stopped.
3. **Read-only inspection of the installed bundle** `/Applications/Bionic.app/Contents/Resources/app/.webpack-bionic/main/index.js` (obfuscated). It shows:
   - the v0 and v1 model builders;
   - the route-missing string `'Unexpected endpoint or method. (' + method + ' ' + path + ')'`;
   - the server-log calls `'Received request: '`, `'Running chat completion on conversation with '`, `'Prompt processing progress: '`, `'Streaming response...'`, `'Finished streaming response'`, `'Generated prediction:'` and `'Accumulated ' + n + … token(s)`.
4. **Upstream source** is cited per file below.
5. **Lines captured earlier from Bionic 1.1.6** with redaction on, recorded in `service/lmstudio-activity.test.ts:9-19` and `:36-43`.

## Files

### `GET /lmstudio-greeting`
| File | Provenance | Purpose |
|---|---|---|
| `lmstudio-greeting.ok.json` | Modeled on the live capture: 17 bytes, compact, byte-identical. The bundle sends `JSON.stringify({lmstudio:true})`. `lms` itself probes the route and requires `lmstudio === true` (lms@1017bcb `src/createClient.ts:19-42`). | LM Studio-family detection (plan §5.1, probe 4). Its absence for 10 s is `lms_unavailable`: no `lms` spawn (contract §5). |

### `GET /api/v0/models`
Top-level keys are `data`, then `object: "list"`. Per-model keys, in order:
- `id`, `object: "model"`, `type`
- `publisher`, `arch`, `compatibility_type`, `quantization`
- `state`, `max_context_length`, and `capabilities` (LLM and VLM only)

The bundle's v0 builder sets:
- `type` to `vlm` when the model has a vision adapter, to `embeddings` for embedding models, and to `llm` otherwise;
- `capabilities: ["tool_use"]` when the model is trained for tool use.

All four bodies share one five-model inventory:
- two Splash VLMs: one with a publisher-scoped id, one with a bare id;
- one MLX LLM;
- one GGUF LLM;
- one GGUF embedding.

| File | Provenance | Purpose |
|---|---|---|
| `api-v0-models.all-not-loaded.json` | Modeled on the live capture (shape and whitespace); values synthetic. | Baseline for generation-change detection: nothing is resident. |
| `api-v0-models.one-loaded.json` | Same as above, with `publisher/example-27b-splash` set to `state: "loaded"`. | A `not-loaded → loaded` change bumps `connection.generation` and refreshes `lms ps` (SPIKES S8; contract §8). |
| `api-v0-models.loading.json` | Same inventory with `state: "loading"`. The value is **inferred**: the bundle's builder copies the loaded instance's status and falls back to `'not-loaded'`, but no in-progress value was captured live. | A mid-load state. The 1.6 adapter reports unknown states as `loaded: null` (`service/lmstudio.test.ts:152-166`). The generation must still change. |
| `api-v0-models.empty.json` | Synthesized from the same builder: an empty models directory. | Connected with an empty inventory. This must not be `unsupported_contract`. |

### `GET /api/v1/models`
| File | Provenance | Purpose |
|---|---|---|
| `api-v1-models.splash.json` | Synthesized. Key order comes from the Bionic 1.1.6 v1 builder (details below). Field meanings come from lmstudio-ai/docs@9b8bc20 `1_developer/2_rest/list.md`. The inventory shape matches `service/runtime-client.test.ts:123-140`. Whitespace is assumed to match v0 (same REST server). | v1 inventory. `format: "splash"` means `engine: 'splash'` and `host: 'bionic'`. It has one loaded instance, whose `config.context_length` is the context window. |
| `api-v1-models.route-missing.json` | The exact string from `service/lmstudio.test.ts:62`, and the bundle's route-missing template. Returned with **HTTP 200**. Whitespace is assumed pretty, like other bodies from this server. | `isRouteMissingBody` counts as a 404 (plan §5.1; `service/lmstudio.ts:22-24`), which triggers the v0 fallback. Hosts without `/api/v1` (LM Studio before 0.4.0) answer `GET /api/v1/models` this way. Bionic 1.1.6 serves `/api/v1` but answers every unknown route with this body. |

**v1 builder details:**
- LLM keys, in order: `type`, `publisher`, `key`, `display_name`, `architecture`, `quantization{name, bits_per_weight}`, `size_bytes`, `params_string`, `loaded_instances`, `max_context_length`, `format`, `capabilities{vision, trained_for_tool_use[, reasoning]}`, `description: null`.
- Embeddings omit `architecture`, `capabilities` and `description`.
- Every instance `config` carries `context_length` and `reasoning_budget_message` (the builder defaults it to `""`).
- `parallel` is included. The other config keys are omitted because they appear only when the engine reports them.
- `variants` and `selected_variant` are undefined for these models, so `JSON.stringify` drops them.

### `lms ps --json --port <internal>` (stdout)
**Source:** lms@1017bcb `src/subcommands/list.ts:421-472`.
- The JSON branch spreads `model.getModelInfo()` without `instanceReference`, then appends `status`, `queued` and `parallel` (`loadConfig.maxParallelPredictions ?? null`).
- It prints with `console.info(JSON.stringify([...]))`: one compact line plus `\n`.
- The CLI zod-parses every RPC result and resolves `parsed.data`, so keys come out in schema order and unknown keys are stripped. The schemas are lmstudio-js@6d2b268:
  - `packages/lms-shared-types/src/ModelInfoBase.ts:88-134`;
  - `llm/LLMModelInfo.ts:28-74`;
  - `ModelProcessingStatus.ts:8-19`.

  The same schemas are compiled into the installed `lms`.
- `queued` counts requests in the queue **including the current one**.

| File | Provenance | Purpose |
|---|---|---|
| `lms-ps-json.one-loaded.txt` | Synthesized from the source above. Sizes and context match the v1 and v0 loaded model. `format: "yuzu"` is **inferred**: the CLI's `ModelCompatibilityType` enum has no `"splash"`, so a Splash model can only reach stdout as `"yuzu"`. `runtime ls` also reports the Splash engine's format as `yuzu`. | `ResidencyV2` rows with `source: 'lms-ps'`: `sizeBytes` becomes `bytes`, and `contextLength` becomes `contextWindowTokens`. |
| `lms-ps-json.generating.txt` | The same instance with `status: "generating"`, `queued: 1` and a newer `lastUsedTime`. | Residency phase while a request runs. |
| `lms-ps-json.empty.txt` | **Captured live, exact bytes** `[]\n` (no model loaded). | Nothing resident. `lms ps` prints `[]` rather than the human "No models are currently loaded" text when `--json` is set. |

**Fields that never go on the wire:**
- `path` and `indexedModelIdentifier`: model file paths, relative here;
- `deviceIdentifier`: an LM Link remote device;
- `lastUsedTime`.

A newer `lms` (main @1b7181b) appends `engineConfigFileEnabled` after `parallel`, so parsers must ignore unknown keys.

### `lms runtime ls --port <internal>` (stdout)
| File | Provenance | Purpose |
|---|---|---|
| `lms-runtime-ls.bionic-splash.txt` | **Modeled on the live capture**, with the layout copied exactly:<br>• `columnify`, 4-space splitter;<br>• `LLM ENGINE` left-aligned; `SELECTED` and `MODEL FORMAT` centred, with trailing pad spaces kept;<br>• no ANSI colour; one final newline.<br>Source: lms@1017bcb `src/subcommands/runtime/list.ts:71-124`. Rows are `name@version`, sorted by name and then by newest version. Engine names are LM Studio's public runtime names. Versions are synthetic except Splash 0.0.5 (plan §5.2). | Server "Engines" card (`EngineV2 {name, version, selected}`, at most 8; `detail=server`, cached 10 min). It includes the `splash-…@0.0.5 ✓ yuzu` row and an `mlx-llm-…-nax-…` name variant. |

### `lms log stream -s server --json --port <internal>` (stdout NDJSON)
**Record shape:** `{"timestamp":<ms>,"data":{"type":"server.log","content":"…","level":"debug|info|warn|error"}}`.
- lms@1017bcb `src/subcommands/log.ts:88` prints `JSON.stringify(log)` for `data.type === "server.log"` (`:120`).
- The key order comes from `diagnosticsLogEventSchema` / `diagnosticsLogServerEventDataSchema` (lmstudio-js@6d2b268 `packages/lms-shared-types/src/diagnostics/DiagnosticsLogEvent.ts:19-23`, `:97-100`), which the CLI parses channel packets with.
- The "Streaming logs from LM Studio" banner goes to **stderr** (`log.ts:80`; `src/logLevel.ts:85-89`), so stdout is pure NDJSON.

**Content lines** are `[YYYY-MM-DD HH:MM:SS][LEVEL][model tag] message`. The tag is absent on server-level lines.

**The completion summary** comes from the Splash engine's stdout, which Bionic relays at DEBUG without a model tag:
- format: `HH:MM:SS Done · input N · cached N · output N[ · tools …][ · TTFT x.xs][ · y.y tok/s]`;
- source: incoai/splash@e8fffde `server/diagnostics.py:16-46`, byte-identical to the Splash 0.0.5 package Bionic installs;
- `Cancelled · …` and `Error · <code>` are its other forms.

| File | Provenance | Purpose |
|---|---|---|
| `lms-log-stream-server.lifecycle.txt` | Modeled on the captured redacted lines (`service/lmstudio-activity.test.ts:9-19`). | One streaming request with redaction on (the S8 default): `[Sensitive]` request line → `Running chat completion` (request start) → `Streaming response...` → prompt progress 0 / 37.5 / 100 % → `Done ·` summary → `Finished streaming response`. |
| `lms-log-stream-server.non-streaming.txt` | Modeled on the captured non-streaming sequence (`service/lmstudio-activity.test.ts:36-43`) plus a Done summary. | A non-streaming request ends at `Generated prediction: [Sensitive]` instead of `Finished streaming response`. |
| `lms-log-stream-server.drop-request-body.txt` | Modeled on the bundle call `'Received request: ' + method + ' to ' + path + ' with body ' + sensitive(body)` with `logSensitiveData` on. The body is shown as 2-space JSON; its exact whitespace was not captured. | **Must be dropped.** A multi-line record carrying the prompt (`CANARY-PROMPT-7f3a` ×2). |
| `lms-log-stream-server.drop-incoming-tokens.txt` | Modeled on the bundle call `'Accumulated ' + n + ' token' + (n>1?'s':'')` followed by `sensitive(<accumulated text>)`, with `\n` escaped as a literal backslash-n and logged on every fragment when `logIncomingTokens` is on. The separator is obfuscated; one space is assumed. | **Must be dropped.** Per-token lines carrying generated text (`CANARY-OUTPUT-7f3a`). The last line is generated text imitating the Splash summary (`… Done · input 9 · …`) and must never count as a completion. |
| `lms-log-stream-server.drop-oversized.txt` | Same call after 1,050 tokens. Because the whole accumulated text is re-logged on each fragment, these records grow without bound. This line is about 22 KB. | **Must be dropped unread** by the 16 KiB line bound (`MAX_LOG_LINE_BYTES`, `service/lmstudio-activity.ts:196`), with bounded memory and CPU. |
| `lms-log-stream-server.sensitive-on.txt` | The three drop fixtures interleaved, verbatim, with a real lifecycle. | With both log flags on, an adapter must produce the same events as a redacted run, and no canary may reach any output. The canary-bearing lines are exactly the lines from the three drop files. |

## Privacy canaries
| Canary | Where | Must never appear in |
|---|---|---|
| `CANARY-PROMPT-7f3a` | `drop-request-body` and `sensitive-on`: the request body, system and user messages | anything the service returns, logs, stores or exports |
| `CANARY-OUTPUT-7f3a` | `drop-incoming-tokens`, `drop-oversized` and `sensitive-on`: generated text | the same |

No other fixture contains a canary. `fixtures.test.ts` checks both the placement and the absence.

## Known gaps and findings for Stages 3–5
- **Finding: the 1.6 parser accepts the spoofed summary.** `service/lmstudio-activity.ts:72` tests `/(?:^|\s)Done\s*·/` anywhere in the message. It therefore reads the imitation line in `drop-incoming-tokens` as a completion (`done` with numbers from generated text).
  - The adapter should only accept `^(?:\d{2}:\d{2}:\d{2} )?(?:Done|Cancelled) · ` on an untagged DEBUG line.
  - The 1.6 parser drops every other must-drop line: the multi-line body fails its line regex, and the oversized line never passes `BoundedLines`.
- **Unverified (not captured live):**
  - the v0 `"loading"` value;
  - v1 and route-missing whitespace;
  - the `lms ps` record for a loaded Splash model (`format: "yuzu"` and `parallel`);
  - the exact separator in `Accumulated … tokens` lines;
  - request-body whitespace.

  Re-capture these when a model is next loaded with the owner present.
- The content wall-clock is local time on a real machine. The fixtures use UTC so that `timestamp` and `content` agree.

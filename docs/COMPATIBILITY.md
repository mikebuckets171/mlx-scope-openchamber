# Compatibility

## Scope 5.1: qualified and self-checked OpenCode versions

OpenChamber ships a new OpenCode patch every few days, and Scope 4–5.0 accepted only exact versions, so each update
turned chat speed and Splash prompt progress off until Scope caught up. Scope 5.1 splits the decision in two:

| Mode | Versions | What it means |
|---|---|---|
| **Qualified** | OpenCode **2.0.25, 2.0.27, 2.0.28, 2.0.29, 2.0.32** | Native synthetic-provider checks passed for that exact binary (see the receipts below). |
| **Self-checked** | Any other `2.0.N` with N ≥ 25 | The companion confirms, at run time, that each hook registers, that the session header is present on primary requests, and that every event it consumes has the released shape. A feature whose check fails is withdrawn alone, and Connections names the reason (`hook-missing`, `hook-rejected`, `events-missing`, `event-shape`, `session-header`, `options`). |
| **Unsupported** | 2.1 and later, suffixed or malformed versions | No hooks are installed; runtime monitoring continues. |

A self-check proves the shapes Scope reads, not their meaning: a release that changed token accounting with the same
shape would pass. Connections therefore says **self-checked (not yet qualified)** for those versions, and a version moves
to Qualified only after the native checks run against it. The rule lives in `bridge/opencode/compatibility.js`, which
ships with the companion; the qualified list lives in `bridge/opencode/qualified.js`, which stays in the service, so
qualifying a later version changes no companion file and needs no **Update chat speed**.

Scope 5.1 requires companion **3.4.0**. After installing 5.1, choose **Connections → Update chat speed** once and
confirm 3.4.0 is loaded. A 5.1 service accepts any 3.x companion writer of the same telemetry major version, so a
later 3.x companion keeps working; a 5.0 service with a 3.4.0 companion behaves as 5.0 did. When no Scope view has
asked for chat telemetry, the companion's demand watcher backs off to five-second checks instead of one-second ones.

## Earlier policy and safe default checks

Scope evaluates optional OpenCode features independently from native runtime monitoring. The standalone
`bridge/opencode/compatibility.js` rule is shared by hook registration, telemetry parsing and setup. Until 5.1, exact
OpenCode **2.0.25, 2.0.27, 2.0.28 and 2.0.29** were qualified and adjacent versions did not inherit support. The companion
package version, profile revision and Scope telemetry wire version are separate. Schema 1 and the legacy protocol
spelling `opencode-2.0.25` remain unchanged for existing readers. The module ships inside the addon; its declaration
file is only needed for development type checking.

| Feature | Qualification and unavailable behavior |
|---|---|
| HTTP delivery | Documented native HTTP hooks plus the released event protocol. Hook failure leaves WebSocket observation and native engine monitoring available. |
| WebSocket delivery | An explicitly experimental handshake hook, qualified separately for metadata on reused sockets. Hook failure leaves HTTP available. Native cancellation passes on 2.0.27, 2.0.28 and 2.0.29; 2.0.25 retains unit-only interruption coverage. |
| Splash prompt progress | Qualified profile, configured loopback provider and validated streaming counters. Unknown versions install no request mutation. Failed response-hook registration removes its paired request hook. |
| Managed reload | Native file-rename checks on 2.0.27, 2.0.28 and 2.0.29 verify an older unsupported helper and same-version revisions update while a fixture reply completes, without restart or duplicate requests. Configuration tests alone do not establish this. No automatic restart is attempted. |

Optional heartbeat feature entries carry `support` (`compatible`, or the legacy `qualified`; `unqualified`; `unavailable`),
`available` (the hook/API is installed) and, from 3.4.0, an optional `check` (`waiting`, `passed`, or `failed` with one
allowlisted reason). An available feature must be supported. Readers discard unrelated metadata and reject
contradictory entries. Legacy heartbeats remain readable. Setup's optional `compatibility` extension separates these
features from activity: not loaded, awaiting demand, listening, or unavailable. Listening means demanded heartbeat
activity; it does not prove output or transport semantics. Malformed optional metadata does not discard an otherwise
valid legacy setup response. Installed fingerprints, loaded companion metadata and current liveness remain distinct.

Scope 4 and 5.0 required companion **3.3.0** for chat delivery and rejected a different companion package version even when the wire schema matched; native engine monitoring remained independent during that gap.

The runtime profile and the loaded helper's protocol are checked separately. An older helper reporting `unsupported`
on a now-qualified runtime can be updated; its telemetry is still rejected until the current helper is loaded.

Connections → Chat speed → Compatibility & privacy shows support and activity separately. From the repository, run:

```sh
bun run qualify:compatibility
```

To save a new private receipt without overwriting a file:

```sh
node scripts/qualify-compatibility.mjs --output qualification.json
```

Add `--candidate 2.0.26` to label a proposed OpenCode version. Only the finite bundled registry determines support;
an unknown candidate remains `unqualified` even if every reference fixture passes. The command never executes that candidate.

The command runs isolated bridge, service, host replay and storage fixtures, the committed-source privacy scan,
an in-memory comparison of source against the existing built artifacts, and reproducible package verification with
an extracted synthetic service smoke. Run the normal build first; qualification does not overwrite stale bundles.
Package verification creates the local installation ZIP but does not publish it. It does **not** execute a native
OpenCode or OpenChamber binary, submit a prompt, run inference, download a model, install a plugin or edit live
configuration. Test stores/configuration use temporary directories. There is no live mode or executable override.
The panel displays this command as text and cannot execute it.

Reports contain relative source, fixture, profile, dependency and packaged-asset hashes, a ZIP digest, the pinned SDK/API
identity, candidate policy status, independent fixture outcomes, `runtimeExecuted: false`,
`supportChanged: false`, and `nativeRuntime: not-run` for every feature. Success is named `synthetic-pass`; failed or
missing suites, stale bundles and inputs changed during the run cannot pass. Changing a relevant version, profile,
adapter, contract, fixture, dependency or artifact invalidates the receipt. No private host paths, conversation content
or correlation identities enter it. Browser, resource and native protocol gates remain explicitly unrun. This does
not qualify a new runtime, real transport behavior, application reload or performance.

The historical protocol harnesses below launch an isolated real OpenCode process. They are excluded from the default
command and need separate authorization appropriate to the task. Their older receipts retain their original limits.
The unreleased 3.3 measurements likewise retain unresolved gates and do not become Scope 4 release qualification.

To support another release, inspect its documented schema, add normalized event fixtures and an explicit profile,
then independently qualify dispatch identity, event ordering/timestamps, reasoning/token accounting, completion,
reused sockets, tools, retries, replay, interruption, multiple locations and hidden work. API presence alone is not
semantic proof. When authorized, native synthetic-provider receipts should record runtime identity/build fingerprint
when available, adapter/companion hashes and passed/skipped/unqualified outcomes. Preserve wire/storage compatibility,
privacy limits and independent fallback; measure overhead before adding continuous collection.

## OpenCode 2.0.32 compatibility

OpenChamber 2.4.0 bundles OpenCode 2.0.32. Its session event schema, message envelope, usage and transport types are
unchanged from 2.0.29 for every field the companion reads. With companion 3.4.0, the bundled binary passed the isolated
native synthetic-provider checks: local HTTP delivery with advancing prompt progress (200 → 500 → 900 of the fixture
prompt), synthetic-remote HTTP, WebSocket reuse with one cached connection, tool continuation and cancellation,
three-step calibration, completion, hidden shutdown with telemetry writes stopped, and managed hot reload from the
5.0 companion (3.3.0, which reported 2.0.32 unsupported) to 3.4.0 with no server restart and no duplicated request.
The receipt is [`docs/receipts/companion-3.4.0.json`](receipts/companion-3.4.0.json); it also records a paired CPU
fixture against 3.3.0 under the same load: incremental idle CPU 0.021 % vs 0.057 % of one core, visible 1.23 % vs
1.25 %, hidden 0.14 % vs 0.14 %. No real model, inference or cloud account was involved.

## OpenCode 2.0.29 compatibility

Local 4.0.2 qualified the OpenChamber 2.3.3 bundled binary using the existing isolated native synthetic-provider
checks for local and remote HTTP delivery, advancing prompt progress, calibration, completion, WebSocket reuse,
tool continuation, cancellation, hidden shutdown and managed helper reload. Its hot-reload check started from the
previously installed 3.3.0 helper that reported 2.0.29 unsupported. The recorded source review of v2.0.28 to v2.0.29
found no change to the consumed event/usage/transport contracts. Scope 5 preserves that exact profile and the
unchanged wire/schema; it does not duplicate OpenCode's incomplete-tool/output-limit handling. This carries forward
the installed 4.0.2 qualification rather than claiming a new native run of the Scope 5 artifact. No real model or
throughput benchmark was part of those checks.

## OpenCode 2.0.28 compatibility

The binary bundled with OpenChamber 2.3.2 passes isolated native synthetic HTTP local/remote, WebSocket reuse,
completion, calibration, tool continuation, interruption, and hidden-shutdown checks. Managed file-rename reload
covers both an unsupported older helper and a same-version revision during a completing fixture reply, with
no server restart or duplicated request. The same legacy wire/schema and existing exact profiles remain intact.
Source review compares the exact upstream v2.0.27 and v2.0.28 tags; the consumed event/usage/transport schemas
are unchanged. Version 4.0.1 was installed through OpenChamber 2.3.2's native Extensions settings. Connections
confirmed companion 3.3.0 loaded on OpenCode 2.0.28, with HTTP, WebSocket and prompt-progress hooks available.
Real-model performance qualification remains a separate check.

## Host

MLX Scope 5.1 requires **OpenChamber 2.4.0 or newer** (`engines.openchamber` `>=2.4.0`) and pins
[SDK 2.4.0](https://github.com/openchamber/openchamber/blob/v2.4.0/packages/sdk/API.md), retaining manifest API 1. Scope 5.0.0 remains the release for OpenChamber 2.3.3–2.3.x and Scope 4.0.1 for 2.0.4–2.3.2.
It uses the panel, the full page, a Work Status section (`statusSection`, OpenChamber 2.0.1+) whose Watch and Pause
controls are drawn in the host's section header (`setStatusControls`, SDK 2.4), the session-menu action, badges,
toasts, host-managed storage and a local service. The `/scope` command and its background entry were removed in 5.1.

**Installing and updating.** Install from Git (`https://github.com/mikebuckets171/mlx-scope-openchamber#release`):
OpenChamber updates a Git install in place and keeps its storage and permissions. Installing a ZIP over an existing
install replaces it, and the host then deletes the extension's storage (History, baselines, preferences); this is
host behaviour Scope cannot change.

**Service lifetime.** The service exits after ten minutes without an authenticated view request, and OpenChamber starts
it again on the next request. OpenChamber 2.4 respawns an exited service on demand, but this is implemented rather
than documented host behaviour; if a later host stops doing so, Scope views would show the service as unavailable.
The inherited 2.0.4 qualification is historical evidence for the manifest floor; 2.0.2 showed a black status surface. The 3.1 candidate was checked in OpenChamber 2.2.0. Neither observation qualifies a new Scope 4 artifact in a native host. An initial 4.0 candidate was reinstalled through the OpenChamber 2.3.0 UI: Live, Run details, Connections and Session rendered, and Session reported activity through a loaded llama-swap backend. This was a limited install smoke, not an exhaustive host or workload qualification. Desktop and
web clients expose these surfaces; mobile and VS Code clients load no extensions. Runtime and Mac readings belong to the
OpenChamber server's computer.

| Evidence | Status |
|---|---|
| Surfaces, Work Status section, `/scope` via the background entry (removed in 5.1), badge and toast from a status frame, storage cost, session events | Measured on OpenChamber 2.0.4 desktop with a spike extension (`docs/2.0/SPIKES.md` S1–S5) |
| The exact 2.0.0 package: approval dialog, every surface, Turn stats swap, attribution on real turns, ledger, `/scope` chip | Verified in Stage 12 (`docs/receipts/2.0.0-host-qualification.json`) |
| The git-update path from 1.6.1 to 2.0.0 | Rehearsed in Stage 12 in an isolated instance (`docs/2.0/REHEARSAL.md`); if not rehearsed, the receipt says "git-update path not rehearsed" |

OpenChamber 1.24.x–2.0.3 users install the `legacy/1.6.x` line (security and correctness fixes only).

## Optional chat delivery estimates

Chat estimates are qualified on **OpenCode 2.0.25, 2.0.27, 2.0.28, 2.0.29 and 2.0.32** and self-checked on later 2.0 releases, for local and cloud chats alike, retaining the same wire protocol. An
isolated servers with synthetic streaming providers exercise waiting, generation, completion, calibration and
hidden shutdown over both transports. Unsupported versions disable estimates while runtime adapters continue to
operate. Guided setup distinguishes installed/pending from a fresh loaded companion and supports native v2 and legacy
local provider configuration.

**Cloud is supported since 3.2.** OpenCode 2.0.25's built-in `openai` provider defaults to WebSocket transport, so the
companion observes the qualified `experimental.ws.handshake` hook and matches the declared provider origin as a remote
destination. A cloud reading is **delivery observed through OpenCode** — it includes network and provider buffering —
and is never engine throughput. Cloud chats create chat-observation demand for their own selected session only, never
collect LLM runtime or hardware data, and never borrow a local engine measurement or local endpoint. Media monitoring
and every runtime adapter keep working during cloud chats.

`node bridge/opencode/protocol-ws-smoke.mjs /absolute/path/to/opencode` verifies that path end to end against the
installed binary with a synthetic provider rerouted to loopback: request start, live delivery timing, three- and
four-step calibration, a completed-step average, one reused native WebSocket, a native tool continuation, and hidden
shutdown with telemetry writes stopped. The remote HTTP variant is `node bridge/opencode/protocol-smoke.mjs
/absolute/path/to/opencode --remote`. On 2.0.27 the WebSocket smoke also interrupts a fixture step after observing live
speed, verifies speed clears and rejects a completed-step average. The earlier 2.0.25 cancellation attempt produced no
readable delivery state and retains its original unit-only coverage; a new result does not retroactively qualify it.

Managed updates preserve JSONC comments, unrelated options and plugins. The reproducible developer check is
`node bridge/opencode/protocol-hot-reload-smoke.mjs /absolute/path/to/opencode /absolute/path/to/previous/companion`;
it uses an isolated server and verifies that a synthetic response completes during an update without duplication or restart.

Local estimates require observable text/reasoning events, corroborating primary transport metadata and unambiguous usage.
Tool payloads, title/compaction tasks, missing metadata and ambiguous concurrent writers produce no chat speed.
Configured loopback endpoint matching and explicitly labeled Engine fallbacks remain unchanged.

## Runtimes

Every adapter is tested against a fixture corpus in `tests/fixtures/<runtime>/<version>/`, each with a `SOURCE.md`
saying how it was made. **Fixture** means synthetic bodies built from the cited upstream source; **live** means the
runtime was run on the owner's Mac. Runtime versions are compatibility anchors, not minimum requirements. Missing or
unsupported fields stay out of the views.

| Runtime | Versions | Qualification | Coverage |
|---|---|---|---|
| oMLX | [0.7.0rc1](https://github.com/jundot/omlx/tree/35be079d), [0.6.4](https://github.com/jundot/omlx/tree/1d7826185c5b5b69b38b27cbe57d7597b7551fd7) | Fixture; live on the owner's Mac in Stage 12 | Per request |
| Splash via Bionic | Bionic 1.1.6 (Splash runtime 0.0.5) | Fixture, shapes and key order copied from live replies with values replaced; live in Stage 12 | Per request through `lms` |
| LM Studio | [0.4.25](https://lmstudio.ai/changelog/lmstudio/lmstudio-v0.4.25) | Documentation and source notes; no stock LM Studio reply was captured | Inventory, per request with `lms` |
| Splash (standalone) | [1.2.0](https://github.com/incoai/splash/tree/f43509a2f03d83b4442a0fab748e8b0fb49aa817), [1.1.0](https://github.com/incoai/splash/tree/3e1f9ece3e2528f3eb46b82a05911591f34a4317), [1.0.2](https://github.com/incoai/splash/tree/e8fffde2c3a1d1c4120028d9e5399bb917b8b917) | Fixture; 1.2.0 captured from a local server and scrubbed; 1.1.0 key paths checked against a local server; live in Stage 12 when running | Server-wide |
| llama-server | [b10519](https://github.com/ggml-org/llama.cpp/tree/b10519), [b6700](https://github.com/ggml-org/llama.cpp/tree/b6700) | Fixture only | Slots, server-wide |
| Ollama | [0.40.0](https://github.com/ollama/ollama/tree/v0.40.0-rc0) | Fixture only | Residency |
| vllm-mlx | [0.5.0](https://github.com/waybarrios/vllm-mlx/tree/b064502055a68aaf94c6c58f9c0d749e0bd4f8cb) | Source review and synthetic fixtures | Per request, server-wide |
| mlx-lm | [0.31.3](https://github.com/ml-explore/mlx-lm/tree/ed1fca4cef15a824c5f1702c80f70b4cffc8e4dd) | Source review and synthetic fixtures | Inventory |
| llama-swap (in front of any of the above) | v263 | Synthetic `/running` fixtures; recognized and read live on the owner's Mac with no model loaded | As the model server it fronts |
| macOS host | macOS 27 on Apple Silicon | Fixture for every probe; `vm_stat` and `sysctl` also run live in the macOS checks; `ioreg`, `notifyutil`, `lsof`, `footprint` and macmon live in Stage 12 | Host |

## oMLX

The activity API distinguishes no model, resident idle, loading, queue, prefill, generation, and generic processing.
Normal prefill uses reported processed/total counts and a valid stage estimate. Stale progress remains visibly held,
while speed and estimate are withheld. Request changes and ambiguous concurrency break observation continuity. Cache
reuse requires matched request identity. Context headroom uses the reported model limit, which may differ from a
request-profile override. Process footprint, model allocation, RAM cache, and SSD cache stay separate.

2.0 reads `/health` (including the engine pool's memory ceiling), `/api/status` and the admin activity API. It never
calls `/admin/api/stats`, whose response includes credentials. When the admin login refuses a sub key, Scope falls back
to `/api/status` with server-wide coverage and says so. The usage card reads `/admin/api/usage` for 7, 30 and 90 days,
cached for 5 minutes and labelled "Recorded by oMLX"; per-day request detail is requested only for today, yesterday and 7
days, and at most 50 models are kept. The oMLX process footprint comes from `lsof` and `footprint` on the listening port.

The primary DFlash engine reports accepted output through generic activity counters. Activity elapsed time includes
preparation and is not a generation duration. MLX Scope calculates **recent output** from fresh counter differences.
Before output, it shows processing without a prefill percentage or estimate. Standard fallback retains its reported
prefill and generation behavior. Lightning/MTP appear only through the same recognized telemetry contracts.
Session/last-request speculation totals do not become current-request acceptance ratios. Distributed rank records do
not establish individual request identity.

## vllm-mlx

The [status endpoint](https://github.com/waybarrios/vllm-mlx/blob/b064502055a68aaf94c6c58f9c0d749e0bd4f8cb/vllm_mlx/server.py)
provides server counts and request records. Per-request output/speed requires one canonical running request, a
matching model/identity, and fresh output advancement. Concurrent or ambiguous requests withhold the headline rate.
Reported runtime counters are not guaranteed successful-completion counts.

Prefill differs by engine. The LLM `progress` field measures output against its output limit, so it is never used as
prefill. Only batched MLLM reports a usable prefill fraction. Zero/one are ambiguous and withheld; held fractions wait
for observed advancement after a gap. Request-matched reuse is exposed only for the text batched engine with a
recognized cache classification and consistent counts. Model-registry mode reports model availability/residency without
per-model request statistics. Metal allocator memory is not presented as an OS process footprint. A missing optional
endpoint (`/health`) removes the readings it supplies, not the runtime.

## LM Studio

[GET `/api/v1/models`](https://lmstudio.ai/docs/developer/rest/list), introduced in 0.4.0, reports models, format, and
loaded instances. Scope uses each instance's configured context limit when unambiguous. A model's file size is not RAM
usage; configured parallelism is not active work. Loaded means loaded, not idle. A route-not-found response, or HTTP 200
with an "Unexpected endpoint" error body, permits the documented [v0 model API](https://lmstudio.ai/docs/developer/rest/endpoints)
fallback (0.3.6+). Authentication failures and malformed responses do not trigger that fallback. A change in the
`/api/v0/models` load state counts as a new connection generation.

When the `lms` CLI is installed (`~/.lmstudio/bin/lms` or `~/.cache/lm-studio/bin/lms`), Scope also follows
`lms log stream -s server --json` while a view is open (verified with LM Studio Bionic 1.1.6 and its Splash runtime
0.0.5). From that redacted server log it reads:

- `Running chat completion` with the model tag: a request started.
- `Prompt processing progress: N%`: prompt-reading progress; 100% means generating.
- `Done · input N · cached N · output N · TTFT Ns · N tok/s`: the exact completion figures (Bionic's Splash engine prints
  it; stock LM Studio prints no such line, so its completions are not recorded).
- `Finished streaming response`: the request ended.

`lms ps --json` lists loaded instances on a generation change and every 3 minutes after, and `lms runtime ls` fills
the Engines card in Server & Mac details, cached for 10 minutes. Every `lms` command runs only after the LM Studio greeting
answered within the last 10 seconds, with `--port` and the server-info path, so it connects to the running app instead
of launching LM Studio or Bionic. The stream follows the LM Studio app of the local LM Studio home and applies only to
the connection on that home's REST port. It stops within a minute of the last read. Without `lms`, the view shows
inventory and host resources only. With authentication enabled, use an existing
[LM Studio API token](https://lmstudio.ai/docs/developer/core/authentication).

## Splash in Bionic

Bionic (an LM Studio-based app) serves Splash models through its LM Studio-compatible API: `/api/v1/models` reports
`format: "splash"` (v0: `compatibility_type`). MLX Scope monitors it with the LM Studio adapter above and shows it as
"Splash via Bionic" with a Splash badge per model. Live activity comes from Bionic's redacted server log via `lms`.
Bionic's embedded Splash engine listens on a random loopback port and protects its own `/status` with a key that Bionic
injects; MLX Scope does not read that key or scan for that port, so Metal allocation and Splash's native request
counters are not shown for Bionic-hosted Splash.

## Splish / Inco AI Splash (standalone)

MLX Scope reads the passive `/status` endpoint only; there is no `/metrics` read. It detects a server from a JSON body
with a boolean `ready`. It shows the active model and declared maximum context, idle or generating state with in-flight
requests, completed/failed counters since engine start, live server-wide decode throughput, lifetime averages, current/peak Metal allocator
values, and on 1.1 and later the model's vision support and input kinds, plus Splash's own first-token and inter-token latency
p50/p95 with their sample counts (over Splash's last 4,096 samples). States take this precedence: recovering, status stale,
not admitting, ready. While Splash recovers, its body is the cached pre-crash snapshot, so no activity is derived from
it and Scope reads it at most every 30 seconds. Counters reset when the engine restarts; a drop is a reset, not a
completion. Crash traces, transport error text, and instance and identity fields are never forwarded. 1.0.2 lacks the
1.1 fields, which are then left out. Splash 1.2 (status schema 6) renamed the HTTP first-token histogram
`latency.ttft` to `latency.http_ttft`; a finished reply's first-token time is derived from whichever one the server reports.

Live tok/s uses the change in `metrics.decode_output_tokens` divided by the change in `metrics.decode_wall_ms`,
multiplied by 1,000, between two fresh, ready polls while native decoding is active. These counters advance after
each decode batch in both [Splish](https://github.com/publicExcess/splish/blob/m5/runtime/engine/Status.hpp) and
[Splash](https://github.com/incoai/splash/blob/main/runtime/engine/Status.hpp). It is native server-wide decode throughput,
not end-to-end streamed delivery speed or a per-chat rate. A baseline is required after connection, idle, recovery,
counter or engine resets, invalid clocks, and gaps longer than five seconds. A poll with no counter progression
has no live reading. The lifetime `decode_tokens_per_second` and retained `current_decode_batch` rate are never
substituted for a live sample. The existing one-second active / two-second idle cadence is unchanged.

`/status` does not provide supported per-request progress, active-context use, cache reuse, or process RSS.
Scheduler counts describe server-wide queue/prefill/decode activity. Metal allocation is not process memory or
model-only allocation. All server throughput stays server-wide even when only one request appears active.

## llama-server

Detection uses `/props` with `build_info` and `total_slots`. `/props` supplies the context size, the sleeping flag and
the model name, cut from `model_path` to its last segment. `/health` returns 503 while a model loads. On builds that can
sleep, `/slots` is read only while `/metrics` reports `requests_processing` ≥ 1, so Scope never wakes a sleeping
server; start the server with `--metrics` for live slots and server rates. `/slots` is read for numeric fields only,
never prompts or generated text.

Live speed is the change in decoded tokens of the single busy slot over time (observed); with two or more busy slots it
is withheld. A reply is recorded when the only busy slot goes idle. Server rates and speculative-decoding acceptance come
from `/metrics` token counters divided by their own seconds counters (derived). Those counters move only when a request
completes, so a zero change mid-request means "no rate yet", and the windowed throughput gauges are never used. Router
mode is not supported.

## llama-swap

[llama-swap](https://github.com/mostlygeek/llama-swap) answers on the provider's port and starts, stops and swaps the
model servers behind it. When a connection's server is not otherwise readable, Scope asks llama-swap's `GET /running`
once; if it answers, Scope follows the one model listed as `ready` and reads that model's own loopback server (its
`proxy` address) with the usual adapter, so a Splash model is read exactly like standalone Splash. The connection keeps
its OpenCode identity, so This chat matching and the chat companion are unchanged, and it is named, for example,
**Splash via llama-swap**.

Scope only reads `GET /running`, then the model server. It never calls llama-swap's `/upstream/…` routes or anything
else that would start, stop or swap a model, and never sends the provider's key to the model server. A model that is
starting shows **Loading**; with nothing running Scope shows **No model loaded**, and llama-swap starts a model on the
next chat request as usual. A swapped model is a new engine generation, so readings never continue across models. A
backend that is not a numeric-loopback HTTP address is never read, and when several models are ready Scope follows the
provider's configured model or reads none.

## Ollama

Detection uses `/api/version`, then `/api/ps` for residency: which models are loaded, their size, the GPU-resident part
as Ollama reports it (never called VRAM), and when each unloads. Ollama reports residency only, so there are no
per-request readings, completions or per-chat labels.

## mlx-lm

The [official server](https://github.com/ml-explore/mlx-lm/blob/ed1fca4cef15a824c5f1702c80f70b4cffc8e4dd/mlx_lm/server.py)
exposes health and `/v1/models`. The model endpoint lists locally available files; it does not prove a model is loaded.
Scope displays that catalogue and host resources. Request progress, output speed, context headroom, cache, and
residency stay unavailable. The generic responses are not a reliable runtime fingerprint, so mlx-lm is detected by
provider name only: use a recognizable provider name or choose **mlx-lm** in the connection setup. The catalogue is
cached for a minute because reading it scans the model cache.

## OpenChamber boundaries

The SDK provides no hook into the host's own Turn stats and no way to hide a host section, so the Turn stats swap is a
user setting in the Work Status panel's **Panel sections**. It provides no per-session token event and no push from a
service, so measurement views poll. The measurement pipeline uses the open chat’s ID, busy state, model and turn events. Scope 5.1 separately offers opt-in current-project activity through `sessions` (5.0's `shells` command status is gone). This transient view does not improve engine attribution or enter history/exports. No per-session inference rate is inferred from host activity. It does not scrape host DOM, read OpenChamber's
settings, or intercept inference streams on its own. The optional companion observes supported OpenCode events and retains the
Splash response observer described above. Scope observes configured local connections; it does not manage models, cache,
inference, or credentials.

OpenChamber 2 runs OpenCode 2 and reads native local provider definitions from `providers.<id>.settings`; MLX Scope
recognizes those alongside the v1 `provider.<id>.options` form. OpenCode 2's connected credentials are stored in
private database storage. Scope does not inspect that database and cannot promise access to credentials available only
through `/connect`. Project-only provider definitions remain outside Scope's discovery boundary.

## Media monitoring

Phosphene 4.19 is read through its own `GET /status` (observe-only; found at `127.0.0.1:8198` by its `/version`
answer). Its LTX and H3 step counters, H3 window number and its own time-left estimate are used; the estimate is
labelled **app estimate**. This was verified read-only against an installed Phosphene 4.19.5 at rest; the running-job
shapes come from its 4.19.5 source and fixtures, not from a captured render.

### Media monitoring in 3.1

ComfyUI basic monitoring uses existing lifecycle APIs. Detailed node-local progress is initially qualified for ComfyUI 0.38.0 with Scope’s optional helper. Other versions keep basic monitoring; unknown nodes use indeterminate progress or generic units. Cancellation is enabled only on a qualified job-scoped API.

The local-video adapter recognizes the existing standard OpenCode video queue; custom queue directories are read-only unless their scoped cancellation owner is separately supported. Qwen image tracking requires the producer’s metadata/control integration. Other tools can publish the documented private [Media telemetry contract](MEDIA.md). Supporting a generator’s telemetry does not imply that Scope installs, launches or controls generation for it.

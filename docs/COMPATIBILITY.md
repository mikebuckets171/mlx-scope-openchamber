# Compatibility

## Host

MLX Scope 2.0 requires **OpenChamber 2.0.4 or newer** (`engines.openchamber` `>=2.0.4`) and pins
[SDK 2.0.4](https://github.com/openchamber/openchamber/tree/main/packages/sdk), which keeps manifest API 1 and wire v1.
It uses the panel, the full page, a Work Status section (`statusSection`, OpenChamber 2.0.1+), a `/scope` slash command
answered by a background entry, the session-menu action, badges, toasts, host-managed storage and a local service.
2.0.4 is the only host 2.0 is qualified on: 2.0.2 showed a black status surface, so the floor is not lower. Desktop and
web clients expose these surfaces; mobile and VS Code clients load no extensions. Runtime and Mac readings belong to the
OpenChamber server's computer.

| Evidence | Status |
|---|---|
| Surfaces, Work Status section, `/scope` via the background entry, badge and toast from a status frame, storage cost, session events | Measured on OpenChamber 2.0.4 desktop with a spike extension (`docs/2.0/SPIKES.md` S1–S5) |
| The exact 2.0.0 package: approval dialog, every surface, Turn stats swap, attribution on real turns, ledger, `/scope` chip | Verified in Stage 12 (`docs/receipts/2.0.0-host-qualification.json`) |
| The git-update path from 1.6.1 to 2.0.0 | Rehearsed in Stage 12 in an isolated instance (`docs/2.0/REHEARSAL.md`); if not rehearsed, the receipt says "git-update path not rehearsed" |

OpenChamber 1.24.x–2.0.3 users install the `legacy/1.6.x` line (security and correctness fixes only).

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
the Server tab's Engines card, cached for 10 minutes. Every `lms` command runs only after the LM Studio greeting
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
service, so views poll. Scope does not request the `sessions` capability: it sees only the open chat (its ID, busy
state, model and turn events) and never lists projects or other chats. It does not scrape host DOM, read OpenChamber's
settings, or intercept inference streams. It observes configured local connections; it does not manage models, cache,
inference, or credentials.

OpenChamber 2 runs OpenCode 2 and reads native local provider definitions from `providers.<id>.settings`; MLX Scope
recognizes those alongside the v1 `provider.<id>.options` form. OpenCode 2's connected credentials are stored in
private database storage. Scope does not inspect that database and cannot promise access to credentials available only
through `/connect`. Project-only provider definitions remain outside Scope's discovery boundary.

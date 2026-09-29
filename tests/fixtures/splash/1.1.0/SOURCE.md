# Splash 1.1.0 fixture corpus

**Version represented:** Splash **1.1.0**, upstream `incoai/splash` tag `1.1.0`
(commit `3e1f9ece3e2528f3eb46b82a05911591f34a4317`). The owner's splish fork serves identical server code
(SPIKES S7), so these bodies also stand for splish 1.1.x. `/status` `schema_version` is `5`, the same as 1.0.x;
detect 1.1 by the presence of `vision`, `input_modalities` and `chat_template`.

**Provenance: synthesized from upstream source, every value synthetic.** A throwaway generator (not committed)
mirrors the upstream serializers listed below, key for key and in order, and simulates a request history to fill in
consistent counters. The key set, key order and JSON value types of `status.ready-idle.json` and `status.vision.json`
were cross-checked against one GET-only read each of `/status`, `/v1/models` and `/metrics` from a local 1.1-series
Splash server on 2026-09-29: all 638 key paths matched in order, with identical types. The `/metrics` series names
and order also matched (343 lines, 108 series). No live value was copied: model ids, sizes, counters, timings,
hashes, host, port, PID and paths are all invented. No inference was sent.

**Encoding.** Bodies are byte-for-byte what `server/json_codec.py:12,38-42` emits: compact separators,
`ensure_ascii=False`, and no trailing newline. The native engine prints doubles with C++ `setprecision(10)`, which
Python parses and re-encodes. Integral doubles therefore arrive as JSON integers (for example
`"pending_unmap_ms":0`, `"oldest_wait_ms":0`), and adapters must accept both integers and floats. Python-side floats
keep full `repr` precision (for example `"status_age_ms":0.0`).

## Upstream sources (tag `1.1.0`)

| Part of the body | Source |
|---|---|
| Route `GET /status` → `FrontendServer.status()` | `server/server.py:401-403` |
| Route `GET /metrics` (Prometheus 0.0.4 text) | `server/server.py:404-410`, `server/metrics.py:22-207`, `server/latency.py:98-110` |
| Route `GET /v1/models` (data + typed `models`) | `server/server.py:420-455` |
| `instance` (`id` = `secrets.token_hex(12)`, `pid`, `model`, `host`, `port`, `started_at` = `time.time()`) and `http` | `server/server.py:1730-1731,1740-1757`; `HttpAdmission.stats` `server/server.py:1637-1639` |
| `vision`, `input_modalities` (`["text","image","pdf"]` or `["text"]`), `chat_template`, `frontend`, the caches, `latency` | `server/frontend.py:283-304`; `server/chat_templates.py:39-41,135-142`; `server/constraints.py:219-228`; `server/frontend.py:174-183`; `server/images.py:207-215`; `server/tokenization.py:124-134` |
| `latency.<stage>` histograms (seconds; 18 fixed buckets + `+Inf`; 11 stages; process lifetime) | `server/latency.py:9-41,65-79` |
| `transport.*`, the stale-snapshot rule and the `ready` override | `server/backend.py:382-438` |
| Native engine JSON (`schema_version` … `metal`) | `runtime/engine/Status.cpp:58-341` |
| `metrics.ttft_ms` / `itl_ms` (window of the last 4,096 samples, nearest-rank percentile) | `runtime/engine/Status.hpp:100,238-247` |
| `memory_plan` (`device`, `model`, `budget`) and `memory_audit` | `runtime/engine/MemoryPlan.cpp:47-65,107-141,143-177,265-273`; `runtime/engine/MemoryAudit.cpp:176-195` |
| KV format names, `identity.cache.dtype` | `runtime/ops/PagedKv.hpp:22-37` |
| `warmup.detail` text | `runtime/model/Runtime.mm:2535-2537` |
| `STATUS_SCHEMA_VERSION = 5` | `server/protocol.py:18` |
| Real crash-trace location (for reference) | `server/crash_trace.py:46,173-176`; `server/runtime.py:567-570` |
| `restart_count` increments when a replacement engine is spawned | `server/runtime.py:880-885` |

## Files

State: the SPIKES S7 precedence result (recovering > status_stale > not admitting > ready).

| File | State | What it is for |
|---|---|---|
| `status.ready-idle.json` | Ready | A language-only model (`vision:false`, `input_modalities:["text"]`), idle: 54 submitted, 53 completed, 1 cancelled. `metrics.itl_ms.samples` sits at the 4,096 cap. Also the source body for `metrics.ready-idle.txt`. |
| `status.decoding.json` | Ready | Two requests in flight (`submitted − completed − failed − cancelled = 2`). `scheduler.prefilling:1`, `scheduler.decoding:1`, `state.active_cells:2`, `transport.pending:2`, `http.requests.active:2`, with valid `current_prefill_batch`/`current_decode_batch` and `metrics.ttft_ms`/`itl_ms {p50,p95,samples}`. `latency.ttft.count` is already +1 over `ready-idle` while `requests.completed` is unchanged: a first token arrives before completion. |
| `status.recovering.json` | Recovering | The engine crashed mid-decode. `transport.ready:false`, `recovering:true` and also `status_stale:true` (the native read fails while the transport is down). `restarts:1`, with the crash-trace and `transport.error` canaries. The native part is the cached **pre-crash** snapshot (the `decoding` numbers) with `ready` forced false. Never derive activity from it. Poll no faster than every 30 s. |
| `status.status-stale.json` | Status stale | The transport is up, but a native status refresh is pending. `status_stale:true`, `status_age_ms` > 0, the `transport.error` canary, `ready:false`, and a cached native part that still shows `scheduler.decoding:1`. |
| `status.stale-no-snapshot.json` | Status stale | The very first native read timed out, so there is no cached snapshot. The native part is only `{"schema_version":5,"ready":false}`: no `requests`, `metrics`, `scheduler`, `metal`, `memory_pressure` or `identity`. `status_age_ms` is `0.0`. This is the missing-keys robustness case. |
| `status.metal-unhealthy.json` | Not admitting | `metal.healthy:false`, and `metal.failure_reason` carries the `CANARY-METAL-7f3a` free text. `metrics.metal_failures:1`, `ready:false`, transport up. |
| `status.memory-critical.json` | Not admitting | `memory_pressure:"critical"`, `memory_governor.system_pressure:"critical"`, `growth_allowed:false`, `host_headroom_bytes:0` and `denied_reservations:2`. One request is waiting for memory (`admission.waiting_memory:1`, `scheduler.waiting_resources:1`, in flight 1). `ready:false`. |
| `status.vision.json` | Ready | A vision model: `vision:true`, `input_modalities:["text","image","pdf"]` and `chat_template.later_system:"patched"`. It has non-zero `images.encodes`/`embedding_reuses`, `image_cache` entries, `latency.images` durations and `memory_plan…vision_weights_bytes`. |
| `status.ready-after-crash.json` | Ready | Read after `status.recovering.json`. The replacement engine is ready (`restarts:1`) and `last_crash_trace` is **still set**, so it must stay off the wire while Ready. Native counters restarted from zero (`requests.completed:2`, `metrics.ttft_ms.samples:2`), while Python-side `latency.*` kept counting. The pair `recovering → ready-after-crash` is the counter-reset negative control. |
| `status.delta1-before.json` | Ready | The first read of the Δ=1 pair. It is byte-identical to `status.ready-idle.json` by design. |
| `status.delta1-after.json` | Ready | The next idle read. `latency.ttft.count` +1, `requests.completed` +1, `requests.submitted` +1 and `metrics.ttft_ms.samples` +1, with 0 active at both reads. Per-request HTTP TTFT = Δ`latency.ttft.sum` × 1000 = **412.5 ms**, labelled `derived`. |
| `status.delta2-before.json` | Ready | A later idle read (one more request than `delta1-after`). |
| `status.delta2-after.json` | Ready | Two requests completed between reads: Δcount = Δcompleted = 2. Per-request TTFT must be withheld; the aggregate mean Δsum/Δcount is 944.75 ms. |
| `v1-models.language-only.json` | — | `/v1/models` for a language-only model: `vision:false`, `input_modalities:["text"]`, `max_model_len` = `context_length` = 131072, plus the typed `models[]` list. |
| `v1-models.vision.json` | — | `/v1/models` for a vision model: `vision:true`, `input_modalities:["text","image","pdf"]`. |
| `v1-models.alias.json` | — | The server was started with a served-model alias. `data[1]` is `example-alias` with `root` set to the resident model. |
| `metrics.ready-idle.txt` | — | One `/metrics` sample, kept only for the S7 "read `/status` only, drop `/metrics`" decision. It was rendered by running upstream `prometheus_metrics()` (`server/metrics.py@1.1.0`) on `status.ready-idle.json`: 343 lines, 108 series, 11 typed `splash_<stage>_seconds` histograms, and every value is already present in `/status`. A live `/metrics` read triggers its own native status call, so its values would differ slightly from a separate `/status` read. |

## Privacy canaries (Class A: must never reach routes, storage, DOM, logs or shares)

| Path | Canary | Where |
|---|---|---|
| `instance.id` | `CANARY-INSTANCE-7f3a` (real format: 24 hex chars) | every `status.*` |
| `instance.pid` | `4242` | every `status.*` |
| `instance.host` | `198.51.100.42` (RFC 5737 TEST-NET-2, distinct from any connection URL; real value: the bound IP) | every `status.*` |
| `instance.port` | `18742` (distinct from the `:8000` connection port so a leak is detectable) | every `status.*` |
| `instance.started_at` | `1790636042.4242` | every `status.*` |
| `identity.cache.loaded_model_layout_sha256`, `.runtime_cache_namespace`, `.build_id`, `identity.kv.target_model_sha256`, `identity.q8.target_model_sha256` | `CANARY-IDENTITY-{LAYOUT,NAMESPACE,BUILD,TARGET}-7f3a` (real values: 64-hex digests and a build id) | every `status.*` except `stale-no-snapshot` |
| `transport.last_crash_trace` | `/Users/fixture/Library/Logs/splash/CANARY-CRASH-7f3a.trace` (the real path would be `~/Library/Logs/Splash/crash/splash-crash-g<N>-<UTC>.json`) | `recovering`, `ready-after-crash` (null elsewhere) |
| `transport.error` (free text) | contains `CANARY-ERROR-7f3a` | `recovering`, `status-stale`, `stale-no-snapshot` (absent elsewhere) |
| `metal.failure_reason` (free text) | contains `CANARY-METAL-7f3a` | `metal-unhealthy` (`""` elsewhere) |

- `metal.failure_reason` is **not** on S7's never-forward list. It is planted because it is free text, like
  `transport.error`. The recommendation is to forward presence only.
- `instance.model` (`publisher/Example-27B-4bit`) and `memory_plan.model.model_name` (`example-27b`) are model names
  (Class B), not canaries.
- `/status` carries no prompt text, so no `CANARY-PROMPT-7f3a` is planted. `/metrics` and `/v1/models` carry none of
  the canaries above.

## Notes for the adapter author

- **Contract discrepancy.** Upstream `input_modalities` uses `"pdf"` (`frontend.py:284-286`), while
  `docs/design/2.0-contract.md` types `inputModalities` as `'text' | 'image' | 'audio'`. The contract type needs `'pdf'`.
- Units: `latency.*` is in seconds (Python, process lifetime); `metrics.*_ms` is in milliseconds (native, last ≤4,096
  samples); memory values are in bytes.
- Native sections (`requests`, `metrics`, `scheduler`, `cache`, `state`, `kv`, `model_timing`, …) belong to the engine
  child process and reset when it is replaced. `transport.restarts` increments when the replacement is spawned, so it
  can still read 0 early in recovery. Treat any negative Δ as a reset and derive nothing from it.
- A stale body (`status_stale:true`) is a cached copy of the last native snapshot with `ready` forced false. Its
  activity counters are old.
- On the wire, `latency.<stage>.buckets` keys come in ascending bound order. `JSON.parse` moves the integer-like keys
  (`"1"`, `"5"`, `"10"`, …) first, so walk buckets by parsed bound, not by object key order.

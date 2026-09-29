# Splash 1.0.2 fixture corpus

**Version represented:** Splash **1.0.2**, upstream `incoai/splash` tag `1.0.2`
(commit `e8fffde2c3a1d1c4120028d9e5399bb917b8b917`). Use it as the "pre-1.1" baseline: `/status` still reports
`schema_version: 5`, so the only way to tell 1.0.x from 1.1 is that `vision`, `input_modalities` and
`chat_template` are **absent**.

**Provenance: synthesized from upstream source, every value synthetic.** The throwaway generator used for `../1.1.0/`
(not committed) switches to the 1.0.2 serializers listed below. No 1.0.2 server was run or captured. The key set and
key order come from the 1.0.2 source, and the differences from the live-verified 1.1.0 shape were checked
path by path against the upstream `1.0.2 → 1.1.0` source diff. Model ids, sizes, counters, timings, hashes, host,
port, PID and paths are all invented.

**Encoding:** byte-for-byte what `server/json_codec.py:12` emits: compact, `ensure_ascii=False`, no trailing newline.
Native doubles print with C++ precision 10, so integral doubles arrive as JSON integers.

## Upstream sources (tag `1.0.2`)

| Part of the body | Source |
|---|---|
| Route `GET /status` → `FrontendServer.status()` | `server/server.py:364-366`, `server/server.py:1699-1716` (`instance` id/started_at: `:1689-1690`; `HttpAdmission.stats` `:1596-1598`) |
| Route `GET /v1/models` (no `vision`, `input_modalities`, `max_model_len` or `context_length` fields) | `server/server.py:383-415` |
| Route `GET /metrics` (exists in 1.0.2, not sampled here) | `server/server.py:367-373`, `server/metrics.py:22-203` |
| `frontend`, `grammar_cache`, `response_store`, `image_cache`, `latency` (no `tokenizer_cache`, no 1.1 feature fields) | `server/frontend.py:166-175,267-280` |
| `latency` stages: **10**, without `grammar` | `server/latency.py:9-40,64-78` |
| `transport.*` (`error` = `str(stale_error)`) and the `ready` override | `server/backend.py:355-410` |
| Native engine JSON | `runtime/engine/Status.cpp:58-305` |
| `memory_plan` / `memory_audit` | `runtime/engine/MemoryPlan.cpp:47-65,108-134,136-169,247-255`; `runtime/engine/MemoryAudit.cpp:154-173` |
| `identity.cache.dtype` (`kQ8FormatName`) | `runtime/engine/RuntimeResources.hpp:36-37` |
| `warmup.detail` text ("packed Q8") | `runtime/model/Runtime.mm:2464-2466` |
| `STATUS_SCHEMA_VERSION = 5` | `server/protocol.py:18` |

**Shape differences from 1.1.0** (asserted indirectly by `../fixtures.test.ts`):
- There are no `vision`, `input_modalities`, `chat_template` or `tokenizer_cache` keys, and no `latency.grammar` stage.
- Native differences:
  - no top-level `disk` object;
  - `state` has no `disk_*`, `offloads`, `offload_failures` or `invalidations`;
  - `cache` has no `kv_disk_hit_tokens`, `lost_state_misses` or `disk_state_publications`;
  - `scheduler` has no `decode_mixed_greedy_sampling_batches`;
  - `draft_context.active_rows` replaces `prompt_end_rows`.
- `identity` has `cache` + `q8` (with no `format` key) and no `kv`.
- In `memory_plan.model`, `kv_quantization_bits` is always 8. There is no `kv_format` or `kv_page_bytes`, only
  `q8_page_bytes`, and neither `model.memory` nor `budget` has `kv_staging_bytes`.
  1.0.2 also requires vision weights, so `vision_weights_bytes` is non-zero.
- `/v1/models` `data[]` items are `{id, object, created, owned_by}`, plus `root` for an alias.

## Files

| File | State (S7 precedence) | What it is for |
|---|---|---|
| `status.ready-idle.json` | Ready | Idle 1.0.2 server: 31 submitted, 30 completed, 1 cancelled. The negative case for 1.1 feature detection. |
| `status.decoding.json` | Ready | Two requests in flight (`scheduler.prefilling:1`, `scheduler.decoding:1`, `transport.pending:2`, `http.requests.active:2`) with native `metrics.ttft_ms`/`itl_ms {p50,p95,samples}`. |
| `status.recovering.json` | Recovering | `transport.ready:false`, `recovering:true`, `status_stale:true`, `restarts:1`, plus the crash-trace and `transport.error` canaries. The native part is the cached pre-crash (`decoding`) snapshot with `ready` forced false. |
| `v1-models.default.json` | — | `/v1/models` with the resident model only: no catalog chips in 1.0.2. |
| `v1-models.alias.json` | — | The same, started with a served-model alias. `data[1]` is `example-alias` with `root` set. |

## Privacy canaries

These are the same sentinels as `../1.1.0/SOURCE.md`:
- `instance.id` `CANARY-INSTANCE-7f3a`, `instance.pid` `4242`, `instance.host` `198.51.100.42`, `instance.port` `18742`
  and `instance.started_at` `1790636042.4242` are in every `status.*` file.
- `identity.cache.{loaded_model_layout_sha256,runtime_cache_namespace,build_id}` and `identity.q8.target_model_sha256`
  hold `CANARY-IDENTITY-*-7f3a` in every `status.*` file.
- `transport.last_crash_trace` `/Users/fixture/Library/Logs/splash/CANARY-CRASH-7f3a.trace` and a `transport.error`
  containing `CANARY-ERROR-7f3a` appear only in `status.recovering.json`.
- `instance.model` `publisher/Example-27B-4bit` is a model name (Class B), not a canary.
- No prompt text exists in these routes, and `/v1/models` carries no canary.

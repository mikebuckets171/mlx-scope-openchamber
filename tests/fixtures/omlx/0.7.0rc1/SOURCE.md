# oMLX 0.7.0rc1 fixture corpus

**Version:** oMLX `0.7.0rc1` ([jundot/omlx@v0.7.0rc1](https://github.com/jundot/omlx/tree/35be079d8a86a44dc2c6d485fbfbf43754e66298),
commit `35be079d8a86a44dc2c6d485fbfbf43754e66298`). Per SPIKES S6, re-diff these at 0.7.0 final.

**Provenance.** Every file is **synthetic**. Each body was produced by a transcription of the cited upstream handler,
fed with made-up state. Nothing was copied from a live response.
- The four `/health` keys and the four `engine_pool` keys were checked against one unauthenticated `GET /health` on a
  local oMLX 0.7.0rc1. Only key names and value types were read; no values were kept.
- The installed app bundle's `server.py`, `admin/routes.py`, `admin/auth.py`, `usage_history.py`, `server_metrics.py`,
  `prefill_progress.py`, `process_memory_enforcer.py`, `engine_pool.py`, `model_discovery.py`,
  `custom_kernels/__init__.py` and `utils/install.py` are byte-identical to the tag.
- The 401, 404, 422 and 503 bodies were reproduced in-process: a FastAPI app carried the same route signature and
  exception handlers (FastAPI 0.141.1 / pydantic 2.13.5 from the bundle), and a `TestClient` called it. No request
  went to a running oMLX.
- **Not live-validated.** `/api/status`, `/admin/api/usage`, `/admin/api/activity` and `/admin/api/stats` were never
  requested (no key, no admin login).

**Encoding.** Each body is exactly what Starlette's `JSONResponse.render` emits: compact separators, `ensure_ascii=False`,
Python key order, Python float repr (`0.0` stays `0.0`, integer counters stay integers). One trailing LF is added for
`.editorconfig`; the HTTP body has none. The HTTP status is not in the file; see the table.

**Synthetic values.**
- Models: `Example-27B-4bit`, `Example-35B-A3B-4bit`, `Example-8B-4bit`, `Example-Embed-0.6B-8bit`,
  `Example-Model-NN-4bit`.
- Memory ceiling 42 GiB (`45097156608`), "balanced" guard tier (soft 0.90, hard 0.95). Home paths use `/Users/fixture`.
- Server local offset `+09:00` (arbitrary and DST-free, not the owner's zone). "Now" is 2026-09-29 14:30 local.

## Privacy canaries

These fixtures plant canaries so that adapter tests can prove none of them reaches the wire (contract §9, class A).
`fixtures.test.ts` asserts that each one is present where listed below and nowhere else.

| Canary | Where | Why |
|---|---|---|
| `CANARY-API-KEY-7f3a` inside `api_key: "fixture-CANARY-API-KEY-7f3a"` | `admin-api-stats.canary.json` | `/admin/api/stats` returns the plaintext main key. `scripts/scan-committed.ts` allows only `api_key` values that start with `fixture`, hence the prefix. Match the substring. |
| `host: "CANARY-HOST-7f3a"`, `port: 32570` (0x7f3a) | `admin-api-stats.canary.json` | Server bind settings. Strip at parse time (SPIKES S6 amendment). |
| `CANARY-CLI-7f3a` in `cli_prefix` | `admin-api-stats.canary.json` | An absolute app-bundle path under `/Users/fixture`. |
| `CANARY-PATH-7f3a` | `runtime_cache.{base_path, ssd_cache_dir, response_state_dir}` in `admin-api-stats.canary.json`; every `custom_kernels.*.import_error` in `api-status.source-install.json` | Free-text file paths. `import_error` is `str(ImportError)`, which embeds the package path. |
| Request ids `00000000-7f3a-4000-8000-…` | every `request_id` in `admin-api-activity.*` and in `admin-api-stats.canary.json` | oMLX request ids are `uuid4()` strings (class A). The zero prefix passes the UUID rule in `scan-committed`. |

No oMLX route in this corpus carries prompt or response text, so no `CANARY-PROMPT-7f3a` is planted. No route exposes a PID.

## Files

Upstream paths are relative to `omlx/` at the tag.

### `GET /health` (no auth) — `server.py:2839`

| File | HTTP | Purpose |
|---|---|---|
| `health.healthy-loaded.json` | 200 | One model loaded. `engine_pool.final_ceiling` maps to `ceilingBytes` (plan §5.2). |
| `health.healthy-unloaded.json` | 200 | Pool present, nothing loaded; `current_model_memory` 0. |
| `health.healthy-null-pool.json` | 200 | `_server_state.engine_pool is None`, so `engine_pool: null` and `default_model: null`. 1.6's `isOmlxHealth` rejects this body (it needs `engine_pool.model_count`). |
| `health.healthy-guard-off.json` | 200 | The memory guard is off, so `get_final_ceiling()` returns 0. `final_ceiling: 0` means no ceiling, not 0 bytes. |
| `health.healthy-mcp.json` | 200 | MCP manager present: `mcp{enabled, servers_connected, servers_total, tools_available}`. |
| `health.loading.json` | **503** | The pinned preload is still running (`server.py:620-628`): `status: "loading"`, pool present, nothing loaded yet. |

### `GET /api/status` (main key **or sub key**; open on a keyless loopback config) — `server.py:2889`, auth `server.py:323`

23 keys, in this order: `status, version, uptime_seconds, models_discovered, models_loaded, models_loading,
default_model, loaded_models, total_requests, active_requests, waiting_requests, total_prompt_tokens,
total_completion_tokens, total_cached_tokens, cache_efficiency, avg_prefill_tps, avg_generation_tps,
model_memory_used, model_memory_max, model_memory_used_formatted, model_memory_max_formatted, custom_kernels,
ane_prefill`.

| File | HTTP | Purpose |
|---|---|---|
| `api-status.idle.json` | 200 | One model resident; `active_requests` and `waiting_requests` 0. Session totals from `server_metrics.py:253`. |
| `api-status.busy.json` | 200 | `active_requests: 2`, `waiting_requests: 1` (the sum over engines of `_output_collectors` and `scheduler.waiting`). `ane_prefill.models[]` has one configured entry (`patches/qwen35_ane_prefill.py:3530`, `server.py:2973`). |
| `api-status.sub-key.json` | 200 | Body for a sub-key caller. Same shape as for the main key (`verify_any_api_key` accepts sub keys). Nothing loaded: `model_memory_used: 0` gives `"0B"`. This is the admin 401/403 fallback (SPIKES S6). |
| `api-status.source-install.json` | 200 | A pip/source install without native kernels: every `custom_kernels.*` is `available: false` with a path-bearing `import_error` (canary). With the guard off, `model_memory_max: 0` gives `"unlimited"`. |
| `api-status.unauthorized.json` | **401** | No key on a keyed server: `{"detail":"API key required"}` (not `/v1/`, so not the OpenAI error shape; `server.py:889`). |
| `api-status.invalid-key.json` | **401** | Wrong key: `{"detail":"Invalid API key"}`. |

### `GET /admin/api/usage?range=&model=&include_details=` (admin session cookie) — `admin/routes.py:6441`, `usage_history.py:309`

Top-level keys: `range, start, end, timezone, retention_days, flush_seconds, enabled, available, dropped_requests,
totals, models, heatmap`, plus `daily` and `hourly` **only** with `include_details=true`. A summary carries
`requests, prompt_tokens, completion_tokens, cached_tokens, prefill_seconds, generation_seconds, request_seconds,
timed_requests, total_tokens, cache_efficiency, generation_tps, prefill_tps, average_request_seconds`
(`usage_history.py:38`). `models[]` gives `model_id` first and is sorted by `total_tokens` descending.
`heatmap[]` has one `{date, tokens[24]}` per calendar day in the range, where `tokens` is prompt + completion per local hour.

| File | HTTP | Request | Purpose |
|---|---|---|---|
| `admin-api-usage.7d.json` | 200 | `range=7d` | 7 local days ending today; 2 models. No details. |
| `admin-api-usage.30d.json` | 200 | `range=30d` | 30 days, including fully idle days (zero heatmap rows). No `daily`: build 30d from `heatmap` (G1). |
| `admin-api-usage.90d.json` | 200 | `range=90d` | 90 days, 3 models, including one no longer loaded (`Example-8B-4bit`). About 12 KB, in line with the S6 measurement. |
| `admin-api-usage.90d-many-models.json` | 200 | `range=90d` | 60 models, over the G1 cap of 50: the adapter must truncate `models[]` to 50. |
| `admin-api-usage.today-details.json` | 200 | `range=today&include_details=true` | Today so far: 1 `daily` row, sparse `hourly`, and future hours zero in `heatmap`. |
| `admin-api-usage.yesterday-details.json` | 200 | `range=yesterday&include_details=true` | Service-side yesterday read (G1 allows details). |
| `admin-api-usage.7d-details.json` | 200 | `range=7d&include_details=true` | 7 `daily` rows (idle days carry integer zeros) plus `hourly` rows keyed by epoch `timestamp_hour`. About 22 KB. |
| `admin-api-usage.disabled.json` | 200 | `range=7d` | History toggled off at startup: `enabled: false`, `available: false`, zero totals (integer `0` seconds, `0.0` efficiency, `null` rates), `models: []`, zero heatmap. |
| `admin-api-usage.unavailable.json` | **503** | any | `usage_history is None`, or the query raised: `{"detail":"Usage history unavailable"}`. Hide the card. |
| `admin-api-usage.unauthorized.json` | **401** | any | No or expired admin cookie: `{"detail":"Admin authentication required"}` (`admin/auth.py:257`). oMLX's handler drops the `WWW-Authenticate: Cookie` header. |
| `admin-api-usage.bad-range.json` | **422** | `range=1y`, authenticated | FastAPI `literal_error`. Unauthenticated callers get the 401 first: `require_admin` runs before query validation. |

### `GET /admin/api/activity` (admin session cookie) — `admin/routes.py:6506`, builder `admin/routes.py:6512`

Body: `{"active_models":{models[], model_memory_used, model_memory_max, memory_pressure{enabled, current_bytes,
soft_bytes, hard_bytes, current_formatted, soft_formatted, hard_formatted, pressure_level}, total_active_requests,
total_waiting_requests}}`.
- Model rows are sorted by id (`engine_pool.py:3602`) and carry `id, estimated_size, estimated_size_formatted,
  actual_size, actual_size_formatted, pinned, is_loading, loading_elapsed_seconds, loading_estimated_seconds,
  loading_remaining_seconds_estimate, active_requests, waiting_requests, waiting[], activities[], prefilling[],
  generating[], idle_seconds, ttl_remaining_seconds, dflash, cluster`.
- `prefilling[]` rows follow `prefill_progress.py:102`. `generating[]` and `waiting[]` rows follow the builder.
  `activities[]` rows follow `engine/base.py:669` (embedding: `engine/embedding.py:159`).
- With the guard enabled, `model_memory_used` is the enforcer's process footprint and `model_memory_max` its ceiling.
  Otherwise they are the pool's model bytes and its ceiling (0 = none).

| File | HTTP | Purpose |
|---|---|---|
| `admin-api-activity.idle.json` | 200 | One resident model, no requests. `idle_seconds` and `ttl_remaining_seconds` are set (1,800 s idle timeout); pressure `ok`. |
| `admin-api-activity.prefill.json` | 200 | Two models each prefilling: a plain `phase: "prefill"` row (`detail: null`), and a `specprefill_sparse` row with `scored_tokens`/`selected_tokens`/`keep_percent`. |
| `admin-api-activity.prefill-stalled.json` | 200 | The same request as `prefill.json` about 20 s later, with `processed` unchanged. `speed` and `eta` stay frozen while `elapsed` grows. Pair the two files for the `omlx-prefill-stall` test (1.6 marks `progress_stale` after 15 s). |
| `admin-api-activity.generating.json` | 200 | Two generating rows (sorted by request id). One has `max_tokens: null`. `tokens_per_second` = generated / elapsed. |
| `admin-api-activity.waiting.json` | 200 | 1 generating + 1 prefilling (`active_requests: 2`) and 2 queued (`queue_position` 1, 2). |
| `admin-api-activity.pressure-soft.json` | 200 | `pressure_level: "soft"`: current between soft (0.90) and hard (0.95) × ceiling. |
| `admin-api-activity.pressure-hard.json` | 200 | `pressure_level: "hard"`: current ≥ 0.95 × ceiling. Admission paused, one request waiting. Drives the `omlx-memory-guard` alert. |
| `admin-api-activity.guard-disabled.json` | 200 | Enforcer absent or stopped: `memory_pressure.enabled: false` with zeros and `"0.0GB"`. `model_memory_max: 0` means no ceiling. |
| `admin-api-activity.no-pool.json` | 200 | `engine_pool is None`: the fixed empty payload. |
| `admin-api-activity.loading.json` | 200 | `is_loading: true`, not yet loaded: `actual_size: 0`, `actual_size_formatted: null`, and load estimates set (at least 2 load-time observations). |
| `admin-api-activity.activities.json` | 200 | A non-streaming embedding engine: `activities[]` row with metadata, counted in `active_requests`; no scheduler rows. |
| `admin-api-activity.unauthorized.json` | **401** | `{"detail":"Admin authentication required"}`. |

### `GET /admin/api/stats` (admin session cookie) — `admin/routes.py:6461`

2.0 **never calls** this route (SPIKES S6 amendment). The file exists for the strip-at-parse test.

| File | HTTP | Purpose |
|---|---|---|
| `admin-api-stats.canary.json` | 200 | Contains the snapshot keys (`server_metrics.py:253`), then `host`, `port`, `api_key`, `cli_prefix` (all canaries), `engines` (`admin/routes.py:5908`, public bundle pins), `active_models` (same builder as `/admin/api/activity`) and `runtime_cache` (`admin/routes.py:6108`, with path canaries). |

## Traps these fixtures pin down
- `/api/status` and `/admin/api/stats` report `cache_efficiency` as a **percent** rounded to 0.1 (`server_metrics.py:269`).
  `/admin/api/usage` reports it as a **ratio** 0–1 (`usage_history.py:41`).
- `/admin/api/usage` has no `daily` series without `include_details`. For 30d and 90d, per-day tokens come only from
  `heatmap` (prompt + completion). Requests per day are not available without details.
- `start` and `end` are local ISO-8601 timestamps with an offset. `hourly[].timestamp_hour` is epoch seconds.
- Rates are `null` (not 0) when their denominator is 0. `/api/status` rates are `0.0` in the same situation.
- The `*_formatted` strings are display-only (`format_size` uses 2 decimals and 1024 steps, `_format_gb` uses 1 decimal).

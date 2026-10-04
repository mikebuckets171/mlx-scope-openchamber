# Splash 1.2.0 fixture corpus

**Version represented:** Splash **1.2.0**, upstream `incoai/splash` tag `1.2.0`
(commit `f43509a2f03d83b4442a0fab748e8b0fb49aa817`), stock, built from source. `/status` `schema_version` is `6`.

**Provenance: captured from a local server and scrubbed.** These are not synthesized like the 1.1.0 corpus.
- Captured on 2026-10-04 from one stock Splash 1.2.0 server on a local Apple silicon Mac.
- Server options: `--max-context 192K --max-memory 30G --request-timeout 7200 --max-cache-disk 32G --persistent-cache`.
- Requests sent:
  - GET-only reads of `/status` and `/v1/models`;
  - two short chat requests (temperature 0, `reasoning_effort` none): a 16-token warm-up before `ready-idle`, then the
    one request the Δ=1 pair spans.
- `/status` carries no prompt or reply text.
- Counters, timings, sizes, flags, key order and value types are the server's own.

**Scrubbed:**
- `instance.*` was replaced with the corpus canaries: id `CANARY-INSTANCE-7f3a`, pid 4242, host `198.51.100.42`,
  port 18742, `started_at` 1790636042.4242.
- In `identity.*`, the hash and build-id strings became the planted canaries. That covers
  `cache.loaded_model_layout_sha256`, `cache.build_id` and `kv.target_model_sha256`; 1.2 has no
  `runtime_cache_namespace` or `q8` block. Descriptive values such as `format`, `dtype` and the layouts were kept.
- The model id became `publisher/Example-27B-4bit`, and `memory_plan.model.model_name` became `example-27b`.
- No home or temporary path occurs in these bodies.

**Encoding.**
- Bodies are re-encoded the way `server/json_codec.py` emits them: compact separators, `ensure_ascii=False`, no
  trailing newline.
- Parsing and re-encoding keep key order and Python float `repr`, so only the scrubbed values differ from the wire bytes.

## Schema changes from 1.1.0 that matter to Scope

- `latency.ttft` is renamed `latency.http_ttft` (`server/latency.py:39,92` at the tag). Its shape is unchanged:
  cumulative `count`, `sum` in seconds, 18 bucket bounds plus `+Inf`. Scope reads `latency.http_ttft` first and falls
  back to `latency.ttft`.
- `schema_version` is 6. The `instance` keys and their order are unchanged.
- Everything else Scope reads keeps its name and meaning:
  - `requests`, `http.requests.active`, `scheduler.*`, `transport.*` and `metal.*`;
  - `memory_actual.current_bytes` and `peak_bytes`, `maximum_context_tokens`, `vision`, `input_modalities` and
    `chat_template`;
  - `metrics.decode_output_tokens`, `decode_wall_ms`, `prefill_input_tokens`, `prefill_wall_ms`, `ttft_ms` and `itl_ms`.
- Other changes, none of which Scope reads:
  - `loop` is new;
  - `transport.stopped` and `metrics.decode_cycle_ms` are new;
  - `memory_actual` has `allocated_bytes` instead of `dense_bytes` and the `sparse_*` fields;
  - `scheduler.decode_mixed_greedy_sampling_batches` is gone.

## Files

| File | State | What it is for |
|---|---|---|
| `status.ready-idle.json` | Ready | Idle after the warm-up request: 1 submitted, 1 completed, `latency.http_ttft.count` 1. A vision-capable package (`vision:true`, `input_modalities:["text","image","pdf"]`). |
| `status.delta1-before.json` | Ready | The first read of the Δ=1 pair, one second after `ready-idle`. The counters are the same; time-varying fields differ, because this is a real capture. |
| `status.decoding.json` | Ready | Mid-reply: 2 submitted, 1 completed. `scheduler.decoding:1`, `http.requests.active:1`, and `latency.http_ttft.count` already 2, because the first token arrives before completion. |
| `status.delta1-after.json` | Ready | The next idle read. Requests submitted +1 and completed +1, `latency.http_ttft.count` +1, nothing active at either read. Per-request HTTP TTFT = Δ`latency.http_ttft.sum` × 1000 = **207.117 ms**. Prefill Δ is 21 tokens / 125.708 ms and decode Δ is 115 tokens / 3,963.145 ms. |
| `v1-models.default.json` | Ready | `/v1/models` for the resident model, with the 1.1-and-later catalog chips (`max_model_len`, `context_length`, `vision`, `input_modalities`). |

These files are exercised by `service/adapters/splash.test.ts` and by the 1.2.0 block in `../fixtures.test.ts`.

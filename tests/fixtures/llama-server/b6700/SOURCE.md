# llama-server b6700 fixtures

**Version.** llama.cpp `llama-server` build **b6700**. It is older than the S7b gates that matter here:
- it has `/slots` (≥ b6337);
- it has **no sleep support** (sleep arrived in b7492), so `/props` has no `is_sleeping` and `/metrics` and `/slots` are
  safe to poll;
- it has no `generation_prompt` (b8445+);
- it has no `LLAMA_SERVER_SLOTS_DEBUG`.

Upstream tag `b6700` = commit `3df2244df40c67dfd6ad548b40ccc507a066af2b` (ggml-org/llama.cpp). The build string used is
the synthetic `b6700-abcdef0` (format `"b" + LLAMA_BUILD_NUMBER + "-" + LLAMA_COMMIT`, utils.hpp:66).

**Provenance.** Every file is **synthesized from upstream source** at that tag. Nothing was captured live: no
llama-server runs on the owner's Mac (the stack was archived on 09-20, plan §5.3). All values are invented. The model is
`example-27b-q4.gguf` under `/Users/fixture`. Paths are relative to `tools/server/` unless they start with `common/`.

## Wire format (applies to every file)
- **JSON** bodies are `safe_json_to_str` output: `nlohmann::ordered_json::dump(-1)` (utils.hpp:952-954; `using json =
  nlohmann::ordered_json`, server.cpp:34).
  - They are compact, on one line, with no trailing newline, in source key order.
  - float32 sampling values are widened to double (`0.800000011920929`), and integral doubles print as `1.0`.
  - Error bodies use `format_error_response` key order `code, message, type` (server.cpp:1236-1278). The loading 503 and
    the 401 follow the same order, **unlike b10519**, whose middleware writes `message, type, code`.
- **Prometheus** bodies are `text/plain; version=0.0.4`, ending in `\n`.
  - Every value passes through `json_value(…, 0.)` as a double and is written with the C++ ostream default (`%g`, 6
    significant digits) (server.cpp:4390-4401).
  - `*_seconds_total` values are integer milliseconds divided by 1e3.

## Behaviour the adapters must respect (read from source; shapes the fixtures)
- **Series set.**
  - Counters: `prompt_tokens_total`, `prompt_seconds_total`, `tokens_predicted_total`,
    `tokens_predicted_seconds_total`, `n_decode_total`, `n_past_max`, `n_busy_slots_per_decode`.
  - Gauges: `prompt_tokens_seconds`, `predicted_tokens_seconds`, `requests_processing`, `requests_deferred`.
  - There is **no** `prompt_tokens_cached_total`, no `n_tokens_max`, and no `spec_decode_*`.
  - `n_past_max` (a max) and `n_busy_slots_per_decode` (a ratio) are typed **counter** but must not be rated.
  - Help strings differ from b10519 (trailing periods, "Prompt process time").
- **Prompt counters move at a request's first token** (`on_prompt_eval`, server.cpp:3906-3909). **Prediction counters
  move at completion** (`on_prediction`, server.cpp:3928, 4027). Mid-request scrapes show Δ`tokens_predicted_total` = 0,
  so the decode rate is Δ`tokens_predicted_total` / Δ`tokens_predicted_seconds_total`, never Δtokens / Δwall.
- **The "gauges" are averages since start** on this build. The bucket is reset only when a task sets
  `metrics_reset_bucket`, and `handle_metrics` never sets it (server.cpp:3117-3118, 4308-4322). They are still never
  used for rates (S7b).
- **Slot key sets.** Every slot, including a never-used one (`id_task` -1), has exactly `id`, `id_task`, `n_ctx`,
  `speculative`, `is_processing`, `params` and `next_token` (`to_json(true)`, server.cpp:1684-1701).
  - `next_token` is an **object** on this build.
  - There is no `n_prompt_tokens*` field, so prompt size is not available from `/slots` here.
- **A released slot keeps its counters.** `release()` does not call `reset()` (server.cpp:1580-1589); `reset()` runs
  only when the slot takes its next task (server.cpp:2411). An idle slot therefore still shows its last `n_decoded` and
  `n_remain`, unlike b10519.
- **Context.** `n_ctx` per slot = context / `n_parallel` (server.cpp:2261): 32768 / 4 = 8192.
  `default_generation_settings` in `/props` is the full `slots[0].to_json()` taken once at start (server.cpp:2308).
  - Its `prompt` is always `""`.
  - Its params carry the unadjusted `dry_penalty_last_n` -1. Requests get `llama_n_ctx` (32768) (server.cpp:392-394).

## Files

| File | Endpoint · condition | Source | Purpose |
|---|---|---|---|
| `health.ok.json` | `GET /health` 200 | server.cpp:4263-4267 | Ready. |
| `health.loading-503.json` | any API route while loading, 503 | server.cpp:4221-4237 | `loading` reason (code-first key order). |
| `props.normal.json` | `GET /props` 200, `--metrics`, `-np 4`, `-c 32768` | server.cpp:4526-4552, 1684-1722, 147-261; common/common.h:137-192, 203-212, 448-451; common/chat.cpp:623-657 | Detection (`build_info` + `total_slots`), `default_generation_settings.n_ctx`, no `is_sleeping` (not sleep-capable), model last-segment extraction. |
| `props.no-metrics.json` | `GET /props`, started without `--metrics` | server.cpp:4538; common/common.h:451 | `endpoint_metrics: false` on a build that cannot sleep: `/slots` may still be polled (S7b rule 3 needs `/metrics` only on sleep-capable builds). |
| `props.unauthorized-401.json` | `GET /props` with `--api-key` and no/wrong key | server.cpp:4185-4215 (public: `/health`, `/models`, `/v1/models`, `/api/tags`) | 401 = an authenticated runtime is present. |
| `slots.one-busy.json` | `GET /slots`, one request decoding | server.cpp:4269-4306, 3074-3121, 1684-1701 | Slot 0 busy: 220 of `max_tokens` 2048 decoded, `n_remain` 1828. Slot 1 idle, keeps `n_decoded` 312; slots 2–3 never used. |
| `slots.two-busy.json` | `GET /slots`, two requests | same | Slot 0 decoding (380 decoded); slot 2 before its first token (`n_decoded` 0). Per-request speed withheld. |
| `slots.all-idle.json` | `GET /slots`, nothing running | same | Every slot idle; finished slots keep `n_decoded` (540, 312, 300). |
| `slots.disabled-501.json` | `GET /slots` with `--no-slots` | server.cpp:4270-4273; 1236-1278 | Capability degrade. |
| `metrics.disabled-501.json` | `GET /metrics` without `--metrics` | server.cpp:4309-4312 | Capability degrade. |
| `metrics.scrape-1.txt` | `GET /metrics`, t = 0 s | server.cpp:4308-4406, 1725-1784 | Sequence step 1: request R decoding. |
| `metrics.scrape-2.txt` | `GET /metrics`, t = 5.000 s | same | Step 2: R still decoding; R2 reached its first token. `requests_processing` 2. |
| `metrics.scrape-3.txt` | `GET /metrics`, t = 10.000 s | same | Step 3: R completed between 2 and 3; R2 still decoding. |
| `metrics.idle.txt` | `GET /metrics`, later, idle | same | R2 completed; `requests_processing` 0. |

### Expected values from the scrape sequence (for adapter tests)
Consecutive scrapes are **5.000 s** apart. The fixture carries no timestamps, so the test supplies the window.

**1 → 2**
- Decode: Δ`tokens_predicted_total` 0 and Δ`tokens_predicted_seconds_total` 0 while busy. This is **no decode rate**.
- Prompt: Δ`prompt_tokens_total` 1024 over Δ`prompt_seconds_total` 1.536 s = **666.667 tok/s**.
- Δ`n_decode_total` 160.

**2 → 3**
- Decode: Δ`tokens_predicted_total` 540 over Δ`tokens_predicted_seconds_total` 16.875 s = **32 tok/s**. Dividing by the
  5 s window instead would give 108.
- Prompt: Δ`prompt_tokens_total` 0.

## Privacy canaries (must never reach the wire, storage, logs or DOM)

| Canary | Where | Rule |
|---|---|---|
| `CANARY-PATH-7f3a` | directory segment of `model_path` in `props.normal.json` and `props.no-metrics.json` | Only the last segment `example-27b-q4.gguf` may survive. |
| `/Users/fixture` | the same `model_path` values | Home path; never forwarded. |
| `CANARY-TEMPLATE-7f3a` | `chat_template` in the same two props files | Free text outside the allowlist. |

`/slots` on this build carries no prompt, response or stop text (only the `to_json(true)` view exists), so no slot file
holds a canary. `fixtures.test.ts` asserts that, and that each canary above occurs exactly where listed.

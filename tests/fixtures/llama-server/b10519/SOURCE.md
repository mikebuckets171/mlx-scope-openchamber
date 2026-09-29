# llama-server b10519 fixtures

**Version.** llama.cpp `llama-server` build **b10519**: the master-era server, and the first build whose `/metrics`
bypasses sleep and answers from a cache (SPIKES S7b). Upstream tag `b10519` = commit
`947fd9bb2bdeaa72e9dd74b6aa3b5d68f03f3d6a` (ggml-org/llama.cpp). The build string used everywhere is the synthetic
`b10519-abcdef0`.

**Provenance.** Every file is **synthesized from upstream source** at that tag. Nothing here was captured live: no
llama-server runs on the owner's Mac (the stack was archived on 09-20, plan §5.3). All values are invented. The model is
`example-27b-q4.gguf` under `/Users/fixture`. Paths below are relative to `tools/server/` unless they start with `common/`.

## Wire format (applies to every file)
- **JSON** bodies are `safe_json_to_str` output: `nlohmann::ordered_json::dump(-1)` (server-common.cpp:1542-1544).
  They are compact, on one line, with no trailing newline, in source key order.
  - float32 sampling values are widened to double, e.g. `0.800000011920929` for 0.8f.
  - Integral doubles print as `1.0` / `-1.0`.
  - A `std::map` (e.g. `chat_template_caps`) serializes in sorted key order.
  - Read them with `jq .`.
- **Prometheus** bodies are `text/plain; version=0.0.4` and end with `\n`. Values are written with the C++ ostream
  default, `%g` at 6 significant digits (server-task.cpp:1597-1601).
  - Counters of 1,000,000 or more therefore print in exponent form and lose precision (`3.21457e+06`).
  - The `position`-labelled per-position counter prints exact `uint64` integers (server-task.cpp:1608-1616).
- The `Process-Start-Time-Unix` response header of `/metrics` is not part of the body and is not modelled.

## Behaviour the adapters must respect (read from source; shapes the fixtures)
- **Prediction counters move only when a request completes.** `tokens_predicted_total`,
  `tokens_predicted_seconds_total` and all `spec_decode_*` counters are updated there.
  - `release()` calls `callback_on_reset`, which calls `metrics_on_prediction` (server-context.cpp:500-521, 1278-1283,
    4046-4067).
  - Mid-request scrapes show Δ = 0 even while `requests_processing` ≥ 1.
  - A completion lands its whole generation time in one scrape window, which can be longer than the window.
  - The decode rate is therefore Δ`tokens_predicted_total` / Δ`tokens_predicted_seconds_total`, never Δtokens / Δwall.
- **Prompt counters move per decode.** `metrics_post_decode` → `metrics_flush_prompt` (server-context.cpp:3988-4033).
  `prompt_tokens_cached_total` moves when a prompt is matched against the cache (server-context.cpp:3341).
- **Gauges** (`prompt_tokens_seconds`, `predicted_tokens_seconds`) are windowed buckets. Every scrape resets them
  (server-context.cpp:4583-4643). `predicted_tokens_seconds` reads 0 while a request is still generating. Never use them
  for rates (S7b).
- `n_tokens_max` (replaces b6700's `n_past_max`) and `n_busy_slots_per_decode` are a max and a ratio, not rates.
  - `n_tokens_max` is typed `counter`.
  - `n_busy_slots_per_decode` is a `gauge` on this build and a `counter` on b6700.
- **A released slot loses its stats.** `reset()` runs inside `release()` (server-context.cpp:325-360, 500-521).
  - An idle slot that served a task shows `n_prompt_tokens_processed` 0, `n_prompt_tokens_cache` 0,
    `next_token[0].n_decoded` 0, `n_remain` -1 and `has_new_line` false.
  - It keeps `id_task`, the previous `params`, and `n_prompt_tokens`, the size of its token cache, **including generated
    tokens** (server-context.cpp:496).
  - The final `n_decoded` of a completion must come from the last busy read.
- **Slot key sets.** A slot that never served a task has exactly `id`, `n_ctx`, `speculative` and `is_processing`
  (server-context.cpp:642-676). `next_token` is an **array of one object** on this build.
- **`/metrics` while sleeping** is served from `cached_metrics` without waking the server
  (server-context.cpp:4604-4605, 5455-5475).
  - `requests_processing` and `requests_deferred` read 0.
  - The body is indistinguishable from `metrics.idle.txt`, so the sleeping state comes from `/props` `is_sleeping`
    alone.
- `/slots` wakes a sleeping server: `create_response()` without bypass (server-context.cpp:4146-4155, 4645-4685).

## Files

| File | Endpoint · condition | Source | Purpose |
|---|---|---|---|
| `health.ok.json` | `GET /health` 200 | server-context.cpp:4570-4581 | Ready. |
| `health.loading-503.json` | any route while loading, 503 | server-http.cpp:253-274 (key order message, type, code) | `loading` reason. |
| `props.normal.json` | `GET /props` 200, `--metrics`, 4 slots (`-np` auto → kv_unified, server.cpp:151-156) | server-context.cpp:4515-4560, 4720-4730; server-task.cpp:32-89; common/common.h:223-296, 648-669; common/chat.cpp:853-883; common/jinja/caps.cpp:87-99 | Detection (`build_info` + `total_slots`), `n_ctx`, `is_sleeping` false, `endpoint_metrics` true, model last-segment extraction. |
| `props.sleeping.json` | `GET /props` while sleeping | `cached_props` = `get_res_props(…, true)` (server-context.cpp:5459-5462, 4723-4726) | Identical to normal except `is_sleeping: true`. Selects the `sleeping` reason and stops `/slots` polling. |
| `props.no-metrics.json` | `GET /props`, started without `--metrics` | server-context.cpp:4542; common/common.h:655 | `endpoint_metrics: false` on a sleep-capable build → `metrics_required`, no live slots (S7b rule 4). |
| `props.router.json` | `GET /props` (no `?model=`) on a router-mode server (no `-m`, e.g. `--models-dir`) | server-models.cpp:1873-1898 | `role: "router"`, `model_path: "none"`, no `total_slots`. Router mode is out of scope; must not be detected as a single-model server. |
| `props.unauthorized-401.json` | `GET /props` with `--api-key` and no/wrong key | server-http.cpp:234-246 (only `/health` and UI assets are public, 196-203) | 401 = an authenticated runtime is present. |
| `slots.fresh.json` | `GET /slots` right after start | server-context.cpp:642-676, 2452-2471 | Four never-used slots (4 keys each). |
| `slots.one-busy.json` | `GET /slots`, one request decoding | same | Slot 0 busy (225 decoded); slot 1 released after a previous task (zeroed stats); slots 2–3 never used. The single-busy-slot rate case. |
| `slots.two-busy.json` | `GET /slots`, two requests | same | Slot 0 decoding (450 decoded); slot 2 in prefill (`n_decoded` 0, 640 of its new prompt tokens processed). Per-request speed must be withheld. |
| `slots.all-idle.json` | `GET /slots`, nothing running | same | Three released slots and one never used. busy → idle completion edge. |
| `slots.debug.json` | `GET /slots` with `LLAMA_SERVER_SLOTS_DEBUG=1` | server-context.cpp:1298-1303, 668-671; full `params` via server-task.cpp:91-147 | Adds `prompt`, `generated` and the full params (`stop`, `logit_bias`, `grammar`, …). Every text field is a canary. |
| `slots.disabled-501.json` | `GET /slots` with `--no-slots` | server-context.cpp:4647-4649; server-common.cpp:19-60 | `/slots` unavailable → degrade the capability, not the runtime. |
| `metrics.disabled-501.json` | `GET /metrics` without `--metrics` | server-context.cpp:4585-4588 | `/metrics` unavailable. |
| `metrics.scrape-1.txt` | `GET /metrics`, t = 0 s | server-task.cpp:1525-1619 | Sequence step 1: request R decoding on slot 0. |
| `metrics.scrape-2.txt` | `GET /metrics`, t = 5.000 s | same | Step 2: R still decoding, R2 prefilled 1024 tokens. `requests_processing` 2. |
| `metrics.scrape-3.txt` | `GET /metrics`, t = 10.000 s | same | Step 3: R completed between 2 and 3; R2 still decoding. |
| `metrics.idle.txt` | `GET /metrics`, later, idle | same | R2 completed, `requests_processing` 0: stop `/slots` polling. Also stands in for a sleeping server's cached body. |
| `metrics.no-spec.txt` | `GET /metrics`, no speculative decoding | same (the per-position block is omitted when empty, 1608) | `spec_decode_*` present but 0, and no `position` series: no speculative card. |
| `metrics.large-counters.txt` | `GET /metrics`, long uptime, 4 busy + 2 deferred | same | Exponent-form, precision-limited values and a non-zero `requests_deferred`. Parser robustness. |

### Expected values from the scrape sequence (for adapter tests)
Consecutive scrapes are **5.000 s** apart. The fixture carries no timestamps, so the test supplies the window.

**1 → 2**
- Prediction deltas: Δ`tokens_predicted_total` 0, Δ`tokens_predicted_seconds_total` 0, every Δ`spec_decode_*` 0,
  while `requests_processing` is 1 then 2. This is **no decode rate, not 0 tok/s**.
- Prompt: Δ`prompt_tokens_total` 1024 over Δ`prompt_seconds_total` 1.28 s = **800 tok/s**.
- Cache: Δ`prompt_tokens_cached_total` 512.
- Δ`n_decode_total` 100.

**2 → 3**
- Decode: Δ`tokens_predicted_total` 540 over Δ`tokens_predicted_seconds_total` 12.0 s = **45 tok/s**. Dividing by the
  5 s window instead would give 108.
- Speculative: 720 drafted and 300 accepted = **0.416667**. Δ`spec_decode_num_drafts_total` 240; 540 = 240 + 300.
- Prompt: Δ`prompt_tokens_total` 0.

**Invariant.** Every file with a `position` series satisfies Σ`spec_decode_num_accepted_tokens_per_pos_total` =
`spec_decode_num_accepted_tokens_total`.

## Privacy canaries (must never reach the wire, storage, logs or DOM)

| Canary | Where | Rule |
|---|---|---|
| `CANARY-PATH-7f3a` | directory segment of `model_path` in `props.normal.json`, `props.sleeping.json`, `props.no-metrics.json` | Only the last segment `example-27b-q4.gguf` may survive. |
| `/Users/fixture` | the same `model_path` values | Home path; never forwarded. |
| `CANARY-TEMPLATE-7f3a` | `chat_template` in the same three props files | Free text outside the numeric/boolean allowlist. |
| `CANARY-PROMPT-7f3a` | `params.generation_prompt` of every slot that has `params`, in `slots.one-busy`, `slots.two-busy`, `slots.all-idle` and `slots.debug`; `prompt` in `slots.debug` | Never read (S7b). |
| `CANARY-GENERATED-7f3a` | `generated` in `slots.debug.json` | Response text. |
| `CANARY-STOP-7f3a` | `params.stop` in `slots.debug.json` | Request text. |

`fixtures.test.ts` asserts that each canary occurs exactly where this table says, and nowhere else.

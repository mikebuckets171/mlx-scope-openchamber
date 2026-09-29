# Fixture authors' reports (adapter notes for Stages 3–5)

Verbatim reports from the agents that built tests/fixtures/*; read the per-family notes before implementing an adapter.


# FIXTURE REPORT: omlx

Branch: fixtures/omlx
SHA: 7f259fa708fc1d33672ef164d031da860ee390fe
Base: 730c2bf. One commit ending with the Co-Authored-By line; not pushed.

The corpus is done: 44 synthetic fixtures across the two versions, all 52 tests pass and `scan-committed` passes. One thing differs from the task text: the stats `api_key` value is `"fixture-CANARY-API-KEY-7f3a"`, not `"CANARY-API-KEY-7f3a"`. The scanner only accepts `api_key` values that start with `fixture`, so the literal value would have failed it. The canary string is still there as a substring, and the tests match on that.

**Provenance**
- Every body is synthetic. Each was built by copying the logic of the handlers at jundot/omlx v0.7.0rc1 (35be079d) and v0.6.4 (1d782618), and rendered as the compact JSON the server itself sends, plus one trailing newline the repo's `.editorconfig` requires.
- The only live request was one unauthenticated GET `/health` on :8001, used for key names and types only; no values were kept.
- The installed oMLX 0.7.0rc1 app's source files are byte-identical to the tag for every file cited.
- The 401/404/422/503 bodies were reproduced in-process with the app's own FastAPI (0.141.1) and pydantic (2.13.5). No request went to the running server.
- The two SOURCE.md files give file:line citations and the HTTP status for every variant.

**Files**, under `tests/fixtures/omlx/`:
- `fixtures.test.ts`
- `0.7.0rc1/SOURCE.md`
- `0.6.4/SOURCE.md`
- 36 JSON bodies in `0.7.0rc1/` and 8 in `0.6.4/`, listed below

**0.7.0rc1 variants**
- **`/health`:** healthy-loaded, healthy-unloaded, healthy-null-pool, healthy-guard-off (`final_ceiling` 0), healthy-mcp, and loading (503).
- **`/api/status`** (23 keys): idle; busy (2 active, 1 waiting, one ANE prefill model); sub-key; source-install (kernels unavailable, error text carries a path canary, `"unlimited"` memory max); unauthorized (401, no key); invalid-key (401).
- **`/admin/api/usage`:** 7d, 30d, 90d, 90d-many-models (60 models, to test the 50 cap), today-details, yesterday-details, 7d-details, disabled (`enabled:false`), unavailable (503), unauthorized (401), bad-range (422).
- **`/admin/api/activity`:** idle, prefill (a plain prefill row and a speculative-prefill row), prefill-stalled (to pair with prefill for the stall alert), generating, waiting, pressure-soft, pressure-hard, guard-disabled, no-pool, loading, activities (an embedding job), unauthorized (401).
- **`/admin/api/stats`:** canary. It carries the api_key canary, `host` `CANARY-HOST-7f3a`, `port` 32570 (0x7f3a), a `cli_prefix` containing `CANARY-CLI-7f3a`, and cache paths containing `CANARY-PATH-7f3a`.

**0.6.4 variants**
- `/health`: healthy, loading (503)
- `/api/status`: idle, busy, unauthorized (401)
- `/admin/api/usage`: not-found (404, `{"detail":"Not Found"}`)
- `/admin/api/activity`: generating (rows have no `cluster` key)
- `/admin/api/stats`: canary

Request ids are canaries too, shaped `00000000-7f3a-4000-8000-…`. No oMLX route here carries prompt text, so no `CANARY-PROMPT-7f3a` is planted.

**Verification**
```
bun test tests/fixtures/omlx   -> 52 pass, 0 fail, 19408 expect() calls
bun scripts/scan-committed.ts  -> PASS: 177 files free of home paths, credentials, identifiers and private addresses.
tsc --noEmit --strict on fixtures.test.ts -> exit 0
```
I also broke five fixtures on purpose (leaked a canary, removed a canary, wrong pressure level, an extra key, added `cluster` to 0.6.4). Each break made the tests fail, and all files were restored.

**Things the adapter work in Stages 3–5 should know**
- **Contract gap:** `/admin/api/usage` returns `daily` only when `include_details=true`. Without it, 30d and 90d have only `heatmap` (prompt plus completion tokens per hour), so per-day request counts don't exist. Contract §6.4 assumes `daily` is there.
- **Percent vs ratio:** `cache_efficiency` is a percent in `/api/status` and `/admin/api/stats`, but a 0–1 ratio in `/admin/api/usage`.
- **Error order:** a caller that isn't logged in gets the 401 before any 422 for a bad range. oMLX also drops the `WWW-Authenticate` header from the 401.
- **Null pool:** 1.6's oMLX health check rejects the healthy-null-pool body, because it requires `engine_pool.model_count`.


# FIXTURE REPORT: splash

I built the Splash fixture corpora and committed them on `fixtures/splash` (not pushed). The 52 fixture tests pass and `bun scripts/scan-committed.ts` passes.

**Branch:** `fixtures/splash`, based on 730c2bf
**Commit:** `926924b49bcb311e43d89da968bdb8263cdeac2d`

**Files** (all under `tests/fixtures/splash/`):
- `fixtures.test.ts`
- `1.1.0/SOURCE.md`, 13 `status.*.json`, 3 `v1-models.*.json`, `metrics.ready-idle.txt`
- `1.0.2/SOURCE.md`, 3 `status.*.json`, 2 `v1-models.*.json`

**How they were made:** every value is synthetic, built from the upstream `incoai/splash` code at tag 1.1.0 (3e1f9ece3e2528f3eb46b82a05911591f34a4317) and tag 1.0.2 (e8fffde2c3a1d1c4120028d9e5399bb917b8b917). `SOURCE.md` cites the file and lines for each part of each body.
- I checked the 1.1.0 shape against one GET each of `/status`, `/v1/models` and `/metrics` on the local Splash at :8000. All 638 key paths matched in order and type, and the `/metrics` names and order matched (343 lines, 108 series). No live values were copied, and no inference was sent.
- Bodies are compact JSON with no trailing newline, exactly as Splash's encoder writes them.
- The `/metrics` sample was produced by running Splash's own `/metrics` renderer (`prometheus_metrics()` in `server/metrics.py`) on the ready-idle body.
- The 1.0.2 files come from source only; no 1.0.2 server was run.

**1.1.0 `/status` variants:**

| Variant | State | What it is for |
|---|---|---|
| `ready-idle` | Ready | Language-only model, idle; `itl_ms.samples` is at the 4,096 cap |
| `decoding` | Ready | 2 requests in flight, with scheduler, pending and active counts, plus `ttft_ms`/`itl_ms {p50,p95,samples}` |
| `recovering` | Recovering | `transport.recovering` and `status_stale` both true, `restarts:1`, crash-trace and error canaries; the rest of the body is the cached pre-crash snapshot |
| `status-stale` | Status stale | `ready:false` and `transport.error` containing `CANARY-ERROR-7f3a` |
| `stale-no-snapshot` | Status stale | The first status read timed out, so only `{schema_version, ready:false}` plus transport, instance and the frontend fields |
| `metal-unhealthy` | Not admitting | `metal.healthy:false`, with `CANARY-METAL-7f3a` in `failure_reason` |
| `memory-critical` | Not admitting | `memory_pressure:"critical"`, one request waiting for memory |
| `vision` | Ready | `vision:true`, `input_modalities:["text","image","pdf"]`, `chat_template.later_system:"patched"` |
| `ready-after-crash` | Ready | `last_crash_trace` is still set while Ready; the engine's counters restarted from zero |
| `delta1-before` / `delta1-after` | Ready | TTFT count and `requests.completed` each rise by 1, nothing active; derived TTFT is 412.5 ms. `delta1-before` is byte-identical to `ready-idle` on purpose |
| `delta2-before` / `delta2-after` | Ready | Both counters rise by 2, so per-request TTFT is withheld (mean 944.75 ms) |

**1.1.0 `/v1/models`:** `language-only`, `vision`, `alias` (the alias entry carries `root`). Plus `metrics.ready-idle.txt`.

**1.0.2:** `/status` `ready-idle`, `decoding`, `recovering`; `/v1/models` `default`, `alias`. None of them have `vision`, `input_modalities`, `chat_template`, `tokenizer_cache` or the `grammar` latency stage.

**Canaries:**
- Every status file has `instance` `{id:"CANARY-INSTANCE-7f3a", pid:4242, host:"198.51.100.42", port:18742, started_at:1790636042.4242}`.
- Every status file except `stale-no-snapshot` has all `identity.*` values set to `CANARY-IDENTITY-*-7f3a`.
- `transport.last_crash_trace` is `/Users/fixture/Library/Logs/splash/CANARY-CRASH-7f3a.trace` in `recovering` (both versions) and `ready-after-crash`, and null everywhere else.
- The model id is `publisher/Example-27B-4bit`.

I picked the host and port values so a leak can be told apart from the connection URL. I also added `CANARY-METAL-7f3a` in `metal.failure_reason`; it is free text but not on the S7 never-forward list, so the adapter author should decide whether it gets the same presence-only treatment.

**For the adapter work:**
- **Contract mismatch:** Splash reports `input_modalities` as `"pdf"`, but `docs/design/2.0-contract.md` types `inputModalities` as `'text' | 'image' | 'audio'`. The contract type needs `'pdf'`.
- **Counters reset on restart:** the engine's counters reset when it restarts, while `latency.*` keeps counting. `transport.restarts` goes up when the new engine is launched, so it can still read 0 early in recovery. The adapter should treat any negative change as a reset.
- **Recovering implies stale:** while recovering, `status_stale` is also true, and the body is the cached pre-crash snapshot. The precedence order and "don't derive activity from a stale body" both matter.
- **Bucket order:** `JSON.parse` moves integer-like histogram bucket keys (`"1"`, `"5"`, …) ahead of the others, so buckets should be walked by bound value, not key order.
- **TTFT count leads completions:** `latency.ttft.count` can run ahead of `requests.completed`, which is why the Δ=1 rule needs both counters.

**Verification:**
```
$ bun test tests/fixtures/splash
 52 pass
 0 fail
 6728 expect() calls
Ran 52 tests across 1 file.

$ bun scripts/scan-committed.ts
PASS: 155 files free of home paths, credentials, identifiers and private addresses.
```
The test file also type-checks cleanly with strict `tsc`. The generator is deterministic, and changing a planted canary makes the canary-placement test fail. The generator script was not committed.


# FIXTURE REPORT: llama-server

BRANCH: fixtures/llama (from 730c2bf, not pushed)
SHA: d54e00a389fd63e70551fb05220e69e821f55024
WORKTREE: ~/CodexWork/mlx-scope-openchamber/.claude/worktrees/wf_4b7c0193-048-3

PROVENANCE: All fixtures are synthetic. Each was built from the upstream ggml-org/llama.cpp source at tag b10519 (commit 947fd9bb2bdeaa72e9dd74b6aa3b5d68f03f3d6a) or tag b6700 (commit 3df2244df40c67dfd6ad548b40ccc507a066af2b). Nothing was captured live, because no llama-server runs on this Mac. The bodies match the wire format:
- JSON is compact, on one line, with no trailing newline, in the server's key order.
- float32 sampling values appear widened, e.g. 0.800000011920929.
- Whole-number floats print as 1.0.
- Prometheus values are printed at 6 significant digits, as the C++ server does.
- Each SOURCE.md gives file:line references and the build string (b10519-abcdef0, b6700-abcdef0).

FILES (all under tests/fixtures/llama-server/)
- b10519/SOURCE.md and 20 fixture files
- b6700/SOURCE.md and 14 fixture files
- fixtures.test.ts

VARIANTS b10519
- health.ok.json: {"status":"ok"}
- health.loading-503.json: key order is message, type, code
- props.normal.json: build_info, total_slots 4, default_generation_settings.n_ctx 32768, is_sleeping false, endpoint_metrics true, endpoint_slots true, modalities {vision, video, audio}, model_path /Users/fixture/models/CANARY-PATH-7f3a/example-27b-q4.gguf, chat_template containing CANARY-TEMPLATE-7f3a
- props.sleeping.json: same as normal except is_sleeping true
- props.router.json: role "router", model_path "none", no total_slots
- props.no-metrics.json: endpoint_metrics false, for the metrics_required reason
- props.unauthorized-401.json
- slots.fresh.json: never-used slots with only 4 keys each
- slots.one-busy.json
- slots.two-busy.json: one slot decoding, one still in prefill
- slots.all-idle.json
- slots.debug.json (LLAMA_SERVER_SLOTS_DEBUG=1): prompt, generated and stop text are canaries
- next_token is an array of one object in every slots file. params.generation_prompt is "CANARY-PROMPT-7f3a" on every slot that has params.
- slots.disabled-501.json
- metrics.disabled-501.json
- metrics.scrape-1.txt, scrape-2.txt, scrape-3.txt: three consecutive scrapes 5.000 s apart
- metrics.idle.txt: also stands in for the cached body served while sleeping
- metrics.no-spec.txt: spec_decode_* at 0, no per-position series
- metrics.large-counters.txt: values in exponent form (3.21457e+06), requests_deferred 2
- Metric names follow S7b: prompt_tokens_cached_total, n_tokens_max, the three spec_decode_* totals, the per-position counter labelled by position, and n_busy_slots_per_decode as a gauge.

VARIANTS b6700
- health.ok.json
- health.loading-503.json: key order is code, message, type
- props.normal.json: no is_sleeping; default_generation_settings is the full slot object
- props.no-metrics.json
- props.unauthorized-401.json
- slots.one-busy.json, slots.two-busy.json, slots.all-idle.json: next_token is an object; no generation_prompt
- slots.disabled-501.json
- metrics.disabled-501.json
- metrics.scrape-1.txt, scrape-2.txt, scrape-3.txt, metrics.idle.txt: n_past_max present, no cached-token series, n_busy_slots_per_decode typed as a counter

SOURCE FINDINGS THAT CHANGE HOW ADAPTERS MUST WORK
1. Token and speculative counters only move when a request completes. On both builds, tokens_predicted_* and spec_decode_* update at request end. So:
   - A scrape taken mid-request shows a change of 0; that means "no rate yet", not 0 tok/s.
   - A completed request's full generation time can land in one 5 s window.
   - Use Δtokens / Δ*_seconds_total, not Δtokens / wall time.
   - Expected: b10519 scrapes 2→3 give 45 tok/s (dividing by the window would give 108). b6700 gives 32 tok/s. Prompt rates are 800 tok/s (b10519, scrapes 1→2) and 666.667 tok/s (b6700).
2. On b10519, an idle slot loses its stats when released: n_decoded 0, n_prompt_tokens_processed 0, n_prompt_tokens_cache 0, n_remain -1. The final n_decoded must come from the last busy read. On b6700 the idle slot keeps its values.
3. The windowed throughput gauges behave differently:
   - On b10519, predicted_tokens_seconds reads 0 while a request is still generating.
   - On b6700, the gauges are never reset, so they are averages since the server started.
4. Counters at or above 1,000,000 print in exponent form and lose precision.

VERIFICATION
- `bun test tests/fixtures/llama-server`: 55 pass, 0 fail, 1403 expect() calls. A deliberate break of three fixtures produced 6 failures, which went away after regenerating.
- `bun scripts/scan-committed.ts`: PASS, 167 files free of home paths, credentials, identifiers and private addresses.
- A strict tsc run on fixtures.test.ts reports no errors.
- The working tree is clean after the commit, and nothing outside tests/fixtures/llama-server/ was touched.
- These tests only run when the folder is named explicitly. The repo's `bun run test` covers ./service, ./src and ./panel, and `tsc` does not include tests/fixtures.


# FIXTURE REPORT: ollama

BRANCH: fixtures/ollama (from 730c2bf, one commit, not pushed)
SHA: 0ebe066ad2aafdbc9a39f3cfb894d30466a1f469

SOURCE: all files were synthesized from ollama/ollama v0.40.0-rc0, commit 75b952780f90807f651eb2f1f817e5a40126e81d (the newest tag, 2026-09-25). Sources read: api/types.go, server/routes.go, server/model_list.go, server/sched.go, mlxrunner/client.go, manifest/*.go, types/model/*.go, create/*.go, docs/openapi.yaml (source of docs.ollama.com), and gin v1.10.0 render/json.go. No live Ollama was contacted (the stack is archived, so it is fixture-qualified). No other runtime was probed.

FILES (all under tests/fixtures/ollama/):
- 0.40.0/SOURCE.md
- 0.40.0/api-version.default.json
- 0.40.0/api-version.rc.json
- 0.40.0/api-version.source-build.json
- 0.40.0/api-ps.none.json
- 0.40.0/api-ps.one-model.json
- 0.40.0/api-ps.two-models.json
- 0.40.0/api-ps.cpu-only.json
- 0.40.0/api-ps.partial-offload.json
- 0.40.0/api-ps.keep-alive-forever.json
- 0.40.0/api-ps.canary.json
- 0.40.0/api-tags.empty.json
- 0.40.0/api-tags.small.json
- 0.40.0/api-tags.manifest-list.json
- 0.40.0/api-tags.canary.json
- 0.40.0/api-tags.error-500.json
- fixtures.test.ts

VARIANTS:
- /api/version
  - default: "0.40.0"
  - rc: "0.40.0-rc0"
  - source-build: "0.0.0", the default in version/version.go:3 when built without ldflags
- /api/ps
  - none: {"models":[]}
  - one-model: GGUF on the ggml runner, size_vram == size ("100% GPU")
  - two-models: an MLX safetensors row (runner mlx, size == size_vram, family "", families null, int4) then a GGUF row, sorted by expires_at with the latest first
  - cpu-only: size_vram 0, hf.co/ name, UTC "Z" timestamp
  - partial-offload: 0 < size_vram < size (about 82% GPU)
  - keep-alive-forever: expires_at "2319-01-09T12:49:29.273080807-08:00", which is now + MaxInt64 ns
  - canary: Class B model name CANARY-MODEL-7f3a
- /api/tags
  - empty
  - small: an MLX chat model, a GGUF chat model and a GGUF embedding model
  - manifest-list: the same name twice, one mlx row and one ggml row. Names are not unique in /api/tags.
  - canary:
    - Class B: CANARY-MODEL-7f3a as the model name
    - Class A: CANARY-PATH-7f3a in details.parent_model (a relative GGUF import path)
    - Class A: CANARY-HOST-7f3a in remote_host
  - error-500: {"error": ...} containing /Users/fixture/CANARY-PATH-7f3a/..., free text that must never be forwarded

SHAPE NOTES (from source, recorded in SOURCE.md):
- Bodies are exactly what gin's json.Marshal writes: compact, Go struct field order, no trailing newline. The test checks this.
- digest is 64 hex characters with no "sha256:" prefix.
- In /api/ps, details never has context_length, embedding_length or runner. The top-level `runner` is one of ggml, llamacpp or mlx.
- In /api/tags, details does carry context_length, embedding_length and runner, and rows can have `capabilities`.
- SOURCE.md states that on unified memory, size_vram is "GPU-resident (Ollama-reported)", never VRAM. It also covers the size / gpuResidentBytes / unloadsAt mapping and "Ollama reports residency only".

VERIFICATION:
$ bun test tests/fixtures/ollama
 53 pass
 0 fail
 902 expect() calls
Ran 53 tests across 1 file. [7.00ms]

$ bun scripts/scan-committed.ts
PASS: 147 files free of home paths, credentials, identifiers and private addresses.

Extra checks:
- fixtures.test.ts passes a strict tsc --noEmit run against the repo tsconfig.
- A mutation check (reordered keys, and a stray canary in a realistic variant) made 5 tests fail as expected. The fixtures were regenerated afterwards.


# FIXTURE REPORT: lmstudio

Branch: fixtures/lmstudio (from 730c2bf), not pushed
SHA: 4b6017fef316230dead762f848c6909a9c5e6647

**Files** (21, all under tests/fixtures/lmstudio/):
- fixtures.test.ts
- .editorconfig (stops editors adding final newlines or trimming the `runtime ls` pad spaces)
- bionic-1.1.6/SOURCE.md (source for every file, how each shape was learned, canaries, gaps)
- bionic-1.1.6/: 17 fixtures, listed under Variants
- lmstudio-0.4.25/SOURCE.md (notes only; no stock LM Studio shape was seen live)

**Variants** (bionic-1.1.6)
- `lmstudio-greeting.ok.json`: `{"lmstudio":true}`, 17 bytes, same bytes as the live reply.
- `api-v0-models.{all-not-loaded,one-loaded,loading,empty}.json`:
  - Shape, key order (`data` before `object`) and 2-space formatting copied from a live GET, with values replaced.
  - The inventory has 5 models across the splash, mlx and gguf formats, including one embedding model, which has no `capabilities`.
  - `publisher/example-27b-splash` moves not-loaded → loading → loaded across the variants.
- `api-v1-models.splash.json`: synthesized from the Bionic app's v1 model builder and the LM Studio docs. It has one loaded instance and `format: "splash"`.
- `api-v1-models.route-missing.json`: `{"error":"Unexpected endpoint or method. (GET /api/v1/models)"}`, served with HTTP 200.
- `lms-ps-json.{one-loaded,generating,empty}.txt`:
  - Fields follow lms@1017bcb `list.ts:421-472` plus the SDK zod schemas. The records include sizes, `status`, `queued` and `parallel`.
  - `empty` holds exactly `[]\n`, as returned by the live command.
- `lms-runtime-ls.bionic-splash.txt`: the column layout is copied from the live table. It includes the row `splash-mac-arm64-apple-metal-advsimd@0.0.5 ✓ yuzu`.
- `lms-log-stream-server.*.txt` (NDJSON):
  - `lifecycle` covers request start, prompt progress (0/37.5/100%), the `Done ·` summary line, and finish.
  - `non-streaming` ends with `Generated prediction`.
  - Lines that must be dropped:
    - `drop-request-body` holds a multi-line request body containing CANARY-PROMPT-7f3a twice.
    - `drop-incoming-tokens` holds per-token lines containing CANARY-OUTPUT-7f3a. Its last line is generated text that imitates a `Done ·` summary.
    - `drop-oversized` is a single line of about 22 KB, above the 16 KiB limit.
  - `sensitive-on` interleaves all the drop lines with a normal request lifecycle.

**Verification**
- `bun test tests/fixtures/lmstudio`: 31 pass, 0 fail, 932 expect() calls.
- `bun scripts/scan-committed.ts`: PASS, 151 files free of home paths, credentials, identifiers and private addresses.
- `tsc --noEmit --strict`, with the repo's compiler options, on fixtures.test.ts: exit 0.
- I broke six things in a scratch copy of the fixtures and the tests caught all of them (8 tests failed).

**Findings for Stages 3–5**
- **The current log parser accepts a fake completion line.** `service/lmstudio-activity.ts:72` matches `/(?:^|\s)Done\s*·/` anywhere in a line. Run over `drop-incoming-tokens`, it reads the imitation line as a finished request, with token counts taken from generated text. The adapter should only accept `^(?:\d{2}:\d{2}:\d{2} )?(?:Done|Cancelled) · ` on a DEBUG line with no model tag.
- **Stock LM Studio has no `Done ·` summary line.** It is printed by the Splash engine (incoai/splash@e8fffde `server/diagnostics.py:16-46`) and passed through by Bionic. Stock llama.cpp and MLX engines do not print it, so exact per-request figures from the log only exist for Bionic serving Splash models.

**Not captured live** (marked in SOURCE.md):
- the v0 `"loading"` state value;
- the whitespace of `/api/v1/models` bodies (not on the approved GET list, so not requested);
- the `lms ps` record for a loaded Splash model. `format: "yuzu"` is inferred because the CLI's format list has no `"splash"`;
- the exact wording of the per-token `Accumulated … tokens` lines and of the request-body line.

**Live access used:**
- GETs to Bionic `/lmstudio-greeting` and `/api/v0/models`;
- one run each of `lms ps --json` and `lms runtime ls`, both with `LMS_API_SERVER_INFO_PATH` and `--port 41343`;
- `lms version --json`, run without the info path or port. It is local-only: it prints the CLI commit and does not contact the server.

No inference was sent and nothing was loaded, unloaded, started or stopped.


# FIXTURE REPORT: host

BRANCH: fixtures/host (created from 730c2bf; committed, not pushed)
SHA: ad57b24e33ba0bf1b195b5931a155e45aa8904f2

FILES (38 added; nothing outside tests/fixtures/host/ changed)
- tests/fixtures/host/fixtures.test.ts
- tests/fixtures/host/.editorconfig: keeps editors from trimming the `ps` trailing padding or adding final newlines to the cut files.
- tests/fixtures/host/macos-27/SOURCE.md
- tests/fixtures/host/macos-27/*.txt (35 fixtures, listed below)

VARIANTS (all in macos-27/)
- vm_stat: normal (16 KiB pages, with the 11 MTE tag lines), no-mte, pressure
- sysctl -i: all-keys (pressure 1, no swap, wired limit 40960), pressure-2, pressure-4, missing-key (iogpu key dropped silently by -i), wired-limit-default (`iogpu.wired_limit_mb: 0`, meaning not set)
- ioreg:
  - idle (45,574 B) and busy (45,861 B, Device 87 %): each has PerformanceStatistics with Device/Renderer/Tiler Utilization %, Alloc system memory, In use system memory (plus the "(driver)" key) and recoveryCount, and AGCInfo `fLastSubmissionPID=4242`.
  - truncated: cut at `"Device Utilization %"=8`, with no closing brace and no newline.
  - oversize: a complete node of 132,255 B, over the 128 KiB cap.
  - no-match: empty output, exit 0.
- notifyutil: level-0 … level-4 (`com.apple.system.thermalpressurelevel N`); failed (`: Failed with code 9` on stdout, exit 0); out-of-range (30)
- lsof -t: listening (`4242`), multiple (`4242`, `4243`), empty (exit 1)
- footprint (oMLX-like `python3 [4242]`):
  - loaded (19 GB, peak 20 GB), unloaded (275 MB, peak still 20 GB)
  - no-categories
  - no-categories-bytes (`-f bytes`, exact page-aligned values)
  - not-found (stderr, exit 66)
- ps -o lstart=: normal, single-digit-day (`Oct  1`), not-found (empty, exit 1)
- macmon-pipe NDJSON:
  - normal (v0.8.2, three samples with every power field and sys_power ≥ all_power)
  - sys-power-zero (`"sys_power":0.0`)
  - legacy (v0.7.2 tuple fields)
  - partial-line (third line cut at `"gpu_power":2`)

PROVENANCE (full detail in SOURCE.md)
- Synthesized from upstream source, with tag, commit and file:line for each:
  - vm_stat and sysctl: system_cmds-1042.120.1 @15832a89
  - notifyutil: Libnotify-348.120.4 @227c145b
  - lsof: lsof-76 @7a8a1b2a
  - ps: adv_cmds-237 @6bed8737
  - the ioreg printer: IOKitTools-125 @e6f4aac8
  - macmon: v0.8.2 @6919d778 and v0.7.2 @20665fde
- ioreg and footprint come from closed-source tools, so they are modeled on live macOS 27.2 captures and scrubbed. PIDs, registry id, scheduler state, performance statistics, parameter-buffer values, one opaque subgroup id and every footprint number were replaced. The static IOReportLegend driver metadata was kept, which is why the files are about 45 KB.
- No live PIDs, owner values, paths, usernames or model ids remain; I grepped the fixtures for the captured values and found none.
- Live commands were read-only; no inference was run and no runtime was contacted.

CANARIES
- PID `4242` is in the ioreg AGCInfo line (idle, busy, oversize and truncated), both lsof files, every footprint header and the footprint not-found message.
- PID `4243` is in lsof.multiple.txt.
- The test checks each file carries its canary, that no other file contains 4242 or 4243, and that every PID position in the corpus holds one of them.

VERIFICATION
- `bun test tests/fixtures/host`: 58 pass, 0 fail, 1975 expect() calls.
- `bun scripts/scan-committed.ts`: PASS, 168 files free of home paths, credentials, identifiers and private addresses.
- `tsc --noEmit` under the repo's strict settings on fixtures.test.ts: rc 0 (the repo tsconfig does not include tests/fixtures, so this was run separately).
- A mutation check on a scratch copy (a real-looking PID in ioreg, a home path in vm_stat, a row removed from SOURCE.md) made the relevant tests fail as intended.

NOTES
- For Stage 5 adapter tests:
  - `lsof.empty.txt`, `ps.not-found.txt` and `footprint.not-found.txt` exit non-zero, so the current `readCommand` returns null for them.
  - `notifyutil` prints its failure line on stdout with exit 0, so it must be matched as a failure, not parsed as a level.
- Formatted footprint rounds to whole units ("19 GB"). The `-f bytes` form is exact, but it is only usable if Stage 5 allows that argument.

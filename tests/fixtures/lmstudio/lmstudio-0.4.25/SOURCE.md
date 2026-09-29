# LM Studio 0.4.25 · notes (no fixture files)

LM Studio 0.4.25 is the stock LM Studio version reviewed in `docs/COMPATIBILITY.md`.

This folder holds **notes only**. Stock LM Studio is not installed on the capture Mac, so none of its bodies were observed live. Every shape below comes from upstream docs and source. Adapters should use the Bionic corpus in `../bionic-1.1.6/` and apply the differences listed here.

**Sources**
- lmstudio-ai/docs@9b8bc20: `1_developer/2_rest/list.md`, `1_developer/2_rest/endpoints.mdx`, `1_developer/api-changelog.md`, `3_cli/0_local-models/ps.md`, `3_cli/1_serve/log-stream.md`
- lmstudio-ai/lms@1017bcb (the CLI bundled with Bionic 1.1.6) and lms main @1b7181b
- lmstudio-ai/lmstudio-js@6d2b268 `packages/lms-shared-types`

**Which lms ships with 0.4.25 was not verified.**

## Same as Bionic 1.1.6
- `GET /lmstudio-greeting` → `{"lmstudio":true}`. `lms` requires exactly this before it talks to a server (lms `src/createClient.ts:19-42`).
- The `GET /api/v0/models` shape has the same keys. The docs example lists `object` before `data`, while Bionic sends `data` first. Key order is not a contract.
  - `capabilities` (for example `["tool_use"]`) has been present since 0.3.16 (API changelog).
  - `compatibility_type` is `mlx` or `gguf`, never `splash`.
- The `lms ps --json` record shape is identical: the zod `llmInstanceInfoSchema` / `embeddingModelInstanceInfoSchema` plus `status`, `queued` and `parallel`.
  - lms main @1b7181b also appends `engineConfigFileEnabled`, so adapters must ignore unknown keys.
  - `format` uses the SDK enum `gguf | safetensors | … | yuzu | openvino`. MLX models are `safetensors`, not `mlx`.
- The `lms runtime ls` columns are identical: `LLM ENGINE | SELECTED | MODEL FORMAT`, columnify with a 4-space splitter.
- `lms log stream -s server --json` uses the same record shape, `{timestamp, data:{type:"server.log", content, level}}`. The shared server lines are the same text: `Running chat completion…`, `Prompt processing progress: N%`, `Streaming response...`, `Finished streaming response` and `Generated prediction:`.

## Different from Bionic 1.1.6
- **`/api/v1/models` exists since 0.4.0** (API changelog, "LM Studio native v1 REST API").
  - `format` is `"gguf" | "mlx" | null`, never `"splash"`, so `engine` and `host` stay `null`.
  - LLM `capabilities` may carry `reasoning {allowed_options, default}`.
  - Multi-variant models add `variants[]` and `selected_variant`.
  - Loaded-instance `config` may carry `eval_batch_size`, `parallel`, `flash_attention`, `num_experts` and `offload_kv_cache_to_gpu` (docs `list.md`).
  - Requests may need an API token when authentication is enabled; a 401 must not fall back to v0.
- **No `Done ·` completion summary.** The summary line is printed by the Splash engine (incoai/splash `server/diagnostics.py`) and relayed by Bionic. The llama.cpp and MLX engines in stock LM Studio do not print it.
  - The contract's `reported` completion basis for LM Studio (contract §4) therefore holds only for Splash-backed Bionic.
  - With stock engines, the log stream yields request start, prompt progress and finish, but **no exact per-request figures**. Stage 3–5 adapters must withhold them rather than derive them.
- **`lms runtime ls`** lists no `splash-…` / `yuzu` row. Formats are `GGUF` and `MLX` (and `PTE` for the executorch ASR engine).
- **Route-missing body.** Hosts before 0.4.0 (0.3.x) answer `GET /api/v1/models` with HTTP 200 and `{"error":"Unexpected endpoint or method. (GET /api/v1/models)"}`. `../bionic-1.1.6/api-v1-models.route-missing.json` stands in for that body; the v0 fallback applies.

## To capture when stock LM Studio 0.4.25 is available
- `/api/v1/models`, with and without a loaded GGUF and MLX model;
- the `/api/v0/models` state while a model is loading;
- `lms ps --json` for one loaded model, to confirm which lms ships with it;
- `lms runtime ls`;
- a redacted `lms log stream -s server --json` request, to confirm the absence of the summary line.

Use GET requests only, and run `lms` only with `LMS_API_SERVER_INFO_PATH` and `--port`. Scrub model ids to `publisher/example-*`.

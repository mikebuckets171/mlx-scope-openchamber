# Ollama 0.40.0 fixture corpus

**Version represented:** Ollama `v0.40.0-rc0` (tag commit `75b952780f90807f651eb2f1f817e5a40126e81d`, 2026-09-25), the
newest tag when this corpus was written. Re-diff the cited files at `v0.40.0` final.

**Provenance:** every file here is **synthesized from upstream source**. Nothing was captured from a live Ollama, and no
request was made to one: the owner archived the Ollama stack on 09-20, so Ollama is fixture-qualified (plan §5.3).

**Synthetic only.** Model names use the `example-model`, `publisher/Example-27B-4bit` and `hf.co/publisher/...` styles.
Paths use `/Users/fixture`. Digests are `sha256("fixture:<seed>")` and name no real blob. Timestamps, sizes and context
lengths are chosen to be plausible, not measured. The only prompt-like or identifying strings are the labelled canaries
below.

## Wire format (applies to every JSON file)

- Routes: `GET /api/version`, `GET /api/tags` and `GET /api/ps` (`server/routes.go:2031-2032,2041-2042,2062`).
- Every body is written by gin v1.10.0 `render.WriteJSON`, which calls `json.Marshal` and writes the bytes (gin
  `render/json.go:66-74`). The bodies are therefore **compact, with no trailing newline**, and fields follow Go struct
  order. Content-Type is `application/json; charset=utf-8`. The files reproduce this byte for byte, and
  `fixtures.test.ts` checks it.
- `time.Time` fields (`expires_at`, `modified_at`) are RFC 3339 with nanoseconds and trailing zeros trimmed. They use the
  daemon's local offset (`-07:00` / `-08:00`), or `Z` when the daemon runs in UTC.
- `digest` is 64 lowercase hex characters with **no** `sha256:` prefix. For `/api/ps` it is the manifest digest
  (`server/routes.go:2438-2441`, `server/images.go:689-698`, `manifest/manifest.go:136,171-173`). For `/api/tags` the prefix is
  trimmed explicitly (`server/model_list.go:105,183`).
- `name` and `model` are the same string, `model.ParseName(...).DisplayShortest()` (`types/model/name.go:231-249`). The
  tag is always included. The `library/` namespace and the default host are dropped. Other hosts keep their full
  `host/namespace/model:tag` form (for example `hf.co/...`). Case is preserved.

## Shapes (from `api/types.go` at the tag)

| Route | Type | Lines | Fields (in order) |
|---|---|---|---|
| `/api/version` | `gin.H` | `server/routes.go:2032` | `version` (string; `version/version.go:3` defaults to `"0.0.0"`) |
| `/api/ps` | `ProcessResponse` → `[]ProcessModelResponse` | 875-878, 893-903 | `name`, `model`, `size`, `digest`, `details`, `expires_at`, `size_vram`, `context_length`, `runner`? |
| `/api/tags` | `ListResponse` → `[]ListModelResponse` | 839-841, 880-890 | `name`, `model`, `remote_model`?, `remote_host`?, `modified_at`, `size`, `digest`, `details`, `capabilities`? |
| `details` | `ModelDetails` | 992-1005 | `parent_model`, `format`, `family`, `families` (array **or null**), `parameter_size`, `quantization_level`, `context_length`?, `embedding_length`?, `runner`? |

`?` = `omitempty`. `details` is a struct, so `omitempty` never drops it: it is always present. `families` has no
`omitempty`, so a nil slice encodes as `null`; safetensors imports do this, see below.

**`/api/ps` specifics** (`PsHandler`, `server/routes.go:2432-2483`)
- The list starts as `[]api.ProcessModelResponse{}`, so no loaded models is `{"models":[]}`, never `null`.
- `details` is built from the model config only. `parent_model` is always `""`. `details.context_length`,
  `details.embedding_length` and `details.runner` are never set there, so they never appear in `/api/ps`.
- Top-level `runner` is normalized to `ggml`, `llamacpp` or `mlx` (`server/routes.go:214-227`, `manifest/manifest.go:35-37`).
  Legacy GGUF manifests report `ggml`, and safetensors report `mlx` (`manifest/manifest.go:868-877`).
- Rows are sorted by `expires_at`, **latest first** (`server/routes.go:2476-2479`).
- `size`, `size_vram` and `context_length` come from the runner's `MemorySize()` and `ContextLength()`
  (`server/sched.go:1787-1828`). The MLX runner returns the same value for both sizes, its current memory
  (`mlxrunner/client.go:536-539`). So for `runner: "mlx"`, `size === size_vram`, and the value grows with the KV cache.
- `expires_at`:
  - It is set to *now + keep_alive* when a request finishes (`server/sched.go:415,419`).
  - While a model is still loading it is estimated from the session duration (`server/sched.go:1818-1823`).
  - `keep_alive < 0` becomes `time.Duration(math.MaxInt64)` (`api/types.go:1225-1253`), so `expires_at` lands about 292
    years out.

**`/api/tags` specifics** (`listModels`, `server/model_list.go:22-260`)
- Empty is `{"models":[]}` (`make(..., 0, n)`).
- Rows are sorted by `modified_at` descending, then `name`, then `digest` (`:246-260`).
- `size` is the on-disk manifest size (layers + config, `manifest/manifest.go:142-148`), not a memory figure.
- `details.context_length`, `details.embedding_length` and `details.runner` *are* populated here (`:166-221`).
- `capabilities` values come from `types/model/capability.go`: `completion`, `tools`, `insert`, `vision`,
  `embedding`, `thinking`, `image`, `audio`.
- **Manifest lists** (present at this tag) produce one row per child runner. The rows share `name` and the parent's
  `modified_at`, and have different `digest`, `size` and `details.runner` (`:76-113`). **`name` is not unique in
  `/api/tags`.**
- Safetensors (MLX) imports store only `model_format` plus the create-request `info` fields (`create/metadata.go:47-53`,
  `server/create.go:559-575`, `create/manifest.go:66-74`). `family` and `parameter_size` can therefore be `""` and
  `families` can be `null`. `quantization_level` uses MLX names: `int4`, `int8`, `nvfp4`, `mxfp4`, `mxfp8`
  (`create/quantize.go:57-63`, `server/create.go:1265-1283`). GGUF uses `Q4_K_M`, `Q8_0`, `F16` and so on, and its
  `parameter_size` comes from `format.HumanNumber` (`format/format.go:15-34`: `27.2B`, `8.0B`, `334.09M`).

## Labels Scope must use (plan §5.3; contract §4 fixed labels and §6 `ResidencyV2`)

- **`size_vram` is shown as "GPU-resident (Ollama-reported)". Never "VRAM".** Apple Silicon has unified memory: there is
  no separate video RAM. This number is only Ollama's own account of how many bytes of the loaded model it placed on the
  GPU (Metal) side. It is not a measurement of a distinct memory pool, and it is not system-wide GPU memory.
- `size` → `ResidencyV2.bytes` ("Ollama size"). `size_vram` → `ResidencyV2.gpuResidentBytes`. `expires_at` →
  `ResidencyV2.unloadsAt`, shown as "unloads in". A far-future value (the keep-alive-forever variant) means kept loaded,
  not a countdown.
- Coverage is inventory: "Ollama reports residency only." There are no completions, rates or requests.
- Detection (plan §5.1, order 3): `/api/version`, then `/api/ps`.

## Files and variants

| File | Route | What it represents / is for |
|---|---|---|
| `api-version.default.json` | `/api/version` | Release build of 0.40.0. Detection happy path. |
| `api-version.rc.json` | `/api/version` | Release-candidate build (`0.40.0-rc0`, the version this corpus is sourced from). The version parser must accept a pre-release suffix. |
| `api-version.source-build.json` | `/api/version` | Built from source without `-ldflags`: `version.Version` keeps its `"0.0.0"` default (`version/version.go:3`). Detection must still succeed and must not treat this as "too old". |
| `api-ps.none.json` | `/api/ps` | Nothing loaded: `{"models":[]}`. The runtime is up and idle, with no residency rows. |
| `api-ps.one-model.json` | `/api/ps` | One GGUF model (`runner: ggml`), fully GPU-resident on Metal: `size_vram === size` (the `ollama ps` "100% GPU" case), default 5-minute keep-alive. |
| `api-ps.two-models.json` | `/api/ps` | Two resident models, sorted by `expires_at`, latest first. Row 1 is an MLX safetensors model (`runner: mlx`, `size === size_vram`, `family: ""`, `families: null`, `quantization_level: int4`, 30-minute keep-alive). Row 2 is the GGUF model from `one-model`. |
| `api-ps.cpu-only.json` | `/api/ps` | Model fully on CPU: `size_vram: 0` (for example `num_gpu: 0`, or no Metal backend). Uses an `hf.co/` host-qualified name and a UTC (`Z`) `expires_at`. The adapter must show 0 GPU-resident bytes, not "unknown". |
| `api-ps.partial-offload.json` | `/api/ps` | Model too large for the Metal working set: `0 < size_vram < size` (about 82 % GPU, the `ollama ps` "18%/82% CPU/GPU" case). |
| `api-ps.keep-alive-forever.json` | `/api/ps` | `keep_alive: -1`: `expires_at` = now + `MaxInt64` ns = `2319-01-09T12:49:29.273080807-08:00` (a January date, so PST). "Unloads in" must render as "kept loaded" or equivalent, never as a 292-year countdown or an overflow. |
| `api-ps.canary.json` | `/api/ps` | **Class B canary**: model name `publisher/CANARY-MODEL-7f3a:latest` in `name` and `model`. It may reach `/v2/snapshot`, the in-view DOM and the ledger. It must never reach Copy, compose, `/scope`, toasts, the baseline summary, `capture.v2` or receipts. |
| `api-tags.empty.json` | `/api/tags` | No local models: `{"models":[]}`. |
| `api-tags.small.json` | `/api/tags` | Small realistic inventory, newest first: an MLX safetensors chat model (with `thinking`), a GGUF chat model (with `details.context_length`, `embedding_length` and `runner`), and a GGUF embedding model (`capabilities: ["embedding"]`, `334.09M`, `F16`). |
| `api-tags.manifest-list.json` | `/api/tags` | One manifest-list model with two child rows, `example-model:27b` × {`mlx`, `ggml`}. Same `name` and `modified_at`, different `digest`, `size` and `details.runner`. Proves the catalog does not key on `name` alone. |
| `api-tags.canary.json` | `/api/tags` | **Class A canaries** (see below), plus a Class B model-name canary. Row 1 is a GGUF file import whose `details.parent_model` is the relative source path given to `ollama create` (`server/create.go:682,727,1100`, `server/images.go:743`). Row 2 is a remote model with `remote_model` and `remote_host` (`server/model_list.go:180-181`) and empty details. |
| `api-tags.error-500.json` | `/api/tags` (HTTP 500) | `ListHandler` error body `{"error": err.Error()}` (`server/routes.go:1791-1799`). The text is an `os.PathError` from `manifest.manifestPath` (`manifest/paths.go:51-57`) under a custom `OLLAMA_MODELS`, so it embeds an absolute path. **Class A canary**: runtime free text must never be forwarded. |

## Planted canaries

| Canary | Class | File | JSON location | Must never appear in |
|---|---|---|---|---|
| `CANARY-MODEL-7f3a` | B (model name) | `api-ps.canary.json` | `models[0].name`, `models[0].model` | Copy, compose, `/scope`, toast, baseline summary, `capture.v2`, receipts |
| `CANARY-MODEL-7f3a` | B (model name) | `api-tags.canary.json` | `models[0].name`, `models[0].model` | as above |
| `CANARY-PATH-7f3a` | A (path / folder name) | `api-tags.canary.json` | `models[0].details.parent_model` | anywhere: routes, query, storage, DOM, shares, logs. Drop `parent_model` at parse time. |
| `CANARY-HOST-7f3a` | A (host) | `api-tags.canary.json` | `models[1].remote_host` | anywhere. Drop `remote_host` (and `remote_model`) at parse time. |
| `CANARY-PATH-7f3a` + `/Users/fixture` | A (path, username) | `api-tags.error-500.json` | `error` | anywhere. Map to a reason code; never forward the text. |

The realistic variants carry no canary, so an adapter test can use them for the happy path and the canary files for leak
tests. `fixtures.test.ts` checks that every `CANARY-*-7f3a` occurrence is one of the rows above.

**Also Class A-adjacent, not planted:** an `hf.co/<namespace>/...` model name can embed a person's Hugging Face username
inside a Class B field. The Class B rules (never in shares) already cover it.

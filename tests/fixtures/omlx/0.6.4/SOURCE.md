# oMLX 0.6.4 fixture corpus

**Version:** oMLX `0.6.4` ([jundot/omlx@v0.6.4](https://github.com/jundot/omlx/tree/1d7826185c5b5b69b38b27cbe57d7597b7551fd7),
commit `1d7826185c5b5b69b38b27cbe57d7597b7551fd7`), the last stable release before 0.7. This is the 2.0 fallback
target: `/api/status` exists here, `/admin/api/usage` does not.

**Provenance.** Every file is **synthetic**. Each body was produced by a transcription of the cited upstream handler at
the tag, fed with made-up state. No 0.6.4 server was running, so nothing was captured live.
- The `/health` and `/api/status` handlers are line-for-line identical to 0.7.0rc1.
- `_build_active_models_data` differs only in lacking the `cluster` key and the rank-zero cluster rows.
- The 404 body is FastAPI's default for an unmatched route. It was reproduced in-process with the same handler
  registration (FastAPI 0.141.1 / pydantic 2.13.5). No request went to a running oMLX.

**Encoding.** Same as `../0.7.0rc1/SOURCE.md`: Starlette `JSONResponse.render` bytes (compact, Python key order and
float repr) plus one trailing LF. Status codes are in the table below.

**Synthetic values.**
- Models: `Example-27B-4bit` and friends. Ceiling 42 GiB, balanced guard tier. Paths use `/Users/fixture`.
- Engine commits are the public 0.6.4 `pyproject.toml` pins. Engine versions other than mlx-lm 0.31.3 are made up.

## Privacy canaries

| Canary | Where | Why |
|---|---|---|
| `CANARY-API-KEY-7f3a` inside `api_key: "fixture-CANARY-API-KEY-7f3a"` | `admin-api-stats.canary.json` | The plaintext main key. The `fixture` prefix is required by `scripts/scan-committed.ts`. |
| `host: "CANARY-HOST-7f3a"`, `port: 32570` (0x7f3a) | `admin-api-stats.canary.json` | Bind settings. |
| `CANARY-CLI-7f3a` in `cli_prefix` | `admin-api-stats.canary.json` | Absolute app-bundle path. |
| `CANARY-PATH-7f3a` | `runtime_cache.{base_path, ssd_cache_dir, response_state_dir}` in `admin-api-stats.canary.json` | File paths. |
| Request ids `00000000-7f3a-4000-8000-…` | `admin-api-activity.generating.json`, `admin-api-stats.canary.json` | `uuid4()` request ids (class A). |

No prompt text and no PIDs exist in these routes.

## Files

Upstream paths are relative to `omlx/` at the tag.

| File | HTTP | Request | Upstream | Purpose |
|---|---|---|---|---|
| `health.healthy.json` | 200 | `GET /health` | `server.py:2467` | Same 4 keys and `engine_pool{model_count, loaded_count, final_ceiling, current_model_memory}` as 0.7. One model loaded. |
| `health.loading.json` | **503** | `GET /health` | `server.py:2467` | Pinned preload still running: `status: "loading"`. |
| `api-status.idle.json` | 200 | `GET /api/status` | `server.py:2517`, auth `server.py:312` | The same 23 keys as 0.7, with `version: "0.6.4"`. This is the fallback when admin login is refused. |
| `api-status.busy.json` | 200 | `GET /api/status` | `server.py:2517` | `active_requests: 1`, `waiting_requests: 2`. |
| `api-status.unauthorized.json` | **401** | `GET /api/status` without a key | `server.py:312`, `server.py:733` | `{"detail":"API key required"}`. |
| `admin-api-usage.not-found.json` | **404** | `GET /admin/api/usage?range=7d` | no route (`admin/routes.py` has none; `usage_history.py` does not exist) | FastAPI's default `{"detail":"Not Found"}`. Hide the usage card (SPIKES S6). Being 404, not 401, it means "route missing", even with a valid admin cookie. |
| `admin-api-activity.generating.json` | 200 | `GET /admin/api/activity` | `admin/routes.py:5276`, builder `admin/routes.py:5282` | One generating row. Model rows have **no `cluster` key** (added in 0.7), so adapters must treat it as optional. |
| `admin-api-stats.canary.json` | 200 | `GET /admin/api/stats` | `admin/routes.py:5231` | Strip-at-parse canary fixture: snapshot keys, then `host`, `port`, `api_key`, `cli_prefix`, `engines`, `active_models` (0.6.4 rows, no `cluster`) and `runtime_cache` (`admin/routes.py:4925`). |

## Traps these fixtures pin down
- 0.6.4 has no usage route at all. A 404 here is a version signal, not an auth failure.
- The `cluster` key is absent in 0.6.4 activity rows. A parser that requires it would drop every 0.6.4 model.
- `/api/status` `cache_efficiency` is a percent (0–100, one decimal), as in 0.7.

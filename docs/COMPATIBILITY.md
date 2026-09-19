# Compatibility

## Reviewed contracts

| Project | Reference | Coverage |
| --- | --- | --- |
| OpenChamber | [1.24.2](https://github.com/openchamber/openchamber/releases/tag/v1.24.2) | Published and installed SDK, services, themes, storage, draft composition, extension surfaces |
| oMLX stable | [0.6.4](https://github.com/jundot/omlx/tree/1d7826185c5b5b69b38b27cbe57d7597b7551fd7) | Request activity, statistics, cache lookup, authentication, model context |
| oMLX prerelease | [0.7.0.dev4](https://github.com/jundot/omlx/tree/14194fe74bab38b89c144bd89656fbedca641d14) | Loading, DFlash/Lightning/MTP, and distributed telemetry boundaries |
| vllm-mlx | [0.5.0](https://github.com/waybarrios/vllm-mlx/tree/b064502055a68aaf94c6c58f9c0d749e0bd4f8cb) | Status, engine metadata, canonical request records, model registry |
| LM Studio | [0.4.25](https://lmstudio.ai/changelog/lmstudio/lmstudio-v0.4.25) and [REST model API](https://lmstudio.ai/docs/developer/rest/list) | v1 model inventory; v0 fallback for older hosts |
| mlx-lm | [0.31.3](https://github.com/ml-explore/mlx-lm/tree/ed1fca4cef15a824c5f1702c80f70b4cffc8e4dd) | Server availability and available model catalogue |

The extension pins SDK 1.24.2 and declares OpenChamber 1.24.2 as its minimum.
Desktop and web clients expose the required extension surfaces; mobile and
VS Code clients do not. Runtime and Mac resource readings belong to the
OpenChamber server's computer.

Adapters are checked against official documentation/source and synthetic fixtures.
**LM Studio, mlx-lm, and vllm-mlx were not run live for this release.** This is not
telemetry parity across runtimes or a claim that every engine/model/version was
exercised. Missing or unsupported fields remain unavailable.

## oMLX

The activity API distinguishes no model, resident idle, loading, queue, prefill,
generation, and generic processing. Normal prefill uses reported processed/total
counts and a valid stage estimate. Stale progress remains visibly held, while
speed and estimate are withheld. Request changes and ambiguous concurrency break
observation continuity. Cache reuse requires matched request identity. Context
headroom uses the reported model limit, which may differ from a request-profile
override. Process footprint, model allocation, RAM cache, and SSD cache stay separate.

The [primary DFlash engine](https://github.com/jundot/omlx/blob/14194fe74bab38b89c144bd89656fbedca641d14/omlx/engine/dflash.py)
reports accepted output through generic activity counters. Activity elapsed time
includes preparation and is not a generation duration. MLX Scope calculates
**recent output** from fresh counter differences. Before output, it shows processing
without a prefill percentage or estimate. Standard fallback retains its reported
prefill and generation behavior.

Lightning/MTP appear only through the same recognized telemetry contracts.
Session/last-request speculation totals do not become current-request acceptance
ratios. Distributed rank records do not establish individual request identity.

## vllm-mlx

The [status endpoint](https://github.com/waybarrios/vllm-mlx/blob/b064502055a68aaf94c6c58f9c0d749e0bd4f8cb/vllm_mlx/server.py)
provides server counts and request records. Per-request output/speed requires one
canonical running request, a matching model/identity, and fresh output advancement.
Concurrent or ambiguous requests withhold the headline rate. Reported runtime
counters are not guaranteed successful-completion counts.

Prefill differs by engine. The LLM `progress` field measures output against its
output limit, so it is never used as prefill. Only batched MLLM reports a usable
prefill fraction. Zero/one are ambiguous and withheld; held fractions wait for
observed advancement after a gap. Processed-token counts and stage estimates are
unavailable. Request-matched reuse is exposed only for the
text batched engine with a recognized cache classification and consistent counts.

Model-registry mode reports model availability/residency without per-model request
statistics. Context headroom is unavailable. A valid reported hot-cache size can
be displayed; Metal allocator memory is not presented as an OS process footprint.

## LM Studio

[GET `/api/v1/models`](https://lmstudio.ai/docs/developer/rest/list), introduced in
0.4.0, reports models, format, and loaded instances. Scope uses each instance's
configured context limit when unambiguous. A model's file size is not RAM usage;
configured parallelism is not active work. Loaded means loaded, not idle.

A route-not-found response permits the documented [v0 model API](https://lmstudio.ai/docs/developer/rest/endpoints)
fallback (0.3.6+). Authentication failures and malformed responses do not trigger
that fallback. Model-level v0 context limits are not current request budgets.

Passive REST reads do not expose live speed, prefill, reuse, queue, or process RAM.
Statistics inside inference responses and experimental conversation-log streams
are not used. The view shows inventory and host resources. With authentication
enabled, use an existing [LM Studio API token](https://lmstudio.ai/docs/developer/core/authentication).

## mlx-lm

The [official server](https://github.com/ml-explore/mlx-lm/blob/ed1fca4cef15a824c5f1702c80f70b4cffc8e4dd/mlx_lm/server.py)
exposes health and `/v1/models`. The model endpoint lists locally available files;
it does not prove a model is loaded. Scope displays that catalogue and host resources.
Request progress, output speed, context headroom, cache, and residency stay unavailable.

The generic health/catalogue responses are not a reliable runtime fingerprint.
Use a recognizable provider name or choose **mlx-lm** in the connection setup.
The catalogue is cached for a minute because reading it scans the model cache.

## OpenChamber boundaries

The [published SDK](https://github.com/openchamber/openchamber/blob/v1.24.2/packages/sdk/API.md)
provides a panel, full-page entry in **Extension pages**, a session-menu action,
live theme/typography, storage, clipboard, append-only draft composition, UI helpers,
and [local services](https://github.com/openchamber/openchamber/blob/v1.24.2/packages/sdk/GUEST_SERVICES.md).

It does not provide a custom `/scope` route, global keyboard-shortcut registration,
or a Turn Stats contribution hook. It does not map server-wide runtime requests
to completed chat turns. MLX Scope leaves Turn Stats alone and does not scrape
host DOM or private conversation data. It observes configured local connections;
it does not manage models, cache, inference, or credentials.

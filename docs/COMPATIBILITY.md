# Compatibility

## Reviewed contracts

| Project | Reference | Scope |
| --- | --- | --- |
| OpenChamber | [1.24.2](https://github.com/openchamber/openchamber/releases/tag/v1.24.2) | Published SDK, installed host SDK, guest-service contract, themes, storage, draft composition, and extension surfaces |
| oMLX stable | [0.6.4](https://github.com/jundot/omlx/tree/1d7826185c5b5b69b38b27cbe57d7597b7551fd7) | Activity, statistics, cache lookup, authentication, and model context |
| oMLX prerelease | [0.7.0.dev4](https://github.com/jundot/omlx/tree/14194fe74bab38b89c144bd89656fbedca641d14) | Startup/loading response and current DFlash, Lightning, and MTP telemetry contracts |

The extension pins SDK 1.24.2 and declares OpenChamber 1.24.2 as its minimum.
Desktop and web extension clients are supported; mobile and VS Code clients do
not expose these extension surfaces. Mac readings describe the OpenChamber
server’s host, which must also run the local oMLX endpoint.

The review above is source inspection backed by synthetic fixtures and package
checks. It is not a claim that every model, engine, host version, or hardware
combination was exercised live. oMLX’s dashboard response shapes are
version-dependent; missing or unsupported fields remain unavailable.

## Runtime behavior

| Situation | Display contract |
| --- | --- |
| No model / resident idle model | Distinct standby and ready states |
| Loading / queued / non-streaming work | Processing or queue state without fabricated token speed |
| Prefill | Reported stage counters, percentage remaining, and valid stage estimate |
| Generation | Reported request average, with recent observed output labelled separately |
| Frozen prefill or generation | Held/stale state; old throughput is not presented as live |
| Request or phase transition | Break chart/rate continuity; do not combine counters |
| Concurrent requests | Suppress ambiguous single-request headline metrics |
| Multiple models | Bounded per-model roster; no invented combined request rate |
| Cache lookup | Input reuse only when request identity and counters match |
| Context | Reported model limit minus verified prompt and output counts |
| Runtime unavailable / rejected key | Connection state with independent host-resource sampling |
| Missing guard or cache data | Unavailable; allocation, process footprint, RAM cache, and SSD cache remain separate |

## DFlash, Lightning, and MTP

The [primary DFlash engine](https://github.com/jundot/omlx/blob/14194fe74bab38b89c144bd89656fbedca641d14/omlx/engine/dflash.py)
reports accepted output through generic activity token counters. Activity elapsed
time includes preparation, so dividing output by that duration would mislabel a
request-average generation rate. MLX Scope instead uses fresh counter differences
for **recent output** after enough samples arrive.

Primary DFlash does not expose live prefill stage counters through these
monitoring endpoints. Before output, MLX Scope shows processing without a
percentage or estimate. The standard scheduler fallback retains its reported
prefill and generation behavior. Stale activity, missing identity, concurrent
requests, and fallback transitions reset observed-rate continuity.

Lightning/MTP work is displayed only through the same recognized activity,
prefill, and generation contracts. Session or last-request speculation totals do
not establish current-request acceptance, so no speculative acceptance ratio or
engine-performance claim is inferred from them. Missing input, reuse, and context
measurements stay unavailable.

## OpenChamber boundaries

The [published SDK](https://github.com/openchamber/openchamber/blob/v1.24.2/packages/sdk/API.md)
provides a panel, full-page entry in **Extension pages**, a session-menu shortcut,
live theme and typography, extension storage, clipboard, append-only draft
composition, UI helpers, and [local services](https://github.com/openchamber/openchamber/blob/v1.24.2/packages/sdk/GUEST_SERVICES.md).

It does not provide a custom `/scope` route, global keyboard shortcut registration,
or a Turn Stats contribution hook. It also does not map server-wide oMLX requests
to completed chat turns. MLX Scope leaves Turn Stats alone and does not scrape the
host DOM or private conversation data. Background actions, inference controls,
model loading, and cache management are outside this monitor’s scope.

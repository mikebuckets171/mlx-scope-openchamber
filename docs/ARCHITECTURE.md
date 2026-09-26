# Architecture

MLX Scope has a sandboxed OpenChamber panel and a host-managed local service.
Both ship as bundled JavaScript. There is no separate daemon or runtime SDK to install.

## Data flow

```text
OpenChamber panel → SDK serviceRequest → connection router → runtime adapter
                                              └──────────→ host resource sampler
```

`service/config.ts` resolves existing local provider connections and credentials.
`service/runtime-client.ts` selects an adapter and shares in-flight reads, caches,
and backoff for the same selection. Adapters observe oMLX, vllm-mlx, LM Studio,
mlx-lm, or Splash through bounded HTTP reads. They do not initiate inference or
manage models.

`src/telemetry.ts` and `src/runtime.ts` define the allowlisted display contracts.
Credentials, raw API responses, and runtime request IDs stay service-side.
Service-local epochs separate request observations without exposing those IDs.
Inventory-only APIs cannot populate request activity merely because a model exists.

`panel/main.ts` mounts the interface once. Live, Compare, and Saved consume the
same snapshots. Controls stay mounted during updates. Charts use bounded SVG
paths; history inspection and captures create no additional runtime requests.
Changing the connection clears transient histories, captures, and pinned references.
The host sampler is shared across connections.

## Sampling and bounds

| Work | Limit |
| --- | --- |
| Active oMLX / vllm-mlx observations | One request at a time per selected connection; 500 ms between completed panel polls |
| Idle observations / mlx-lm health | 2 seconds between polls |
| Splash status | 2 seconds between polls; one `/status` request |
| LM Studio inventory | Shared 5-second cache |
| mlx-lm model catalogue | At most once per minute; this endpoint scans the model cache |
| vllm-mlx engine metadata | At most once per minute, or after a model change |
| oMLX session statistics | At most once every 10 seconds |
| oMLX model context lookup | At most once per minute; 1-second timeout |
| Energy-saving updates | At least 3 seconds between panel polls |
| Runtime failure retries | 1, 2, 4, 8, then at most 15 seconds |
| Basic host resources | Shared 2-second cache, independent of runtime backoff |
| macOS wired/compressed/swap | Shared 10-second cache; two fixed commands |
| Native command execution | 1.5-second deadline; 64 KiB combined output per command |
| Runtime HTTP response | 2 MB maximum; 3-second request timeout; 8-second collection budget |
| Local configuration | Shared 5-second cache; 1 MB per file; 64 provider entries inspected |
| Connections | Eight discovered choices and eight cached adapter selections |
| Charts | 90 seconds; at most 200 throughput points |
| Recent output estimate | At most 24 points across 10 seconds |
| Recent generations | Eight last-seen observations in memory |
| Model display | 12 catalogue/resident summaries; a known total remains separate |
| Captures | 30 or 60 seconds; at most 1,000 samples |
| Saved observations | 12 newest summaries through host storage, saved only on user action |

Intervals are minimum spacing, not guaranteed sample rates. Open views using the
same connection share its cache and in-flight runtime collection. The service has
no autonomous polling timer. Pausing or hiding a view stops new monitoring requests
from that view; bounded reads already in progress may finish. Other visible views
can continue. Saved suspends monitoring until the user returns to a working view.

## Official host integration

The pinned SDK supplies the panel, full-page extension entry, session-menu action,
live theme/typography, local service, service status, storage, clipboard, and
append-only draft composition. MLX Scope applies every host-ready theme update
without remounting and uses SDK UI helpers with accessible DOM inside its iframe.
Connection selection stores only a provider ID and runtime choice.

The guest CSP permits packaged scripts/styles over the host's HTTP(S) asset route
and embedded `data:` transport. WebKit's opaque iframe origin cannot rely on
`'self'` alone. Direct network connections, images, fonts, and form submission stay
blocked; runtime reads use the SDK service bridge.

The SDK does not register a custom `/scope` route or contribute to Turn Stats.
Session metadata enables draft sharing without establishing runtime request
ownership. There is no host DOM scraping or inference-stream interception.

## Packaging and verification

The SDK guest bundler builds the panel. Bun builds an ESM service for the host's
Node-compatible runtime, including the JSONC parser. Bundles are tracked because
repository installation does not compile TypeScript.

`package.json` explicitly lists install files. Packaging checks the manifest,
relative documentation links, archive contents, extracted bytes, and service
startup without dependencies. Fixed entry order, permissions, and timestamps make
repeated packaging of the same build byte-identical. The ZIP and SHA-256 file are
release assets; source, fixtures, and development tools are not installed.

The 2 MiB uncompressed package ceiling catches accidental dependencies or artifacts.
It is not a performance target. Review actual bytes and measured overhead when
changing dependencies or retained data.

## Splash status contract

The adapter reads only the documented `/status` endpoint at a 2-second minimum
cadence. It preserves request counters as raw server-wide values since engine
start, labels decode throughput aggregate, and keeps current/peak Metal allocation
separate from process RSS and model allocation. Request activity, queue, prefill,
cache reuse, active-context use, and process memory remain unavailable. Runtime
instance IDs, PID, host, port, and raw response fields never enter the panel
contract.

## Measuring overhead

Package verification prints compressed and uncompressed sizes. From a built checkout:

```sh
node scripts/measure-overhead.mjs 30
```

This observes the bundled service for 30 seconds each at active (500 ms), idle
(2 seconds), and paused (no requests) cadences after a 5-second warm-up. It uses an
isolated synthetic oMLX server, reports process CPU time, sampled RSS, request
counts, and latency, then stops its service. An extracted `service/main.js` path
can be supplied as the second argument.

The report records host/runtime details and limits. CPU excludes diagnostic
subprocesses; RSS includes shared pages. Other adapters, browser rendering,
battery use, and inference throughput impact require separate measurement.

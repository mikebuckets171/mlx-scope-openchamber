# Architecture

MLX Scope has two runtime parts: a sandboxed OpenChamber panel and its
host-managed local service. Both ship as bundled JavaScript. There is no
separate daemon or framework runtime to install.

## Data flow

```text
OpenChamber panel → SDK serviceRequest → local service → oMLX monitoring endpoints
                                              └──────→ host resource sampler
```

`service/omlx-client.ts` discovers the existing connection, identifies the local
server, handles authentication, and shares in-flight collection. `src/telemetry.ts`
normalizes raw responses into an allowlisted display contract. Credentials and
raw request identifiers stay service-side; a service-local epoch separates chart
segments without exposing those identifiers.

`panel/main.ts` mounts the interface once. Live, Compare, and Saved use the same
snapshot. Interactive controls remain mounted during updates. Charts use bounded
SVG paths; inspecting a past point does not request more telemetry. Captures
aggregate existing samples rather than creating a second sampling loop.

## Sampling and bounds

| Work | Limit |
| --- | --- |
| Active inference observations | One request at a time; 500 ms between completed polls |
| Idle observations | 2 seconds between completed polls |
| Energy-saving updates | At least 3 seconds between polls |
| Runtime failure retries | Exponential backoff, capped at 15 seconds |
| Basic host resources | Shared 2-second cache, independent of runtime backoff |
| macOS wired/compressed/swap | Shared 10-second cache; two fixed commands |
| Native command execution | 1.5-second deadline; 64 KiB combined output per command |
| Runtime response | 2 MB maximum; 3-second request timeout; 8-second collection budget |
| Optional model context lookup | At most once per minute; 1-second timeout |
| Session statistics | At most once every 10 seconds |
| Local configuration reads | At most once every 5 seconds; 1 MB per file |
| Charts | 90 seconds; at most 200 throughput points |
| Recent output estimate | At most 24 points across 10 seconds |
| Recent generations | 8 last-seen observations in memory |
| Model roster | 12 display summaries; reported total remains separate |
| Captures | 30 or 60 seconds; bounded to 1,000 samples |
| Saved observations | 12 newest summaries through host storage, saved only on user action |

These intervals are minimum spacing, not guaranteed sample rates. Network and
host work take time. Open surfaces share service caches and in-flight runtime
requests. The service has no autonomous polling timer. Pausing or hiding a view
stops new monitoring requests from that view; already-started bounded reads may
finish. Other visible views can continue using the shared service.

## Official host integration

The pinned SDK provides the conversation panel, full-page extension entry,
session-menu shortcut, theme and typography updates, local service, service
status, extension storage, clipboard, and append-only draft composition.
MLX Scope applies every host-ready theme update without remounting. It uses the
SDK UI helpers and ordinary accessible DOM inside its own iframe.

The guest CSP permits packaged scripts and styles over the host's HTTP(S) asset
route and its embedded `data:` transport. WebKit's opaque iframe origin cannot
rely on `'self'` alone. Direct network connections, images, fonts, and form
submission remain blocked; runtime reads go through the SDK service bridge.

The SDK does not register a custom `/scope` route or contribute to Turn Stats.
Session metadata enables draft sharing; it does not establish runtime request
ownership. No host DOM scraping or private hooks are used.

## Packaging and verification

The SDK guest bundler builds the panel. Bun builds an ESM service for the host’s
Node-compatible runtime, including the JSONC parser. Built bundles are tracked
because repository installation does not compile TypeScript.

`package.json` explicitly lists install files. Packaging verifies the manifest,
relative documentation links, file bytes, archive contents, and a fresh extracted
service startup without dependencies. Fixed entry order, permissions, and
timestamps make repeated packaging of the same build byte-identical. The ZIP
and SHA-256 file are release assets; source, test fixtures, and development tools
are not installed.

The 2 MiB uncompressed package ceiling catches accidental dependency or artifact
inclusion. It is not a performance target. Review the actual bytes and measured
overhead when changing dependencies or retained data.

## Measuring overhead

Package verification prints compressed and uncompressed sizes. From a built
checkout, run:

```sh
node scripts/measure-overhead.mjs 30
```

This observes the bundled service for 30 seconds each at active (500 ms), idle
(2 seconds), and paused (no requests) cadences after a 5-second warm-up. It uses
an isolated synthetic loopback runtime, reports process CPU time, sampled RSS,
request counts, and snapshot latency, then stops its own service. Pass an
extracted `service/main.js` path as a second argument to measure that package.

The JSON report records host/runtime details and measurement limits. CPU excludes
diagnostic subprocesses; RSS includes shared pages. Browser rendering, battery
use, and inference throughput impact are not measured. Report those separately
before making broader overhead claims.

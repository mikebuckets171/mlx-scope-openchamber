# MLX Scope

Lightweight local model monitoring for OpenChamber.

Keep useful runtime readings beside your conversation. MLX Scope observes oMLX,
vllm-mlx, LM Studio, mlx-lm, and Inco AI Splash through their supported passive
APIs. Each view reflects what that server actually reports.

| Runtime | Available readings |
| --- | --- |
| **oMLX** | Prefill remaining and stage estimate, generation and recent output speed, context/reuse, model activity, cache and process readings |
| **vllm-mlx** | Reported request activity, queue, output and speed; prefill and reuse where the engine exposes usable data |
| **LM Studio** | Available and loaded models, model format, loaded-instance context limits |
| **mlx-lm** | Server availability and available model catalogue; model residency is not reported |
| **Inco AI Splash** | Loaded model and declared context limit, server-wide request counters, aggregate decode throughput, and current/peak Metal allocations |

All five include host CPU, memory, and macOS wired/compressed/swap readings when
available. oMLX-reported process and model memory is shown separately when
available. Splash throughput is aggregate across server work; its Metal allocator
values are not process RSS or model-only memory. OpenAI-compatible inference does
not imply equivalent monitoring.
See [Compatibility](docs/COMPATIBILITY.md) for the exact limits.

oMLX already has a monitoring dashboard. MLX Scope keeps the useful readings in
the OpenChamber workflow, in a narrow panel or a full-page view that follows the
host's colors and typography.

- **Live:** current readings, prominent prefill when reported, and host and runtime
  memory with their separate scopes made clear.
- **Compare:** observe 30 or 60 seconds, pin a reference, and compare another
  capture. Inventory-only connections capture host resources.
- **Saved:** keep the 12 newest manually saved observations in OpenChamber storage.
  Saved reports omit model names, request identifiers, paths, and chat content.

The secondary **Share** menu copies a sanitized report or appends it to the current
draft. Nothing is sent automatically.

## Install

Requires **OpenChamber 1.24.2 or newer**, using its desktop or web client. The
runtime must run on the same computer as the OpenChamber server. Mac resource
readings require macOS; extensions are not available in the mobile or VS Code clients.

1. Open **Settings → Extensions** in OpenChamber.
2. Add this repository and review the extension's local-service permissions:

   ```text
   https://github.com/mikebuckets171/mlx-scope-openchamber
   ```

Alternatively, install the latest named `mlx-scope-openchamber-*.zip` from
[Releases](https://github.com/mikebuckets171/mlx-scope-openchamber/releases/latest).
Use the named install package, not GitHub's generated source archives. The ZIP
includes built JavaScript; installing it does not require a build toolchain.

MLX Scope discovers existing local OpenCode provider connections, including custom
provider names. Keep **Automatic**, or use **Change** beside the connection status to select a
connection and runtime. Endpoints and credentials stay in the existing provider
configuration; MLX Scope never edits them. See [Configuration](docs/CONFIGURATION.md)
if no connection appears.

Open the conversation panel from **Open MLX Scope** in the session menu, or use
OpenChamber's **Extension pages** menu for the full-page view.

## What the readings mean

Telemetry is **server-wide**, not attributed to the selected conversation.
Missing values stay unavailable. Held or stale readings are labelled.

oMLX primary DFlash output uses fresh token counters to calculate clearly labelled
**recent output** speed. Before output arrives, it shows processing without
inventing prefill progress. Standard fallback prefill keeps its normal counters
and estimate.

Captures are observations, not controlled benchmarks or proof that a request
finished successfully. Prompts, cache states, and competing workloads can change
a comparison. [Metric definitions](docs/METRICS.md) explain the limits.

## Lightweight and read-only

Vanilla TypeScript, the official OpenChamber SDK, and a host-managed local service.
No UI framework, chart library, inference requests, or separate daemon. One
sampling pipeline per selected connection feeds the views; hidden and paused views
stop requesting observations. Histories, captures, responses, and storage are bounded.

The approved service runs under the OpenChamber user account and reads local
configuration, runtime APIs, and fixed macOS diagnostic commands. Read-only behavior
is a code boundary, not an operating-system sandbox. There is no analytics service.
See [Privacy](PRIVACY.md) and [Security](SECURITY.md).

## Project status

MLX Scope is a focused community-maintained project. Runtime compatibility depends
on supported upstream interfaces and maintainer availability. The MIT license
allows the community to fork and adapt it.

## Development

```sh
bun install --frozen-lockfile
bunx playwright install --with-deps chromium webkit
bun run check:all
```

Checks include an extracted-package startup under Node without `node_modules`
and interaction tests in Chromium and WebKit. Runtime adapters use synthetic
contract fixtures. Splash support follows its pinned 1.0.2 passive status
contract; runtime versions are compatibility anchors, not minimum requirements.
See [Contributing](https://github.com/mikebuckets171/mlx-scope-openchamber/blob/main/CONTRIBUTING.md)
and [Architecture](docs/ARCHITECTURE.md) for builds and sampling limits.

[MIT license](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)

Independent community project; not affiliated with the runtime projects,
OpenChamber, or Apple.

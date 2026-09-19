# MLX Scope

Lightweight oMLX monitoring for OpenChamber.

Prefill remaining, generation speed, context reuse, model activity, and Mac
resources beside your conversation. oMLX already has a monitoring dashboard;
MLX Scope keeps the useful readings in the OpenChamber workflow.

- **Live:** prominent prefill progress and reported stage estimates, generation
  speed, recent observed output, context headroom, and host resources.
- **Compare:** observe 30 or 60 seconds, pin a reference, and compare another
  capture. No prompts are sent and no inference settings are changed.
- **Saved:** keep the 12 newest manually saved observations in OpenChamber storage.
  Saved reports omit model names, request identifiers, paths, and chat content.

Use the narrow conversation panel or open the full-page view from OpenChamber’s
Extension pages menu. Both follow the host’s colors and typography. Sharing stays
in the **Share** menu: copy a sanitized report or append it to the current draft.
Nothing is sent automatically.

## Install

Requires **OpenChamber 1.24.2 or newer**, using its desktop or web client. oMLX
must run on the same computer as the OpenChamber server. Mac resource readings
require macOS; extensions are not available in the mobile or VS Code clients.

1. Open **Settings → Extensions** in OpenChamber.
2. Add this repository and review the extension’s local-service permissions:

   ```text
   https://github.com/mikebuckets171/mlx-scope-openchamber
   ```

Alternatively, install **mlx-scope-openchamber-1.0.0.zip** from
[Releases](https://github.com/mikebuckets171/mlx-scope-openchamber/releases/latest).
Use the named install package, not GitHub’s generated source archives. The ZIP
includes built JavaScript; installing it does not require a build toolchain.

MLX Scope discovers the existing local oMLX connection. If it cannot connect,
open **Connection help** in the monitor or read [Configuration](docs/CONFIGURATION.md).

## What the readings mean

Telemetry is **server-wide**, not attributed to the selected conversation.
Missing values stay unavailable. Held or stale readings are labelled.

DFlash primary output uses fresh, reported output-token counters to calculate
clearly labelled **recent output** speed. Before output arrives, it shows
processing without inventing prefill progress. Standard fallback prefill keeps
its normal counters and estimate. See [Compatibility](docs/COMPATIBILITY.md).

Captures are observations, not controlled benchmarks or proof that a request
finished successfully. Different prompts, cache states, and competing workloads
can change a comparison. [Metric definitions](docs/METRICS.md) explain the limits.

## Lightweight and read-only

Vanilla TypeScript, the official OpenChamber SDK, and a host-managed local
service. No UI framework, chart library, inference requests, or separate daemon.
One sampling pipeline feeds the views; hidden and paused views stop requesting
observations. Histories, captures, responses, and storage are bounded.

The approved service runs under the OpenChamber user account and reads local
configuration, oMLX telemetry, and fixed macOS diagnostic commands. Read-only
behavior is a code boundary, not an operating-system sandbox. There is no
analytics service. See [Privacy](PRIVACY.md) and [Security](SECURITY.md).

## Development

```sh
bun install --frozen-lockfile
bunx playwright install --with-deps chromium webkit
bun run check:all
```

Checks include an extracted-package startup under Node without `node_modules`
and interaction tests in Chromium and WebKit. Synthetic fixtures do not replace
live installation testing. See [Contributing](https://github.com/mikebuckets171/mlx-scope-openchamber/blob/main/CONTRIBUTING.md)
and [Architecture](docs/ARCHITECTURE.md) for builds and sampling limits.

[MIT license](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)

Independent community project; not affiliated with OpenChamber, oMLX, or Apple.

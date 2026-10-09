# MLX Scope 3.0 verification

MLX Scope 3.0.0 builds on public 2.1.6 (`4298c03`) and is available from the [3.0.0 release](https://github.com/mikebuckets171/mlx-scope-openchamber/releases/tag/v3.0.0).

## Automated verification

- 1,725 Bun tests and 38 Node companion tests passed, together with type checking, privacy scanning, reproducible bundles, package allowlists, and extracted-service checks. Existing adapter and Splash prompt-progress fixtures remain covered.
- [Final candidate CI](https://github.com/mikebuckets171/mlx-scope-openchamber/actions/runs/37876339361) and the [release workflow](https://github.com/mikebuckets171/mlx-scope-openchamber/actions/runs/37877632775) passed all 382 Chromium/WebKit browser cases and both macOS/Ubuntu verification jobs. Regressions cover chat switches, lifecycle boundaries, source precedence, stale data, tool waits, cancellations, simultaneous activity, companion absence, and version mismatch.
- Visual verification includes both themes, narrow layouts, keyboard controls, enlarged text, completed results, and cloud estimates. Supplemental checks passed 44 layout cases, 10 failure/copy cases, and 48 scenes with verified applied fonts. The installed OpenChamber 2.2.0 Session sidebar, rail, and full Live/History views were inspected. OpenChamber 2.0.4 compatibility remains.
- The bundled OpenCode 2.0.25 passed isolated local and remote protocol checks for matching, calibration, completed timing, and hidden shutdown. Guided setup preservation, rollback, and removal are covered by tests. Live provider-specific buffering and reasoning visibility can differ from the protocol fixtures.
- Upgrade verification preserved all 14 existing storage entries before normal collection resumed.

## Resource measurements

Service and spawned children measured a maximum active CPU of 1.180%, idle 0.595%, and glance 0.578% of one core; service peak RSS was 80.1 MiB. These satisfy the existing ceilings of 1.9% active, 0.68% idle/glance, and 132 MiB service RSS.

Isolated Chromium renderer main-thread CPU measured 0.072–0.689%. Hidden views made zero snapshot requests, with retained heap change within 0.051 MiB. These measurements exclude aggregate browser/WebView, GPU, and process RSS costs. Companion probes separately measured median incremental CPU of 0.064% idle, 0.960% visible, and 0.088% hidden, with zero hidden chat-telemetry writes. The separately configured Splash prompt-progress observer is outside that probe. Component results are not summed into a total OpenChamber overhead claim.

These measurements cover bounded component and lifecycle checks. They do not establish representative enabled/disabled inference slowdown, long-duration stability, or sleep/wake behavior.

## Published package

The official ZIP and checksum were downloaded and verified after publication. The archive contains exactly 30 allowlisted regular files, each byte-identical to the release tag. Archive safety, file modes, host requirements, entry points, CSP, privacy, executable permissions, and third-party notices passed. The extracted service passed startup without `node_modules`, health/v2, authentication, JSONC, runtime freshness/history, and shutdown checks.

Install `mlx-scope-openchamber-3.0.0.zip`; GitHub-generated source archives are not install packages.

ZIP SHA-256: `657f72794e69fe8e0550ba293413831a4be0cb162776943e2c2d4f1fed093d6a`.

Panel SHA-256: `b469672bff7c17e67d18714852298a1de43f4fc60c43aa56bf3a73b6a70b6b8d`.

Stylesheet SHA-256: `8dd79ce03db2d5cbec92c0d10e29c5da362b0bcfe530247ac3283623c70bbd9b`.

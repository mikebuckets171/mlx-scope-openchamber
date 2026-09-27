# Changelog

## 1.3.0

- Add live LM Studio and LM Studio Bionic activity, including Splash models
  served inside Bionic. The service follows LM Studio's own redacted server log
  (`lms log stream -s server --json`) and reads only request lifecycle lines:
  which model is working, prompt-reading progress, and the completion summary.
- Show generation state and elapsed time while a request runs, and the exact
  tokens per second, time to first token, and token counts LM Studio reports
  when each response finishes. Session average decode speed and cache reuse are
  computed from those completion figures. LM Studio does not report a running
  token count, so no mid-response speed is estimated or invented.
- The log stream runs only while MLX Scope is being read, stops 60 seconds after
  the last read, restarts with backoff if it exits, and is skipped entirely when
  the `lms` CLI is not installed. The manifest now declares `lms`.

## 1.2.1

- Bring Splash model identity, readiness, aggregate decode, and completed/failed
  counters into the first-glance Live view. Keep unavailable request metrics and
  not-ready states explicit.

## 1.2.0

- Add Inco AI Splash using its documented passive `/status` endpoint. Show its
  declared model/context, server-wide completed and failed request counters,
  aggregate decode throughput, and current/peak Metal allocations where reported.
- Keep Splash aggregate throughput separate from request speed, Metal allocation
  separate from process memory, and unavailable request activity, prefill, cache
  reuse, and active-context readings explicit.
- Reuse the shared connection sampler at a 2-second minimum cadence. Splash uses
  only its single `/status` endpoint; no other endpoint, permission, dependency,
  inference, control, or background polling loop is added.

## 1.1.1

- Show an accessible startup fallback if the extension UI bundle cannot load,
  or fails during bootstrap, with a clear instruction to reload the extension in
  OpenChamber.
- Discover local providers in OpenCode 2's `providers.*.settings` format while
  retaining OpenCode 1 configuration support. Honor an absolute
  `OPENCODE_CONFIG_DIR` when it is available to the host service, and do not
  use stale imported `auth.json` keys for native OpenCode 2 provider entries.
- Keep the existing runtime polling, APIs, permissions, and saved data unchanged.

## 1.1.0

- Make reported runtime process footprint and model allocation visible in Live,
  separate from whole-host memory, with stale status and server-wide scope clear.
- Reuse the existing snapshot and polling cadence; no new service calls or
  runtime monitoring loop.

## 1.0.0

First standalone MLX Scope release for OpenChamber, shared as a one-time personal
project. No future updates are planned; community forks and adaptations are
welcome under the MIT license.

- oMLX request telemetry, prominent prefill remaining and stage estimates,
  context/reuse, host resources, and primary DFlash observed output.
- vllm-mlx request/status observations, plus LM Studio and mlx-lm inventory views
  with explicit limits on unavailable telemetry.
- Existing local provider discovery, custom provider IDs, matched credentials,
  connection selection, and actionable setup states.
- Bounded 30/60-second observations, pinned comparisons, and manually saved
  sanitized summaries; inventory connections can observe host resources.
- OpenChamber panel/full-page view, live theme/typography, session shortcut,
  service diagnostics, clipboard, and append-only draft sharing.
- Self-contained install ZIP, extracted-service verification, synthetic runtime
  contract tests, and Chromium/WebKit interaction coverage.

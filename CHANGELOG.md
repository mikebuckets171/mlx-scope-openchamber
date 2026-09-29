# Changelog

## 1.6.1

- MLX Scope no longer starts LM Studio or Bionic. When no LM Studio app is
  running, `lms log stream` launches one unless it is given a server to connect
  to, so quitting Bionic while Scope watched it could relaunch it through the
  log-stream restart. Scope now starts `lms` only after that LM Studio has just
  answered, and only when the running app has recorded its port. It passes that
  port explicitly (`--port`, plus `LMS_API_SERVER_INFO_PATH`), so `lms` connects
  instead of launching. The stream is not restarted after LM Studio stops
  answering, and Scope gives up after repeated failed connections until it is
  reopened.
- LM Studio activity now belongs only to the connection on the LM Studio home's
  own REST port (for example 1234). A second LM Studio-family server, such as an
  SSH tunnel, no longer starts the log stream or shows its activity. The LM Studio
  home is resolved the way `lms` resolves it (`~/.lmstudio-home-pointer` first).
- LM Studio versions that answer an unknown route with HTTP 200 and an
  "Unexpected endpoint" error body now fall back to the `/api/v0` inventory, as
  they already did for a 404.

## 1.6.0

- Rewrote the stylesheet as a single system (570 layered lines → 424): one set
  of color tokens derived from the host theme, one type scale and one card
  shape. Dropped rules for classes that no longer exist.
- Live: the model, headline reading, 90-second trend and context budget sit
  together in one hero card tinted by phase (generating, reading context,
  waiting/stale, paused).
- The throughput trend is full width again with its scale, time axis and a
  filled area. The 1.5 inline sparkline squeezed the 90-second window into
  260 px, so a young trace showed up as a stray dash.
- Output, Elapsed, Input reused and Requests are tiles with their detail lines
  restored. Placeholder dashes are muted so they don't read as values.
- The host card shows CPU and RAM meters without having to open Mac details.
- Full page: the reading is on the left and the host card is pinned on the
  right. The Server tab is a packed two-column card grid, and Saved uses a
  two-column list.
- Tabs are a segmented control. Diagnosis callouts no longer repeat their
  message inside the hero card, and the retained-reading notice is a quiet
  line instead of a second callout.
- Model catalogue rows keep name/state and badge/context on two lines at
  narrow widths instead of stacking into four.

## 1.5.0

- Redesigned layout. Live now shows one reading at a time: a header with a
  single status pill (phase first, then the connection), the model and its
  generation speed with an inline sparkline (or prompt-reading progress), a
  context-used bar, and one row of Output, Elapsed, Input reused and Requests.
  CPU, RAM and swap sit on one line; "Mac details" expands the full host view.
- New Server tab for server-wide readings: runtime memory, cache and input,
  loaded models, the runtime advisory, server session totals and runtime
  details. Each fact appears in one place instead of being repeated.
- Refresh, Compact, Efficiency, Save snapshot, Share and Change connection
  moved into a "More options" (⋯) menu. Toggles show a checkmark, the menu is
  opaque on translucent themes, and it closes after an action, on Escape or on
  an outside click, with keyboard focus returned to the ⋯ button.
- Compact mode is now the header and the hero reading only.
- Save snapshot is available from the Server tab as well as Live.
- Narrow panels (320 px and up): the status pill moves to its own row and the
  stat row becomes two columns.

## 1.4.0

- Splash in Bionic is now named and shown as "Splash via Bionic" instead of
  "LM Studio". Splash-format models from Bionic's API are recognised, badged
  "Splash", and listed with the loaded model first. Leave the connection on
  Automatic; no extra setup is needed.
- Stop showing what a runtime doesn't report. The "Not reported" metric cells,
  empty cache and chart panels, "— queued · — allocated" rows, and "limited
  telemetry" labels are gone; unreported readings are left out of the Live view,
  Copy stats, and Saved observations.
- Bionic and LM Studio views now show context use and input reuse from the last
  finished response's exact token counts.
- Standalone Splash (`splash serve`) shows Idle, Generating with in-flight
  requests, or Loading instead of a fixed "Ready"/"Not ready", and is detected
  automatically from its `/status` endpoint. A loading server is no longer
  reported as offline. Compare now records its GPU (Metal) memory and finished
  requests.
- Provider names that mention Bionic or LM Studio stay on that path even when
  they also mention Splash; other Splash-named providers use the standalone
  adapter.

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

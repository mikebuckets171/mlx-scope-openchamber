# Changelog

## 2.1.1

### Fixed

- Splash 1.2: a finished reply's first-token time is shown again. Splash 1.2 (status schema 6) renamed the HTTP
  first-token histogram `latency.ttft` to `latency.http_ttft`; Scope now reads either, so 1.0.2 and 1.1 are unchanged.
- Splash 1.2: a `/status` body with schema 6 is detected at high confidence again, as schema 5 is for 1.0.2 and 1.1.
  An unqualified schema still matches at medium.
- Splash 1.2.0 is added to the compatibility table, with a fixture set captured from a local server and scrubbed.

## 2.1.0

### Added

- Live tok/s for standalone Splish and Splash in the main view and Session widget, derived from fresh native decode
  counter changes. The reading is labeled server-wide and clears when idle or stale; lifetime averages remain separate.
  Monitoring still uses only passive `/status` reads at the existing cadence.

### Changed

- A quieter layout across the full page and rail, with clearer typography, grouped readings, fewer card borders,
  and recent replies above the trend. The page starts with four history entries; Show more reveals the rest, and
  History insights opens baselines, usage and the alert log. Storage notices remain visible when action is needed.
- The Session pane's MLX Scope widget separates status from the model name and gives alerts a compact, divided row.
  Its existing expandable statistics remain available.
- Charts, controls and surfaces follow OpenChamber's current theme, including changes between two themes of the
  same mode. Missing tokens in older theme snapshots fall back cleanly instead of retaining the previous palette.

### Maintenance

- Shared markup keeps the view bundle near its previous size. Its ceiling increases from 260 KB to 264 KB for the
  layout, theme handling and live server-rate display; runtime probes, dependencies, permissions and polling frequency are unchanged.

## 2.0.1

### Fixed

- `/scope` no longer starts LM Studio's log stream (an `lms` process of about 119 MB that ran for a minute after each
  use); it reads the connection once, as documented, and still shows live requests while the panel or Work Status is
  watching.
- **History shows a paused recording correctly** on the page's History column and in Scope views that aren't
  recording. They used to say "Stored on this Mac" and offer Pause, so resuming took two clicks.
- **Badge after closing the page.** When you close the page while the rail panel is open, the panel now clears the
  rail badge the page set, so the icon no longer shows an alert count the panel doesn't show.
- **Last reply after a hidden panel.** A panel shown again after more than 64 replies finished out of view now pages
  through them to the newest reply, instead of staying on an older reply's speed and TTFT until the next reply
  finishes.
- **History:** the oMLX usage card now appears when you pick Automatic with the oMLX runtime and another connection
  is listed first; before, the card stayed hidden even though the snapshot said usage was available.
- **LM Studio Engines card no longer flickers.** While a reply was generating and Work Status was open, the Server
  tab's Engines card could vanish for a poll about every 10 s. Readings now keep the last `lms runtime ls` rows, with
  no extra lms run.

### Maintenance

- The overhead measurement (`bun run overhead`) works on 2.0 again: its stand-in `lms` answers `ps` and `runtime ls`
  at once, and its polls are shaped like the panel's and Work Status's.

## 2.0.0

MLX Scope 2.0 follows OpenChamber 2 into the chat: a Work Status section that can replace Turn stats, per-chat labels,
a local reply history with baselines, alerts while you watch, two more runtimes, deeper Mac readings and `/scope`.

### Breaking

- **OpenChamber 2.0.4 or newer is required** (`engines.openchamber` `>=2.0.4`, SDK 2.0.4). OpenChamber refuses the
  install on an older host as too old. OpenChamber 1.24.x–2.0.3 users stay on the 1.6 line:
  `https://github.com/mikebuckets171/mlx-scope-openchamber#legacy/1.6.x`, which takes security and correctness fixes only.
- **One new approval.** The local service now declares ten absolute commands (`/usr/bin/vm_stat`, `/usr/sbin/sysctl`,
  `/usr/sbin/ioreg`, `/usr/bin/notifyutil`, `/usr/sbin/lsof`, `/usr/bin/footprint`, `~/.lmstudio/bin/lms`,
  `~/.cache/lm-studio/bin/lms`, `/opt/homebrew/bin/macmon`, `/usr/local/bin/macmon`) instead of 1.6's two plus a bare
  `lms`. No capability is requested. The list does not change within 2.0.x.
- **Wire contract v2.** The service answers `/v2/snapshot`, `/v2/trend` and `/v2/usage`; the 1.x `/snapshot` route
  answers `410 contract_mismatch`. A 1.6 panel and a 2.0 service (or the reverse) say so instead of misreading each
  other.
- **Tabs.** Live, Server, History and Captures. Compare and Saved become Captures, and monitoring keeps running while a
  capture records. Compact mode is the Work Status glance view (≤160 px) instead of 1.6's compact panel.
- **Units.** Memory travels as integer bytes and is shown in GiB (1,024³ bytes) everywhere; 1.6 saved observations,
  which stored GiB, are converted exactly when copied into Captures.

### Added

- **Work Status section** with a glance line (phase, model, speed, per-chat label, 15-minute sparkline, pressure, GPU
  and thermal chips, top alert) and an expanded Turn stats replacement with runtime-exact rows. A one-time tip explains
  how to hide Turn stats and put MLX Scope in its place.
- **Per-chat labels:** "This chat · inferred" only when a reply provably belongs to the open chat, otherwise
  server-wide with one reason; **Next reply · armed** captures; turn summaries for fully attributed turns.
- **Local reply history** in OpenChamber extension storage: 30 days by default (90 at most), Pause, Clear, a usage bar,
  "vs usual" baselines with sample counts, a "Slower than usual" flag, Copy baseline summary, and a 15/30/60-minute
  History chart with unobserved stretches hatched.
- **Alerts** while a Scope view is visible: runtime lost, model unloaded, memory pressure, swap growth, thermal
  pressure, Splash recovering, oMLX prefill stall and memory guard, and "Slower than usual"; a rail badge and toasts
  (critical-only by default) from one view at a time; an alert log.
- **Runtimes:** llama.cpp `llama-server` (slots, sleep-aware; rates and speculative decoding with `--metrics`) and
  Ollama (residency). Splash 1.1 (recovering and stale states, vision chips, native first-token and inter-token
  p50/p95), oMLX 0.7 (a usage card "Recorded by oMLX", the engine ceiling, a read-only fallback for sub keys), and
  Bionic/LM Studio loaded instances and an Engines card.
- **Mac readings:** kernel memory pressure, the GPU wired-memory limit, driver-reported GPU busy and memory, thermal
  pressure, the oMLX process footprint, and an optional macmon chip-power estimate with tokens per joule.
- **`/scope`:** attaches an "MLX Scope diagnostics" chip with a sanitized summary for the chat's model. Its first line
  says the summary goes to this chat's model, which may be a cloud provider.
- A two-column full page (Live and History).

### Changed

- Detection re-runs when a runtime changes on the same port, and optional endpoints degrade one reading instead of the
  whole runtime.
- Hidden views make no requests at all, including rail tabs that OpenChamber 2 keeps mounted behind another tab.
- One visible view at a time writes history and raises toasts; the service writes no files and never schedules
  repeating work.
- oMLX no longer calls `/admin/api/stats`.

### Upgrading

1. Update MLX Scope in Settings → Extensions (git installs are offered **Update**; ZIP users install the new ZIP).
2. Approve the new permission set. Until then Scope explains what it needs instead of showing readings.
3. If a view says the service is still the previous version, pause MLX Scope and resume it in Settings → Extensions.
4. Your view preferences, selected connection and 1.6 saved observations carry over. The 1.6 observations are copied
   into Captures and the originals are kept through 2.0.x, so a rollback to 1.6 still shows them.
5. Optional: to replace Turn stats, hide it in the Work Status panel's **Panel sections** and drag MLX Scope into its
   place.
6. Something wrong? `docs/2.0/ROLLBACK.md` describes fixes (2.0.x) and the legacy pin.

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

Not released separately; these changes shipped in 1.2.1.

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

Not released separately; these changes shipped in 1.2.1.

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

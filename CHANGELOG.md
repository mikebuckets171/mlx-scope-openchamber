# Changelog

## 5.3.0

- **Chat speed works on OpenChamber 2.5.3 and keeps working across OpenCode updates.** OpenChamber 2.5.3 bundles
  OpenCode 2.2.0 and runs nothing older, which turned chat speed and Splash prompt progress off. Companion **3.6.0**
  accepts every OpenCode 2 release from 2.0.25 instead of named release lines, so a new minor release (2.3, 2.4…) needs
  no Scope update: the companion's running checks still pause only a feature whose hook or event shape changes and name
  the reason in Connections. OpenCode 2.2.0 is qualified natively. OpenCode 3 stays off until reviewed.
- **No more Update chat speed after a Scope update.** When Scope installed the helper and its files are unedited, the
  service brings it up to date once when it starts, by the same file replacement the button performs: OpenCode reloads
  it without a restart, and only the helper's own `scopeRevision` changes in OpenCode's configuration. A disabled,
  manual or edited installation is left alone, and the button stays for those. Connections says **Updated
  automatically** until OpenCode loads it.
- **Models by their OpenCode names.** Live, History, Run details, the server cards and alerts show the name each
  provider's OpenCode `models` entry gives a model, as OpenCode's model picker does: `Qwen3.8-Flash-Next` instead of
  `ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF`. New or renamed models need nothing in Scope. Runtime IDs stay the
  identity for attribution, baselines and stored history.
- **Splash prompt percentages behind llama-swap.** Match the companion's request model to the exact ready route
  reported by llama-swap, even when Splash's native model name includes a quantization tag. Overlap, ambiguity and
  freshness safeguards are unchanged. No additional HTTP requests are needed.
- Permissions are unchanged; the update needs no new approval. Requires OpenChamber 2.4.0 or later and pins SDK 2.5.0.

While llama-swap 268's new **Pause** is on, Scope shows its backend as idle: llama-swap reports that state only through
endpoints Scope does not call.

Before publication on macOS, type checking, the privacy scan, the Bun, companion and helper tests, reproducible bundles
and package verification passed. Against the OpenCode 2.2.0 binary bundled with OpenChamber 2.5.3, with synthetic
loopback providers, companion 3.6.0 passed local HTTP with advancing prompt progress, synthetic-remote HTTP, WebSocket
reuse on one connection with six tool continuations and cancellation, a compaction that published no chat measurement
followed by a measured resumed step, and managed hot reload from the installed 3.5.0 helper with no server restart and
no duplicated request. No real model, inference or cloud account was involved.
[Receipt](https://github.com/mikebuckets171/mlx-scope-openchamber/blob/main/docs/receipts/companion-3.6.0.json).

## 5.2.0

- **A quieter monitor.** Measurement details is the single hub for engine readings, request details, the last reply,
  a compact server strip and Run details. Server diagnostics are read only while that hub is open. History keeps its
  trend, alerts and a quiet usual-speed median instead of another stat dashboard.
- **One compact presentation.** Compact and the Session sidebar share the same status widget. Compact keeps Watch
  and Expand; Pause stays in the masthead. Watch is now **Automatic** or **Engine**; saved Chat choices become Automatic.
  Automatic never substitutes local engine numbers for a cloud chat.
- **Chip power only when useful.** Optional macmon runs while a local engine is generating and a visible Measurement
  details hub asks for it. Multiple readers share the stream without cancelling each other. Freshness and energy-coverage
  checks still apply; power is a whole-chip estimate, not wall power or a chat's electricity use.
- **Less surrounding noise.** Other work is an opt-in menu toggle and one counts-only line, not a list of chat titles.
  Media supports ComfyUI and Draw Things. Retired Phosphene, local-video, Qwen-image and generic-file integrations are
  removed; Scope does not delete their files or stored history.
- **Ready for contributors.** Onboarding is rewritten, historical plans and receipts are archived, and retired v1
  parsing/conversion lives only in frozen test fixtures. Runtime imports of that support are rejected by a regression check.

Permissions, storage limits and observer-only behavior are unchanged. Requires OpenChamber 2.4.0 or later and pins SDK
2.5.0. Update a Git install with **Check for updates** to keep History; replacing an installation with a ZIP can delete it.

Verification and its limits are recorded in the
[5.2.0 receipt](https://github.com/mikebuckets171/mlx-scope-openchamber/blob/main/docs/receipts/5.2.0-verification.md).

## 5.1.2

- **Chat speed works on OpenCode 2.1.** OpenCode 2.1.1 keeps every part of the contract the companion reads, and the local build `2.1.1-compaction.1` passed the native checks against its own binary with synthetic providers. Later 2.1 releases from 2.1.1 are **self-checked** the way later 2.0 releases are: the companion confirms each hook and event shape and pauses only the feature whose check fails, naming the reason in Connections. 2.1.0, 2.2 and later stay off until qualified. A locally built runtime is accepted only by reviewed identifier, so `2.1.1-compaction.1` works and an unreviewed suffix does not. Choose **Connections → Update chat speed** once to load companion 3.5.0; later OpenCode 2.0 and 2.1 updates need no Scope action.
- Permissions are unchanged; the update needs no new approval.
- **Built against SDK 2.5.** The extension's SDK pin moved from 2.4.0 to 2.5.0; the OpenChamber floor stays 2.4.0, so nothing changes for users on older hosts.

Before publication on macOS: type checking, the privacy scan (673 files), 1,855 Bun tests, 81 companion tests, 15 helper
tests, reproducible bundles and package verification passed (36 packaged assets). Against an isolated
`2.1.1-compaction.1` process with synthetic loopback providers, companion 3.5.0 passed local HTTP delivery with
advancing prompt progress, synthetic-remote HTTP, WebSocket reuse on one connection with six tool continuations and
cancellation, managed hot reload from the installed 3.4.0 helper with no server restart and no duplicated request, and
a new compaction check: the auxiliary compaction request published no chat measurement, the checkpoint carried
`metadata.keepID`, `session.context` materialized `metadata.recent`, and the resumed step completed on reported output.
No real model, inference or cloud account was involved.
[Receipt](https://github.com/mikebuckets171/mlx-scope-openchamber/blob/main/docs/archive/receipts/companion-3.5.0.json).
All 628 Chromium and WebKit browser cases passed locally. Goldens and the 5.1.0 overhead fixture were not re-run: the
panel's rendered output is unchanged, and the CPU fixture measured work this release does not change. The first run of
the new compaction check failed at the resumed step because the harness let its own demand file expire, not because of
OpenCode 2.1; the check now renews demand while it waits.

## 5.1.1

- **Draw Things in Media.** Renders from Draw Things' command-line tool (`draw-things-cli`) appear with their phase (preparing, sampling with its step count, finishing) and how long they have run, then completed or ended before finishing. No setup: Scope finds a running render with the `lsof` it may already run and reads the end of the file the render writes its progress to, as render scripts redirect it. Observe-only; prompts, settings, paths and outputs are never kept. Draw Things reports no time left, so Scope shows none. Renders inside the Draw Things app are not visible: its servers report progress only to the client that started the render.
- Permissions are unchanged; the update needs no new approval.

Before publication on macOS: type checking, the privacy scan, 1,854 Bun tests, 79 companion tests, 15 helper tests, reproducible bundles and package verification passed, as did all 628 Chromium and WebKit browser cases and the 21 presentation goldens. The adapter's tests use the tool's own output from finished renders (paths replaced). A render running on this Mac was read live through the adapter: sampling, step 16 of 25, with its start time, read correctly; the full Media view in OpenChamber was not checked. Each `lsof` look costs about 56 ms of CPU, so while a view showing Media is open Scope looks once a minute when no render runs (about 0.09 % of one core) and every 15 s while one does. The service overhead receipt from 5.1.0 still describes everything outside media; it was not re-run.

## 5.1.0

- **Chat speed and Splash prompt progress work on OpenChamber 2.4 and keep working across OpenCode patches.** OpenCode 2.0.32 (bundled with OpenChamber 2.4.0) is qualified natively. Later 2.0 releases are **self-checked**: the companion confirms every hook and event shape it relies on and pauses only the feature whose check fails, naming the reason in Connections. 2.1 and later stay off until qualified. Choose **Connections → Update chat speed** once to load companion 3.4.0; later OpenCode 2.0 updates need no Scope action.
- **Two label layers.** Every reading says **This chat** or **Engine**. Estimates read `≈ 24.1`; finished replies read **Last reply** or **Last reply · Engine**. How a value was measured stays in its details and Run details.
- **A quieter Session section.** The phase, one reading and, while the prompt is read, its time-left estimate. At most two rows appear only when something happens. **Watch** and **Pause** move into OpenChamber's own section header (SDK 2.4 `setStatusControls`), with the in-section row kept for hosts without it. The trace and supporting-fact rows are gone from the section.
- Native disclosures keep the reader's open or closed choice even when a live update arrives before the browser's queued toggle event.
- **Slower than usual, with what was going on.** The flag now reaches the Session section and Live, not only History, and lists what was observed during those replies, including requests queued and a media job running (kept in memory, never stored). Standalone Splash replies carry token counts, so they build baselines for the first time.
- **Prompt cache miss.** When a chat's mostly reused prompt is followed by one that is mostly read again, Session and Live say so with Splash's own counts. Scope does not guess the cause.
- **Phosphene in Media.** Phosphene renders show their phase, step counters (per H3 window) and Phosphene's own estimate, labelled **app estimate**. Observe-only; prompts, parameters, paths and logs are never kept.
- **Lighter.** Active polling every 1 s instead of 500 ms; the service exits after ten minutes without a view and is started again on demand; the companion's demand watcher backs off when nothing asks for chat telemetry; the shipped JavaScript shrinks from 558 KB to 512 KB.
- **Removed:** Captures, Measure next reply, agent command output (the `shells` permission) and the `/scope` command with its background page. Their stored data is left untouched, counted under **History → Storage → Kept from earlier versions**, and still visible if you roll back. **Label replies to this chat automatically** moves to History → Storage.
- **Install from Git to keep your history.** Installing a ZIP over an existing Scope makes OpenChamber delete the extension's storage. The `release` branch (`https://github.com/mikebuckets171/mlx-scope-openchamber#release`) carries exactly each published package and updates in place with **Check for updates**. Moving from a ZIP install: back up `~/.config/openchamber/guest-storage/mlx-scope.json` first; see the README.
- Requires OpenChamber 2.4.0 and pins SDK 2.4.0. Keep 5.0.0 on OpenChamber 2.3.x. The update asks for approval once because the permissions shrink: `sessions` only. Executable permissions are unchanged.

Before publication, on macOS with an Apple M5 Pro, `bun run check:all` passed: type checking, the privacy scan, 1,848 Bun tests, 79 companion tests, 15 helper tests, reproducible bundles and package verification, and all 628 Chromium and WebKit browser cases. The presentation goldens were regenerated and reviewed. Release CI exposed a native-disclosure race, fixed with a same-task regression test; startup layout checks now wait for the first trend before clicking controls it moves, and the Splash label check advances a controlled clock past its observation window.

With synthetic runtimes, the service overhead run passed every existing budget, plus a new check that the service exits on its own, with code 0, after its idle delay (checked at 5 s). The default run's CPU readings were below the stored same-machine 5.0 baseline. A separate back-to-back comparison with 5.0.0 showed lower active and glance CPU with half the requests while generating and unchanged helper spawn rates; oMLX idle CPU was higher (0.518% against 0.451% of one core), still below the 0.68% budget. Peak memory with the synthetic oMLX runtime read about 10 MiB higher (72–79 MiB against 58–65; LM Studio 73–76 against 72–76), within the 132 MiB budget. Renderer CPU was not measured. These runs do not show the effect on real inference, the graphics processor or the complete OpenChamber app. [Receipt](https://github.com/mikebuckets171/mlx-scope-openchamber/blob/main/docs/archive/receipts/overhead-5.1.0.json).

5.1.0 was not installed in OpenChamber before publication, so the permission prompt, the header controls, **Update chat speed** and an ordinary Splash reply have not been observed on a real host. Companion 3.4.0 passed the native checks against OpenCode 2.0.32's own binary with synthetic providers. A real Hailuo H3 render on Phosphene 4.19.5 was observed read-only through the 5.1 service outside OpenChamber: its phases, step counts and Phosphene's own estimate came through, and the finish-time drift it revealed is fixed in this release.

## 5.0.0

- Prompt reading shows a qualified time-left estimate in Session and Live. Engines that omit one use a bounded window of fresh token progress; stale, overlapping, paused, or interrupted readings withdraw it.

- Refine Session, rail and full page with one standard design for everyone. Keep the measurement basis beside the primary value, fit traces to the interval actually observed, and align Mac readings in a compact band. Keep Session scope, pause and details controls in one readable row; show a short trace only when connected observations exist. Snapshot-only measurement popovers explain readings where supported. Narrow views and enlarged text stack naturally.
- Require OpenChamber 2.3.3 and pin SDK 2.3.3. Keep 4.0.1 for older hosts. The unchanged `/scope` background entry uses the isolated official 2.0.4 SDK to retain its 25 KB ceiling.
- Request sessions and shells with explicit update reapproval. Chats/subagents and agent commands start disabled. Subscriptions are visibility-driven, and click-only command output is transient, bounded to 8 KiB and excluded from all saved readings and diagnostics.
- Preserve the measurement pipeline, storage schemas, existing observations and qualified comparisons. Earlier design preferences no longer choose a separate appearance; monitoring data remains intact.
- Intern repeated guest strings at build time without renaming protocol properties or adding runtime decoding. Bundle ceilings and service budgets remain unchanged.

Fixture checks do not establish every real-host behavior; release verification records those checks separately.

## 4.0.2 (local)

- Qualifies exact OpenCode 2.0.29 for the existing HTTP, WebSocket, prompt-progress and managed-reload integrations. The companion remains 3.3.0 and preserves the existing wire/schema and older qualified profiles. Scope 5 carries this installed update forward.
- Its qualification used the OpenChamber 2.3.3 bundled binary with isolated native synthetic providers, including local/remote HTTP, WebSocket reuse/tool continuation/cancellation and helper hot reload. No real inference or throughput benchmark was run.

## 4.0.1

- Adds one exact 2.0.28 profile while preserving qualified 2.0.25/2.0.27, companion 3.3.0 and the existing wire/schema. The extension service and bundled helper share the registry.
- Native synthetic loopback checks cover local/remote HTTP, Splash progress, WebSocket reuse and tools, calibration, completion, cancellation, hidden shutdown, and helper reload without restart or duplicated requests.
- Restores chat speed and Splash prompt progress after updating to OpenChamber 2.3.2. Install the extension, then choose **Connections → Update chat speed** to update the companion files. The companion remains version 3.3.0; exact OpenCode 2.0.25 and 2.0.27 support is retained.
- Native fixture checks do not establish every provider, model or real-workload performance.

## 4.0.0

- Readings, labels and controls now look and behave alike across Live, Session, Media, Connections, History and Captures. Sections take up only the space their contents need, including at larger text sizes.
- Run details opens from Live and saved History. It shows only what was recorded, explains how each reading was measured and notes what is missing. It adds no background checks.
- The extension handles OpenChamber updates in one place. If an optional OpenCode connection method is unavailable, other monitoring can continue. The compatibility check reports what is known without starting OpenCode or treating an untested version as supported.
- Newer saved History, preferences and Captures are left unchanged rather than overwritten. Existing readings and permissions continue to work.
- The panel remains within its size limit without removing features. The behavior tests and package checks pass, but the performance goals have not all been met.
- Chat delivery and Splash prompt progress also support exact OpenCode 2.0.27. Native checks with isolated local fixtures verify HTTP and WebSocket delivery, calibration, completion, prompt counters, cancellation, and helper updates without restarting the server. An older helper that reports the runtime unsupported can now be updated through Connections.

To keep chat speed reports working, choose **Connections → Update chat speed** and confirm that version 3.3.0 is loaded. Existing History and Captures are unchanged. Exact OpenCode 2.0.25 and 2.0.27 are qualified; other versions do not inherit support. Native fixture checks do not establish every provider, model or real workload.

In an earlier browser test, the page used 2.3165% of one processor core for version 4.0, compared with 1.8596% for version 3.1—about a quarter more. Three new paired samples had a 2.1246% median for 4.0 versus 1.7120% for 3.1. Both missed the 1.62–1.70% target; neither result was replaced or its limit raised. The final-bundle service overhead run passed all existing limits with synthetic runtimes: active CPU at most 1.067% of one core, idle/glance at most 0.475%, and service RSS at most 75 MiB. These tests do not show the effect on real inference, the graphics processor or the complete OpenChamber app.

An initial 4.0.0 candidate was installed through the real OpenChamber 2.3.0 UI on macOS, replacing an earlier version. The extension loaded, its service restarted on 4.0.0, Live, Run details and Connections navigated, and the Session panel showed activity from a loaded local model behind llama-swap. This initial install did not submit a model reply; live llama-swap prompt percentage remains a separate check. Qualification of 2.0.27 was subsequently performed against its real binary with synthetic providers, not a paid cloud account or real model.

The revised ZIP was then reinstalled through Settings → Extensions. Its installed production bundles match the tested source. The live helper loaded 3.3.0 on OpenCode 2.0.27; configuration comparison confirmed only Scope's revision changed. History navigation was checked in the real browser client. Read-only observation of existing local work captured advancing llama-swap prompt counters, but did not prove the selected chat's rendered percentage or pre-upgrade saved-data preservation. All 520 Chromium/WebKit browser cases passed; fixture storage tests cover preservation separately.

A second final-bundle service overhead run also passed all limits: active CPU ≤0.971%, idle/glance ≤0.440%, service RSS ≤57.8 MiB, with the same synthetic-runtime limitations.

## 3.2.3

- The Session sidebar no longer leaves a blank block at rest. With a local engine idle, it shows the engine's overall average speed (dimmed and labelled **Engine · overall avg.**, never live) and what the engine holds, such as model or GPU memory and its typical first-token time, so the section keeps the same height when a reply starts. With nothing true to show — a cloud chat at rest, no model loaded, or paused — the empty rows fold away. During a reply the layout is unchanged.

## 3.2.2

- llama-swap: a provider that points at llama-swap is now read through it. Scope follows the model llama-swap reports as ready and reads that model's own server, named for example **Splash via llama-swap**; a starting model shows **Loading** and an unloaded one **No model loaded**. Scope only reads llama-swap's `/running` list, never asks it to load or swap a model, and never sends the provider's key to the model server. A swapped model starts a new engine generation. Previously such a connection showed as an unsupported server with no engine readings.

## 3.2.1

- Media: when a Qwen image job is correlated with a ComfyUI prompt that is already running while the image job still reports an earlier state, the job now shows ComfyUI's current lifecycle, phase and progress instead of the stale state. A finished or cancelling image job keeps its own state. The chat companion is unchanged (3.2.0).

## 3.2.0

- Restores cloud chat speed: the companion observes cloud delivery through the native OpenCode transport (qualified WebSocket handshake on OpenCode 2.0.25) and the panel presents it as **Cloud · est.** — network and provider buffering included; never the engine's native throughput, and never borrowed from or into local engine readings.
- OpenCode SDK 2.0.4 floor: unsupported or future runtime generations disable cloud estimates with a one-line reason instead of deferring the whole feature.
- A cloud step interrupted before completion yields no completed-step average; the gap is documented in COMPATIBILITY.md and covered by bridge unit tests.
- Protocol smokes stage their isolated companion outside `node_modules` and canonicalize the temporary base, fixing silent plugin-loading and symlink refusals that left both smokes unusable; the WebSocket smoke now passes end-to-end against the real runtime binary.
- One column of truth: the page reads This chat and its engine, then Media only while it has jobs; History, Captures and Server & Mac details are secondary views reached from the column's foot, each with Back. The Live/Media/History tabs are gone.
- The instrument never goes dark: while a prompt is read without reported progress or rate, or a reply waits for its first output, the hero holds this reply's elapsed time (the engine's own request clock when reported, otherwise the observed turn start). The previous completed average stays below a live local reading, dimmed and labelled. Nothing is simulated.
- Truth-locked motion: blocks fade in once on arrival, the mark beats once per fresh measurement (keyed to the reading's own sample time), changed phases and labels crossfade, and a reading that stops being live fades to its held colour. Nothing loops; hidden or paused views and Reduce Motion animate nothing.
- Media rings no longer display a number; the phase percentage is text beside the ring. Rings draw in on arrival, ease between reported values, drain on cancellation and never spin; indeterminate work shows a still, dotted track.
- Media jobs can show a finish time as clock time ("finishes around H:MM", "finishes any moment"), measured from at least two producer-timestamped reports of the current phase and only when the source declares that phase final (feed producers via `finalPhase`); it is held as "last estimate" when stale and becomes "finished H:MM" at completion. ComfyUI, Qwen image and local video declare no final phase, so they show no estimate rather than a guess.
- A reply whose step announcement is lost while tracking starts (demand arriving as the reply begins) is still observed: the qualified dispatch seeds the observation of its own call, never of an earlier or later one, and without the announcement it reports no completed-step average and trains no calibration.
- Guided updates replace each changed companion file by rename in place, the change OpenCode 2.0.25 reloads on; unchanged files are untouched. Setup offers the update whenever the installed files differ from the bundle, even at the same package version, and finishes an interrupted update instead of reporting it as a user edit.
- The companion reports once in the OpenCode log when it ignores a demand file that is not private to the account, instead of looking exactly like no demand.
- Chat locality follows the provider's declared loopback endpoint, including key-free providers and providers beyond the eight-entry connection list.
- Local engine measurements, history records, captures and media monitoring keep their data and measurement semantics; only their presentation changed.

### Also new since 3.0.0 (the 3.1 candidate was not released separately)

- Unified Connections explains detected sources and provides managed chat/media tracking setup with explicit readiness.
- Optional Media monitoring shows current-chat jobs first, phase-local measured progress, waiting states, freshness and exact supported cancellation.
- Circular media indicators show measured phase percentages, retain a clearly labelled last report when telemetry ages, and stop motion on stale or hidden views.
- ComfyUI supports basic lifecycle monitoring and an optional passive progress helper; local-video, Qwen image and private telemetry feeds have separate adapters.
- Primary live numbers use short changed-digit transitions with stable layout, fresh-data gating and Reduce Motion support.
- Existing LLM measurements, history and captures remain compatible.
- Chat setup distinguishes an outdated helper from a loaded update. Cancellation and lifecycle boundaries discard unused transport proof before another reply can inherit it.

## 3.0.0

- A fresh activity-first interface keeps one relevant measurement in a stable position, with Open MLX Scope in the sidebar.
  The sidebar adds an available supporting fact and uses OpenChamber's model context instead of repeating it.
  Full Live shows available Engine facts and a compatible Engine trend, with deeper measurements in a disclosure.
  Completed facts belong to the exact result; one labeled chat average can remain in view memory until the next reply.
- A saved This chat / Whole engine preference keeps scope explicit. Chat-matched runtime readings take precedence, then
  labeled delivery estimates, then a labeled Engine fallback for local chats. Cloud chats can show estimated delivery
  through the same optional companion, with no cloud API calls or local engine fallback.
- Phase-aware readings distinguish prompt progress, generation/reasoning, tool waits, cancellation and Last results.
  Chat/model switches and expired observations clear live rates immediately.
- An optional OpenCode 2.0.25 companion estimates delivery over a five-second window after two seconds of observations,
  with bounded calibration from comparable completed steps. Estimates always remain labeled.
- Guided Enable/Disable preserves JSONC comments and existing plugins, verifies compatibility/readiness, and never
  restarts an active session. Chat delivery telemetry is demand-gated; the existing optional Splash prompt-progress
  observer remains separately configured.
- Full Live and History retain charts, captures, comparisons and optional Mac diagnostics. Existing records and runtime
  measurement bases are preserved; chat estimates do not enter engine charts or baselines.
- Runtime adapters, Splash prompt progress, host permission declarations and OpenChamber 2.0.4 compatibility remain.


## 2.1.6

- Long activity explanations now wrap within narrow panels, keeping their help button inside the panel in WebKit.

### Added

- Real standalone Splash prompt progress through an optional OpenCode companion bundled with the update. The
  percentage uses Splash's processed/total prompt counts, includes cached tokens, and clears when the reply starts
  or a fresh single request cannot be established. Existing oMLX progress remains supported.

### Changed

- The Session sidebar follows OpenChamber's Turn stats layout, with simple label/value rows for prompt progress,
  prefill speed and generation speed. The model, warnings and **Open MLX Scope** action stay compact.
  Labels and help text across Scope use plain language. Measurement explanations remain in the full view and tooltips.
- Standalone Splish/Splash now shows recent prefill and generation speeds separately. Each uses its own fresh
  observations and native command time; neither falls back to an old batch speed or an average since engine start.
- Live, compact views and copied diagnostics keep the two stages and their observation intervals separate.
  Lifetime averages remain available in Server & Mac details. Existing oMLX progress and speed support is preserved.

### Fixed

- Speeds clear when monitoring pauses or readings become stale, unavailable or interrupted. Resuming waits for
  fresh observations. Recovery and setup messages take priority over retained activity.

The update preserves saved history, preferences, permissions and the existing passive monitoring cadence.

## 2.1.4 (local)

### Fixed

- Splish/Splash's primary reading is **Recent engine speed**, computed across a rolling window of up to five
  seconds with at least three samples spanning two seconds. Live, Session, Compact and Server details name the
  server-wide scope and actual observed interval; the divisor remains native decode-command time.
- Missing, idle, stalled, stale, recovering or interrupted decoding has no recent speed. Monitoring resumes with
  a fresh baseline. Prompt processing alone does not count as active decoding.
- Splash's lifetime reading is labelled **Average since engine start**, including copied diagnostics. The Live
  chart identifies recent engine observations. Completed-reply measurements and saved historical values keep
  their existing basis; no lifetime reading is promoted to recent speed.

## 2.1.3

### Fixed

- The Session pane's Work Status section uses compact label/value rows: activity and speed first, then model and
  plain measurement scope. Reply age appears only when a reply measurement is available; idle and missing data no
  longer leave an empty **Last reply** block.
- Saved expanded statistics preferences no longer force the Session section into a larger, empty layout. Turn
  statistics, charts and controls remain in the full MLX Scope view, reached with **Open MLX Scope**.
- Memory warnings stay visible in one row. The nested statistics chevron, outlined scope badge and Turn stats
  replacement tip are removed from the Session summary; cloud chats keep a neutral, single-line state.

Telemetry contracts, collection cadence, saved history, permissions and connection settings are unchanged.

## 2.1.2

### Changed

- Work Status leads with speed and activity, then model, measurement scope, supported first-token time and context,
  and a short trace. Last-reply readings keep their age and provenance; warnings stay visible and turn statistics
  remain expandable within the 200 px section limit.
- Live and History are the two primary destinations at every width. Live opens Server & Mac details; History opens
  Captures with separate Reply and Timed window workflows. Resizing preserves the selected destination.
- Live keeps one next-reply action and a compact Mac summary. History groups insights, alerts and storage in named
  disclosures, opening storage automatically when action is needed. The full page no longer repeats the latest reply
  beside a combined Live/History layout.
- Active capture progress and cancellation remain reachable across navigation. Disclosure state and keyboard focus
  survive polling, and detailed server data is requested only while diagnostics are visible.

Telemetry contracts, collection cadence, saved history, permissions and connection settings are unchanged.

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
6. Something wrong? `docs/archive/2.0/ROLLBACK.md` describes fixes (2.0.x) and the legacy pin.

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

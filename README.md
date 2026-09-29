# MLX Scope

Lightweight local model monitoring for OpenChamber.

Keep useful runtime readings beside your conversation. MLX Scope observes oMLX,
Splash in Bionic, LM Studio, vllm-mlx, mlx-lm, and standalone Splash through their
supported passive APIs. Each view shows only what that server actually reports;
readings a runtime doesn't provide are left out rather than listed as unavailable.

| Runtime | Available readings |
| --- | --- |
| **oMLX** | Prefill remaining and stage estimate, generation and recent output speed, context/reuse, model activity, cache and process readings |
| **Splash via Bionic** *(recommended for Splash)* | Shown as "Splash via Bionic". Your Splash models with a Splash badge and which one is loaded; live prompt reading and generating; exact tok/s, first-token time, context use and input reuse for each finished response |
| **LM Studio** | Available and loaded models, format, and context limits; with the `lms` CLI installed, the same live request state and exact per-response figures as Bionic |
| **vllm-mlx** | Reported request activity, queue, output and speed; prefill and reuse where the engine exposes usable data |
| **mlx-lm** | Server availability and available model catalogue |
| **Splash (standalone `splash serve`)** | Loaded model and context, idle/generating state with in-flight requests, server decode speed across all requests, completed/failed counters, and GPU (Metal) memory now/peak |

All runtimes include host CPU, memory, and macOS wired/compressed/swap readings
when available. OpenAI-compatible inference does not imply equivalent monitoring.

### Using Splash in Bionic

1. Keep Bionic's Local Model API on (for example `http://127.0.0.1:1234/v1`) and add it as a provider in OpenChamber or OpenCode.
2. Make sure Bionic's `lms` command-line tool is installed (`~/.lmstudio/bin/lms`) for live request activity.
3. Open MLX Scope and leave the connection on **Automatic**. It shows "Splash via Bionic". Don't choose the standalone Splash runtime; that is only for `splash serve`.
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

## MLX Scope 2.0 (in development)

> **Draft for 2.0 — finalised in Stage 11.** This section describes MLX Scope 2.0 as designed. It is not released and
> its features are not built yet; the plan stage that builds each one is in brackets. Lines marked **Pending** rest on
> facts that are not verified yet. Everything outside this section describes the current 1.6.x release.

### What's new

- **Work Status section** [Stage 8]. MLX Scope adds a section to the chat's Work Status panel. Its glance line shows the
  phase, model, speed and per-chat label, with a 15-minute sparkline and memory, GPU and thermal chips. The section runs
  only while the Work Status panel is open and the section is expanded.
- **A Turn stats replacement** [Stage 8]. Expanded (up to 200 px), the section uses the host's Turn stats rows, with
  speeds and token counts as the runtime reports them: Response, Turn time, Model · tool time, First TTFT, Tokens in · out,
  Cache %, Context used and vs usual. Turn time and Model · tool time appear only for turns labelled as this chat's. A row
  the runtime can't report is left out (for example First TTFT on oMLX), and cost is not shown for local models. To swap
  them:
  1. Open a chat's **Work Status** panel.
  2. In **Panel sections**, hide **Turn stats**.
  3. Drag **MLX Scope** into its place. To undo, show Turn stats again.

  Scope shows these steps once as a tip you can dismiss. **The trade-off:** hiding Turn stats hides it in every chat,
  including cloud chats. In a chat that uses a non-local model, Scope's section is a single line, "Chat uses a non-local
  model", so cloud chats have no per-turn speed while the swap is in place. **Pending:** the host's menu names and Turn
  stats rows are checked against OpenChamber 2.0.4 in Stage 12.
- **Per-chat labels, inferred** [Stage 9]. Readings stay server-wide unless Scope can tell they belong to the open chat.
  A reply is labelled "This chat · inferred" only when all of these hold across it:
  - the open chat uses the connection Scope watches, with the same model;
  - the runtime counts its requests, and at most one was active at every sample;
  - the reply falls inside a turn Scope saw start and finish, with no gap in its samples;
  - auto-labelling is on (the default).

  Otherwise the reply stays "Server-wide" and shows one reason, such as "This chat uses Splash · Watch Splash".
  **Limits:**
  - Scope does not see other chats, because it doesn't request the sessions permission. Another chat alternating
    requests on the same runtime during the turn can't be ruled out.
  - OpenChamber's own background model calls, such as title generation, can fall inside a labelled turn.
  - A view opened mid-turn starts labelling at the next turn.
  - Ollama and mlx-lm don't report per-request activity, so their readings are never labelled per chat.
- **Next reply, armed** [Stage 9]. Arm it to measure your next reply in this chat. It waits up to 2 minutes for you to
  send, follows the reply for up to 10 minutes, and records it as "Next reply · armed".
  - It won't arm when the chat's provider or model differs from the watched connection; it offers "Watch …" instead.
  - It cancels when you switch chats, when the runtime becomes unavailable, or when the Scope view is hidden or closed.
  - Every step must pass the one-active-request rule. A step that fails is kept as server-wide, and the turn gets no
    summary.
- **Local reply history** [Stage 10]. Scope keeps a bounded history of replies in OpenChamber's extension storage on this
  computer: times, token counts, speeds, the model name and the label. It keeps no chat titles, IDs or content.
  - **History → Storage** has a usage bar, **Keep N days** (30 by default, 90 at most), **Pause recording** and
    **Clear…**, which asks for confirmation.
  - The first recording shows "Recording reply history locally · Open Scope to manage".
  - History feeds "vs usual" baselines, shown with their sample count and only from 5 replies, and a "Slower than usual"
    flag.
  - Replies are recorded only while a Scope view is visible, in batches, and nothing is written while idle. The History
    chart covers the last 15, 30 or 60 minutes and hatches the stretches when Scope wasn't open.
  - See [Privacy](PRIVACY.md) for what is stored and how to remove it.
- **New runtimes** [Stage 4]. llama.cpp `llama-server` and Ollama.
  - **llama-server:** health, context, model and slots, with live speed while exactly one slot is busy. On builds that
    can sleep, Scope reads slots only while `/metrics` shows work in progress, so it never wakes a sleeping server. Start
    the server with `--metrics` for live slots.
  - **Ollama:** which models are resident, their GPU-resident size (as Ollama reports it) and when each unloads. Ollama
    reports residency only.
  - Both are qualified against recorded fixtures only, not live runs.
- **Runtime updates** [Stage 3]. Splash 1.1 (recovering and stale states, vision chips, its own p50/p95 latency), oMLX 0.7
  (a read-only fallback for sub keys, and a usage card "Recorded by oMLX"), and Bionic/LM Studio (loaded instances and an
  Engines card).
- **Deeper Mac telemetry** [Stage 5]. Each reading says where it comes from.
  - macOS memory pressure (kernel), swap, and the GPU wired-memory limit.
  - GPU busy and GPU memory, both **driver-reported**. GPU memory includes other apps and reserved memory, so it is not
    model size, and no alert uses it. GPU busy is never a score or an alert.
  - macOS thermal pressure, with a warning from "Heavy".
  - The oMLX process's memory footprint.
  - Optional chip power (CPU+GPU+ANE), labelled an **estimate**, with tokens per joule. It needs
    [macmon](https://github.com/vladkens/macmon), which you install yourself. It includes all apps and is not wall power.
- **Alerts while you watch** [Stages 6 and 10]. Runtime lost, model unloaded, memory pressure, swap growth, thermal
  pressure and "Slower than usual". Alerts are raised only while a Scope view is open and visible. They show in the view,
  as a badge on the rail icon, and as toasts for critical ones by default. There is no background watcher.
- **`/scope`** [Stage 11]. Type `/scope` in the composer to attach an "MLX Scope diagnostics" chip with a sanitized
  summary: the runtime kind, phase, speeds with their basis, context size range, vs-usual changes with sample counts,
  memory pressure, GPU and thermal readings, and the per-chat label. It contains no model names, chat titles, paths or
  IDs.
  - Nothing is sent until you send your message. The summary then goes to this chat's model, **which may be a cloud
    provider**; its first line says so.
  - The chip replaces a pending GitHub or Linear chip, because the composer holds one of them at a time.
  - A sent chip is kept in the chat's session record.
  - **Pending:** the chip replacement and session-record behaviour come from the OpenChamber SDK 2.0.4 documentation and
    were not observed in the Stage 0 spike.
- **Layout** [Stage 8]. Four tabs: Live, Server, History and Captures. Compare and Saved become Captures, and monitoring
  keeps running while a capture records. The full page shows Live and History side by side.

### What 2.0 asks you to approve and why

> **Draft for 2.0 — finalised in Stage 11.** The manifest change lands in Stage 7. **Pending:** the approval dialog lists
> exactly these entries on OpenChamber 2.0.4 (Stage 12 qualification).

Updating from 1.6 asks for one new approval. OpenChamber's dialog lists every entry again, not only the new ones, and
shows `~/` paths as written. Until you approve, Scope shows a needs-approval message instead of readings.

| Entry | What Scope runs | Why |
|---|---|---|
| Local service (`service/main.js`) | Runs under your account while a Scope view needs readings | Reads the local runtime APIs on loopback and runs the commands below. It keeps readings in memory and writes no files |
| `/usr/bin/vm_stat` | `vm_stat` | Memory page counts: used, wired and compressed memory (as in 1.x) |
| `/usr/sbin/sysctl` | `sysctl -i vm.swapusage kern.memorystatus_vm_pressure_level iogpu.wired_limit_mb` | Swap, the kernel's memory pressure level and the GPU wired-memory limit (1.x read swap only) |
| `/usr/sbin/ioreg` | `ioreg -r -d 1 -w 0 -c IOAccelerator` | GPU busy and GPU memory, as the graphics driver reports them |
| `/usr/bin/notifyutil` | `notifyutil -g com.apple.system.thermalpressurelevel` | macOS thermal pressure level |
| `/usr/sbin/lsof` | `lsof -nP -iTCP:<port> -sTCP:LISTEN -t` | Finds the process listening on the oMLX port. oMLX only |
| `/usr/bin/footprint` | `footprint -p <pid>` | That oMLX process's memory footprint, where oMLX's model memory lives. The process ID never leaves the service |
| `~/.lmstudio/bin/lms` | `lms log stream -s server --json --port <port>`, `lms ps --json --port <port>`, `lms runtime ls --port <port>` | Live request activity, loaded instances and engine versions for Bionic and LM Studio. It runs only after LM Studio has answered, and never starts LM Studio or Bionic |
| `~/.cache/lm-studio/bin/lms` | The same three commands | The same, for LM Studio's older install location |
| `/opt/homebrew/bin/macmon` | `macmon pipe -i 1000` | Optional chip power estimate, only if you installed macmon with Homebrew. Scope never installs it |
| `/usr/local/bin/macmon` | The same | The same, for a macmon installed under `/usr/local` |

- **Not requested:** the `sessions` permission, which would let Scope list projects, worktrees and chats. Per-chat labels
  use only what OpenChamber gives every extension about the open chat.
- **Never used:** `sudo`, `osascript`, `powermetrics` or `pmset`.
- Each command runs by absolute path, without a shell, and only with the arguments shown. A test checks the argument list
  for each binary. OpenChamber does not sandbox a service, so this list is Scope's promise, enforced in its own code; see
  [Security](SECURITY.md).
- **Pending:** 1.6 also finds `lms` through a moved LM Studio home (`~/.lmstudio-home-pointer`). 2.0 declares only the two
  default locations, so live LM Studio activity from a moved home needs a decision before release.
- **Pending:** the footprint design re-checks the oMLX process's start time with `ps -o lstart=` before reading
  (SPIKES S9), but `/bin/ps` is not in the frozen list above. Either that check changes or the list does, which needs an
  owner decision.

### Requirements

> **Draft for 2.0 — finalised in Stage 11.**

- **OpenChamber 2.0.4 or newer**, desktop or web client. 2.0.4 is the only host 2.0 is qualified on. A 2.0 install on an
  older host is refused as too old.
- **OpenChamber 1.24.x–2.0.3:** install the 1.6 line instead. It takes security and correctness fixes only.

  ```text
  https://github.com/mikebuckets171/mlx-scope-openchamber#legacy/1.6.x
  ```

  **Pending:** the `legacy/1.6.x` branch is published at owner gate G7; until then this pin does not resolve.
- macOS on Apple Silicon for the Mac readings. Runtimes must run on the same computer as the OpenChamber server.

**Enterprise mode.** When OpenChamber runs in enterprise mode, extensions with a local service install only from
allowlisted repositories. Ask your administrator to allowlist this repository before you install or update.
**Pending:** confirm this behaviour and its setting name against OpenChamber 2.0.4.

**Something wrong after updating?** See the [rollback runbook](https://github.com/mikebuckets171/mlx-scope-openchamber/blob/main/docs/2.0/ROLLBACK.md): fixes ship as 2.0.x updates, and
the severe case is the legacy pin above. **Pending:** the link resolves once `next/2.0` is merged to `main` at G6.

**Stage 11 note: 1.x text that changes at release.** The OpenChamber 1.24.2 requirement under Install; "Telemetry is
server-wide" under What the readings mean (it becomes server-wide unless labelled); the Live/Compare/Saved list; the
runtime table (adds llama-server and Ollama); and the Splash 1.0.2 contract under Development (becomes 1.1).

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

> **Draft for 2.0 — finalised in Stage 11.** The hidden-view sentence below is corrected for OpenChamber 2.x.
> **Pending:** the correction comes from the Stage 0 spike (SPIKES S1), which measured a panel that polls the way 1.6
> does, not 1.6.1 itself.

Vanilla TypeScript, the official OpenChamber SDK, and a host-managed local service.
No UI framework, chart library, inference requests, or separate daemon. One
sampling pipeline per selected connection feeds the views; paused views and views
in a hidden browser tab or window stop requesting observations. On OpenChamber 2.x,
a 1.6.x rail panel hidden behind another rail tab keeps polling, because the host
keeps it mounted and reports it as visible; 2.0 is designed to stop it (Stage 2a).
Histories, captures,
responses, and storage are bounded.

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

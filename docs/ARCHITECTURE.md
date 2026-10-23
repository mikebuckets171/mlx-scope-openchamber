# Architecture

MLX Scope has sandboxed OpenChamber frames and a host-managed local service. Both parts ship as bundled
JavaScript. There is no separate daemon or runtime SDK to install.

| Part | Source | Bundle | What it is |
|---|---|---|---|
| Views | `panel/` | `panel/main.js` (≤ 270 KB) | One bundle for the rail panel, the full page and the Work Status section; `ctx.surface` picks the renderer |
| Service | `service/` | `service/main.js` (≤ 268 KB) | Node service the host starts on demand; reads runtimes and the Mac; exits after 10 idle minutes |
| Contract | `src/contract/` | (in each bundle) | Wire contract v2 (`docs/design/2.0-contract.md`): types, allowlist parsers, reason codes |

## Compatibility and presentation boundaries

`panel/host/openchamber.ts` owns host ready/session/lifecycle subscriptions and normalizes them into Scope-owned
`panel/host/types.ts`. Visibility removes unnecessary subscriptions; replay and disposal are idempotent. Missing
chat identity cannot select a local collector. SDK-internal
theme handling stays isolated in `panel/sdk-theme.ts`; domain components do not import SDK contracts.

`bridge/opencode/compatibility.js` defines the version rule (OpenCode 2.0.N, N ≥ 25) and feature profile consumed by the
companion, telemetry reader, setup and qualification CLI; `bridge/opencode/qualified.js` (service and CLI only) lists the
qualified versions. HTTP, experimental WebSocket observation and prompt instrumentation register independently; each
reports a run-time check (`waiting`, `passed`, or `failed` with a reason), and a failed check withdraws only that
feature. A profile describes support, while heartbeat activity describes whether the loaded companion is currently
observing demand. Unknown upstream semantics remain unqualified.

The shared run inspector uses pure `panel/present/run.ts` presentation and `panel/render/views/run.ts` markup from Live
and History. It reads existing observations only. Current detail does not start history/trend/usage reads; recorded
detail reuses the bounded ledger. Per-metric comparison preserves runtime, model, basis and input/context groups.
Missing stored provenance or phase boundaries remain missing. Storage mutations recheck format immediately before
writing or deleting a value; an unknown major stops recording without clearing it. The host storage API offers no
atomic compare-and-swap, so the final read cannot eliminate a concurrent write in the interval before mutation.

## Pipeline

```text
visible frame ──serviceRequest GET /v2/snapshot?frame&surface&tier&since&mark&attr──▶ service
                                                                                      │
  scheduler: one in-flight read per connection, cache younger than its cadence ◀──────┤
  registry → adapter (oMLX, Splash, LM Studio, llama-server, Ollama, vllm-mlx, mlx-lm) │
  host sampler: vm_stat, sysctl, ioreg, notifyutil, lsof → footprint, macmon           │
  completion detectors → ring of 128 per connection (monotonic seq)                    │
  trend ring: 2 s buckets × 1,800 (60 min), appended only while a view reads           │
  lease: one leader among visible frames (page > panel > status)                       │
  alerts evaluated on each read; toast and badge only for the leader ◀─────────────────┘
```

1. **Visible frames poll** at the service's `nextPollMs`: panel and page 1 s while active and 2 s idle; the Work
   Status section 1 s active, 3 s idle and 10 s after 5 minutes idle. Energy-saving floors are 3 s (panel) and 5 s
   (status). A lower-priority frame normally polls at 10 s or slower while a higher-priority leader is visible.
   Fresh chat observations and a busy remote chat awaiting its first observation retain active presentation cadence;
   runtime collection remains shared. The one backoff is `min(8 s, 0.5 s · 2ⁿ)`, held in the scheduler.
2. **Scheduler and slot.** The adapter reading joins the in-flight collection or reuses a cache younger than the
   cadence. A slot moves detecting → ready ⇄ degraded → failing → re-detect; re-detection runs after repeated contract
   failures, a failed identity check, or the first success after 30 s unreachable, so a new runtime on the same port is
   found. An explicitly chosen runtime is never switched automatically.
3. **Completion detectors** append finished replies with their basis. A frame asks for `since=<cursor>`; a restarted
   service (a new `instance`) or a cursor that fell off the ring is reported as a reset.
4. **Trend ring.** About 70 KB per connection, at most 8 connections. A gap longer than 2.5× the cadence is a segment
   break. Nothing is appended without a view.
5. **Lease.** Among visible frames only, priority page (3) > panel (2) > status (1), TTL 12 s; `epoch` increments on
   handover. Hidden and frameless requests are never eligible.
6. **Attribution** runs in each visible frame (pure `panel/attribution/*`); its verdicts go back with `attr=` so every
   later leader writes the same label. Turn marks go with `mark=`, carrying a salted hash of the open chat's ID that the
   service keeps in memory only.
7. **Ledger.** The leader appends replies deduplicated by `(instance, seq)` and flushes at most every 5 minutes, at 50
   rows, or on hide, with one storage write per flush and none while idle. A jump past the ring records a gap.
8. **Baselines and flags** are computed in the frame; `baseline.v2` is written only when it changes. Each frame's
   pipeline evaluates "slower than usual" from the replies it received plus History's latest stored rows, and adds two
   reasons it keeps in memory only: requests queued (`queuedMax`) and a media job running (`mediaRunning`, from the
   media service's last cached snapshot, never a new collection).
9. **Alerts.** Host and runtime alerts are evaluated in the service at request time, regression flags in the frame.
   Every frame renders them; only the leader toasts (once per `toastSeq`) and sets the badge.

**Visibility gate.** `document.hidden` is not enough on OpenChamber 2: rail tabs stay mounted behind `display:none` and
report visible. `panel/data/visibility.ts` uses IntersectionObserver, and a hidden frame pauses its poller, leaves the
lease, holds toasts, and makes zero requests (a browser test asserts it).

**Prompt reuse.** Splash's prompt-progress records, which the companion already writes, carry each request's prompt
size and reused tokens. The service keeps the newest two per chat in memory (`service/core/prompt-reuse.ts`, at most 32
chats, 30-minute expiry) and returns them as `snapshot.promptCache` only to a frame whose hashed `chat` key matches and
whose provider is local. The frame's pure `panel/present/insights.ts` decides whether that pair is a cache miss.

**Idle exit.** `service/server.ts` counts authenticated requests other than `/health` with one lazy timer. After ten
minutes without one, the service removes its chat demand and exits; OpenChamber starts it again on the next request.
The measurement harness can shorten the delay through `MLX_SCOPE_IDLE_EXIT_MS` (never below 5 s).

## Chat measurements and guided setup

`This chat` resolves the open chat's provider and model from the public host session event. Switching either clears
observations and invalidates in-flight replies. `Engine` retains explicit connection selection. The existing
contract and runtime routes remain compatible; `snapshot.chat` is an optional allowlisted measurement with scope,
basis, timing basis, observation interval, expiry and freshness. It is never merged into engine trends or baselines.

Visible frames send hashed session/model matching keys with the selected provider. Configuration metadata identifies
whether the selected provider has a discovered loopback origin. Local targets retain exact endpoint matching; remote
targets carry an explicit destination classification and require matching observed primary HTTP or qualified WebSocket metadata. Remote
snapshots omit engine, history and hardware readings and never run a runtime collector. The additive `chatOnly=1`
query also requests that path explicitly. The service writes a bounded union of watched targets into a private demand
file (15-second expiry). One
companion subscription per distinct OpenCode Location counts qualified delivery events while demanded, with a sixteen-location cap. Locations share one process-wide demand poll and writer of bounded
expiring metadata. The service accepts exactly one matching writer; absent, stale, unsafe, unsupported or ambiguous
records contribute no chat value. A one-shot view timer removes expired chat readings even if the next poll stalls.
There is no autonomous service polling loop. Hidden views send no requests; companion event work stops after demand
expires. The demand watcher itself checks only the private file: once per second while demanded, every five seconds
otherwise.

The optional setup route reads compatibility on GET and changes managed local files only on explicit authenticated
POST Enable/Disable. JSONC edits preserve comments and unrelated plugins; writes are atomic with rollback. It never
restarts the host or inference. The 3.0 chat setup preserved runtime command permissions; the media adapters added in
3.1 briefly extended the command list with a local-video cancellation path, and 5.2 returned it to the ten fixed
probes. Bundle ceilings cover media adapters and setup; the CPU/RSS and hidden-view budgets are unchanged.

## Probe tiers and cadence

Every exec uses an absolute path from `service/lib/argv.ts`, no shell, and a validated argument list.

| Probe | Full tier (panel, page): idle / active | Glance tier (Work Status) |
|---|---|---|
| `vm_stat` + `sysctl -i vm.swapusage kern.memorystatus_vm_pressure_level iogpu.wired_limit_mb` | 10 s | 10 s |
| `ioreg -r -d 1 -w 0 -c IOAccelerator` (128 KiB cap) | 15 s / 5 s | — |
| `notifyutil -g com.apple.system.thermalpressurelevel` | 60 s | 60 s |
| `lsof -nP -iTCP:<port> -sTCP:LISTEN -t` (oMLX listener) | on a generation change, then every 120 s | — |
| `footprint -p <pid>` (oMLX only) | 30 s / 10 s | — |
| `lms ps --json --port <port>` | on a generation change, then every 180 s | — |
| `lms runtime ls --port <port>` | only while Measurement details is open, cached 10 min | — |
| LM Studio liveness | `GET /lmstudio-greeting` (no spawn) | same |
| `lms log stream -s server --json --port <port>` | streamed, bounded lines, stopped 60 s after the last read | — |
| `macmon pipe -i 1000` | streamed, bounded lines, only while a local request generates and a full-tier frame has Measurement details open; stopped at once when that demand ends, samples kept until they go stale | — |
| **Spawns per minute** | **≤ 24 idle / ≤ 36 active** | **≤ 18** |

The Session sidebar collects memory pressure and thermal warnings. GPU diagnostics run only for the full tier;
glance may reuse an existing fresh GPU reading but never refreshes it. Media snapshots and their bounded JSON bodies
are shared across simultaneous views.

| Runtime work | Limit |
|---|---|
| Runtime HTTP response | 2 MB maximum; 3-second request timeout; 8-second collection budget; redirects refused |
| Splash while recovering | At most one `/status` read every 30 s |
| llama-server `/slots` | Only while `/metrics` reports work in progress on builds that can sleep |
| oMLX usage | Cached 5 minutes |
| mlx-lm model catalogue | At most once per minute; the endpoint scans the model cache |
| Native command execution | 1.5-second deadline for the memory commands; bounded output per command |
| Local configuration | Shared 5-second cache; 1 MB per file; 64 provider entries inspected; eight connections |
| Service responses | Under 256,000 characters, asserted at maximum fill |

Intervals are minimum spacing, not guaranteed sample rates. Views using the same connection share its cache and
in-flight collection. The service has no autonomous polling timer and schedules no repeating work (`setTimeout` only,
for deadlines, idle stops and backoff); a test asserts it. Sixty seconds after the last view, it makes no runtime
requests and runs no commands; after ten minutes it exits.

## Official host integration

The pinned panel SDK 2.4.0 supplies the panel, the full-page entry, the Work Status section (`statusSection`) and its
header controls, the session-menu action, live theme and typography, the local service and its status,
storage, badges, toasts, clipboard, and append-only draft composition. MLX Scope applies every host-ready theme update
without remounting. Connection selection stores only a provider ID and runtime choice. Attribution uses only the open
chat’s session and lifecycle events. The optional `sessions` subscription normalizes current-project/worktree activity in the host adapter; it never enters the measurement pipeline. It starts disabled and stops when Live is hidden. Popovers render a passed snapshot before any collector initialization. The Session section publishes two header controls through `setStatusControls`: a **Watch** select (This chat / Engine) and a **Pause** button, the at-most-two that OpenChamber 2.4 draws inline. It republishes only when their content changes and after a project change (`onDirectory`), and registers `onStatusControl` once at connect time. When the host accepts them, the in-section toolbar is hidden; on a host without the API, or one that refuses them, the toolbar stays.

The guest CSP permits packaged scripts and styles over the host's HTTP(S) asset route and embedded `data:` transport.
WebKit's opaque iframe origin cannot rely on `'self'` alone. Direct network connections, images, fonts, and form
submission stay blocked; runtime reads use the SDK service bridge.

## Packaging and verification

The SDK guest bundler builds the panel frame as a browser IIFE. A final minification pass
with pinned Terser and deterministic AST string interning keeps the guest bundle within its ceiling while retaining UI explanations. String values and protocol property spellings are preserved. Serialized SDK callback bodies are excluded from pooling, and real SDK serialization is roundtrip-tested. There is no runtime decoder or eval. The serializer guard follows lexical bindings and ordinary initializer/assignment aliases; arbitrary dynamic reflection, parameter rebinding or new serializer wrappers need explicit source review and a fresh-VM regression before qualification. The current SDK serializes its scrollbar installer through the covered direct function.toString path. Bun builds an ESM service for the host's
Node-compatible runtime, including the JSONC parser. Bundles are tracked because repository installation does not
compile TypeScript; Bun 1.4.2 makes them reproducible.

`package.json` explicitly lists install files. `scripts/verify-package.ts` checks the manifest against the frozen set
with SDK 2.4.0’s parser, the two-way exec match (every declared path is spawned by the service bundle, and every
executable path it names is declared), the bundle ceilings, the exact panel CSP, host-only code in guest bundles,
relative documentation links, archive contents, extracted bytes, and service startup without dependencies. Fixed entry
order, permissions, and timestamps make repeated packaging of the same build byte-identical. The ZIP and SHA-256 file
are release assets; source, fixtures, and development tools are not installed. The 2 MiB uncompressed package ceiling
catches accidental dependencies or artifacts; it is not a performance target. Package verification refuses to write a
ZIP when any check fails.

## Measuring overhead

From a built checkout:

```sh
bun run overhead
```

This measures the bundled service **and every process it spawns**, with fake runtimes and a fake `lms`, in four phases:
no view, active (1 s polls while the runtime generates; `--active-poll-ms` changes it), idle (2 s polls) and paused. It reports CPU time as a
percentage of one core, sampled RSS, request and spawn counts, and snapshot latency, and checks the budgets from
`docs/2.0/SPIKES.md` S13: no-view CPU, idle and active CPU, service RSS, the spawn budgets above, zero requests and spawns
with no view, and children gone within 65 s of the last read. Work Status and macmon phases and renderer CPU have
separate probes. See the [3.0 verification receipt](https://github.com/mikebuckets171/mlx-scope-openchamber/blob/main/docs/3.0/RELEASE.md) for the prior release’s baseline measurements and their scope.


## Media collection and motion

Media uses its own versioned contract and `/v2/media` route on the authenticated host service. Each configured source has one collection in flight and a two-second shared cache across visible frames. Full snapshots share in-flight composition and a short cache bounded by observation freshness. There are no autonomous media polling timers. A hidden frame stops requests; disabling media stops discovery and collection. Enabled views with no detected source retry discovery after 30 seconds so a newly started supported backend becomes available.

Adapters normalize ComfyUI jobs and Draw Things command-line renders (found with one fixed `lsof` argv and read from the tail of their output file, every 15 s while one runs and 60 s otherwise). Responses contain only bounded job identifiers, hashed ownership, lifecycle, phase-local counters and timings. Media never enters throughput trends or baselines. Cancellation is an explicit source/job action that rechecks the supported backend mechanism and reports pending acknowledgement.

The optional ComfyUI helper reads its qualified registry only when requested. Connections manages version-qualified installation and rollback, verifies live readiness separately, and leaves activation pending ordinary application startup. It adds no producer hooks or background collection. See [Media](MEDIA.md) for the public integration contract.

Circular media indicators ease only inside a stable job, phase/node and counter format. Indeterminate arcs move only during freshly observed work. Retained percentages use separate historical fields, are labelled Last reported, and remain still.

The standard interface keeps readings and traces live while its status marks animate only on activity or phase changes. Short arrival and label transitions respect reduced motion. There is no user-facing design mode or appearance picker; earlier stored design choices do not change the current interface.

The live display uses the existing presented measurements: activity and any reported model, one visibly qualified reading, the observed trace, then supporting facts. It removes a repeated current support fact only when its value and basis match a fact already visible. Retained, estimated and differently based facts keep their qualifiers. A paused or stale trace calls its endpoint the last reading. The trace fits the received observation interval, up to 90 seconds, without backfilling missing samples or joining gaps. Mac context forms a compact band below the instrument and stacks naturally with narrow space or enlarged text. These are presentation changes and add no requests, collectors or timers.

The Session surface places measured content in one bounded scrolling region above a persistent full-view action: the phase, one reading (with the prompt-time estimate while the prompt is read) and at most two exception rows, ordered alert, then measured insights (slower than usual, prompt cache miss), then a note. It has no trace or supporting-fact row in 5.1; readings, qualifiers, warnings and media details remain available at enlarged text sizes. When a focused reading disappears on a freshness change, focus moves to the full-view action. Snapshot Details is a data-only frame with the observation time and no collectors.

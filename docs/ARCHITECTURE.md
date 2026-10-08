# Architecture

MLX Scope has sandboxed OpenChamber frames and a host-managed local service. All three parts ship as bundled
JavaScript. There is no separate daemon or runtime SDK to install.

| Part | Source | Bundle | What it is |
|---|---|---|---|
| Views | `panel/` | `panel/main.js` (≤ 272 KB) | One bundle for the rail panel, the full page and the Work Status section; `ctx.surface` picks the renderer |
| `/scope` | `background/` | `background/main.js` (≤ 25 KB) | The background entry: answers the slash command, nothing else |
| Service | `service/` | `service/main.js` (≤ 210 KB) | Node service the host starts on demand; reads runtimes and the Mac |
| Contract | `src/contract/` | (in each bundle) | Wire contract v2 (`docs/design/2.0-contract.md`): types, allowlist parsers, reason codes |

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

1. **Visible frames poll** at the service's `nextPollMs`: panel and page 500 ms while active and 2 s idle; the Work
   Status section 1 s active, 3 s idle and 10 s after 5 minutes idle. Energy-saving floors are 3 s (panel) and 5 s
   (status). A lower-priority frame polls at 10 s or slower while a higher-priority leader is visible. The one backoff is
   `min(8 s, 0.5 s · 2ⁿ)`, held in the scheduler.
2. **Scheduler and slot.** The adapter reading joins the in-flight collection or reuses a cache younger than the
   cadence. A slot moves detecting → ready ⇄ degraded → failing → re-detect; re-detection runs after repeated contract
   failures, a failed identity check, or the first success after 30 s unreachable, so a new runtime on the same port is
   found. An explicitly chosen runtime is never switched automatically.
3. **Completion detectors** append finished replies with their basis. A frame asks for `since=<cursor>`; a restarted
   service (a new `instance`) or a cursor that fell off the ring is reported as a reset.
4. **Trend ring.** About 70 KB per connection, at most 8 connections. A gap longer than 2.5× the cadence is a segment
   break. Nothing is appended without a view.
5. **Lease.** Among visible frames only, priority page (3) > panel (2) > status (1), TTL 12 s; `epoch` increments on
   handover. Background and hidden frames are never eligible.
6. **Attribution** runs in each visible frame (pure `panel/attribution/*`); its verdicts go back with `attr=` so every
   later leader writes the same label. Turn marks go with `mark=`, carrying a salted hash of the open chat's ID that the
   service keeps in memory only.
7. **Ledger.** The leader appends replies deduplicated by `(instance, seq)` and flushes at most every 5 minutes, at 50
   rows, or on hide, with one storage write per flush and none while idle. A jump past the ring records a gap.
8. **Baselines and flags** are computed in the frame; `baseline.v2` is written only when it changes.
9. **Alerts.** Host and runtime alerts are evaluated in the service at request time, regression flags in the frame.
   Every frame renders them; only the leader toasts (once per `toastSeq`) and sets the badge.

**Visibility gate.** `document.hidden` is not enough on OpenChamber 2: rail tabs stay mounted behind `display:none` and
report visible. `panel/data/visibility.ts` uses IntersectionObserver, and a hidden frame pauses its poller, leaves the
lease, holds Next reply and toasts, and makes zero requests (a browser test asserts it).

**`/scope`.** The host loads `background/index.html` on demand in a hidden frame. It registers `onResolve`, makes one
`/v2/snapshot?surface=background&tier=glance` read and two storage reads (baselines and the model list), and returns a
chip built by `panel/share/scope.ts`. It never polls, never subscribes to session events, is never a lease candidate,
and writes nothing.

## Chat measurements and guided setup

`This chat` resolves the open chat's provider and model from the public host session event. Switching either clears
observations and invalidates in-flight replies. `Whole engine` retains explicit connection selection. The existing
contract and runtime routes remain compatible; `snapshot.chat` is an optional allowlisted measurement with scope,
basis, timing basis, observation interval, expiry and freshness. It is never merged into engine trends or baselines.

Visible frames send hashed session/model matching keys with the selected provider. The service validates a discovered
loopback origin and writes a bounded union of watched targets into a private demand file (15-second expiry). One
companion subscription per OpenCode process counts qualified delivery events while demanded and writes bounded
expiring metadata. The service accepts exactly one matching writer; absent, stale, unsafe, unsupported or ambiguous
records contribute no chat value. A one-shot view timer removes expired chat readings even if the next poll stalls.
There is no autonomous service polling loop. Hidden views send no requests; companion event work stops after demand
expires. The demand watcher itself checks only the private file once per second.

The optional setup route reads compatibility on GET and changes managed local files only on explicit authenticated
POST Enable/Disable. JSONC edits preserve comments and unrelated plugins; writes are atomic with rollback. It never
restarts the host or inference. Existing runtime permissions and command paths are unchanged. Bundle ceilings increase
by 8 KB for the panel and 30 KB for the service to cover guided setup, safe local transport and identifier hashing;
the CPU/RSS and hidden-view budgets are unchanged.

## Probe tiers and cadence

Every exec uses an absolute path from `service/lib/argv.ts`, no shell, and a validated argument list.

| Probe | Full tier (panel, page): idle / active | Glance tier (Work Status) |
|---|---|---|
| `vm_stat` + `sysctl -i vm.swapusage kern.memorystatus_vm_pressure_level iogpu.wired_limit_mb` | 10 s | 10 s |
| `ioreg -r -d 1 -w 0 -c IOAccelerator` (128 KiB cap) | 15 s / 5 s | 15 s |
| `notifyutil -g com.apple.system.thermalpressurelevel` | 60 s | 60 s |
| `lsof -nP -iTCP:<port> -sTCP:LISTEN -t` (oMLX listener) | on a generation change, then every 120 s | — |
| `footprint -p <pid>` (oMLX only) | 30 s / 10 s | — |
| `lms ps --json --port <port>` | on a generation change, then every 180 s | — |
| `lms runtime ls --port <port>` | only while Server & Mac details is visible, cached 10 min | — |
| LM Studio liveness | `GET /lmstudio-greeting` (no spawn) | same |
| `lms log stream -s server --json --port <port>`, `macmon pipe -i 1000` | streamed, bounded lines, stopped 60 s after the last read | — |
| **Spawns per minute** | **≤ 24 idle / ≤ 36 active** | **≤ 18** |

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
requests and runs no commands.

## Official host integration

The pinned SDK 2.0.4 supplies the panel, the full-page entry, the Work Status section (`statusSection`), the background
entry and slash command, the session-menu action, live theme and typography, the local service and its status,
storage, badges, toasts, clipboard, and append-only draft composition. MLX Scope applies every host-ready theme update
without remounting. Connection selection stores only a provider ID and runtime choice. Attribution uses only the open
chat's session and lifecycle events; the `sessions` capability is not requested.

The guest CSP permits packaged scripts and styles over the host's HTTP(S) asset route and embedded `data:` transport.
WebKit's opaque iframe origin cannot rely on `'self'` alone. Direct network connections, images, fonts, and form
submission stay blocked; runtime reads use the SDK service bridge. The background page declares the same policy.

## Packaging and verification

The SDK guest bundler builds the panel and background frames as browser IIFEs. A final minification pass
with pinned Bun folds linked code to keep both guest bundles within their ceilings while retaining UI explanations. Bun builds an ESM service for the host's
Node-compatible runtime, including the JSONC parser. Bundles are tracked because repository installation does not
compile TypeScript; Bun 1.4.2 makes them reproducible.

`package.json` explicitly lists install files. `scripts/verify-package.ts` checks the manifest against the frozen set
with SDK 2.0.4's parser, the two-way exec match (every declared path is spawned by the service bundle, and every
executable path it names is declared), the bundle ceilings, the background CSP, host-only code in guest bundles,
relative documentation links, archive contents, extracted bytes, and service startup without dependencies. Fixed entry
order, permissions, and timestamps make repeated packaging of the same build byte-identical. The ZIP and SHA-256 file
are release assets; source, fixtures, and development tools are not installed. The 2 MiB uncompressed package ceiling
catches accidental dependencies or artifacts; it is not a performance target.

## Measuring overhead

From a built checkout:

```sh
bun run overhead
```

This measures the bundled service **and every process it spawns**, with fake runtimes and a fake `lms`, in four phases:
no view, active (500 ms polls while the runtime generates), idle (2 s polls) and paused. It reports CPU time as a
percentage of one core, sampled RSS, request and spawn counts, and snapshot latency, and checks the budgets from
`docs/2.0/SPIKES.md` S13: no-view CPU, idle and active CPU, service RSS, the spawn budgets above, zero requests and spawns
with no view, and children gone within 65 s of the last read. Work Status and macmon phases, renderer CPU, and the
8-hour Work Status soak are measured on the real host in Stage 12.

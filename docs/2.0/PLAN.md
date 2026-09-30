<!-- Copy of the approved MLX Scope 2.0 plan (owner decisions, principles, architecture, stages). Source of truth for the remaining work; the G1/S2 amendment boxes at the top of §5 override the body. docs/2.0/SPIKES.md and docs/design/2.0-G2-DECISIONS.md record the evidence and design calls. -->

# MLX Scope 2.0 — implementation plan

## Context

MLX Scope (`mikebuckets171/mlx-scope-openchamber`) is the owner's OpenChamber extension for passive, honest monitoring of
local LLM runtimes on Apple Silicon: oMLX, Splash via Bionic, LM Studio, vllm-mlx, mlx-lm and standalone Splash, plus Mac
host resources.
- **History:** 1.0 → 1.6.0 shipped 19–29 Sep 2026.
- **Source tree:** `~/CodexWork/mlx-scope-splash`, a worktree of `~/CodexWork/mlx-scope-openchamber` on branch
  `design/1.6-redesign` at `c54a8f5`. The tree is identical to `origin/main` `3e55532`.
- **Stack:** vanilla TS (~11.6k lines), `@openchamber/sdk` 1.24.2, manifest `apiVersion 1`. The owner runs OpenChamber
  2.0.4 (Electron 43.7 / Chromium 150) on an M5 Pro with 48 GB.

**Why a 2.0.** 1.x has hit its ceiling:
- Readings are server-wide only, with no memory beyond 90 s, and Scope is invisible inside the chat.
- A new runtime means about 9 edits.
- The panel `update()` is ~170 lines of runtime branches.
- Detection is sticky: a port swap on `:8000` never re-detects.
- LM Studio activity is process-global.
- Hosted CI has been red since 1.5 (billing lock).
- 1.6 was never verified in the real host.

The research behind this plan came from 8 readers, a 3-draft judge panel and 3 adversarial reviews, all read-only. It is
consolidated here.

### Owner decisions (binding)
1. **All four themes:** OpenChamber-2-native surfaces · per-session attribution · history, baselines and alerts · broader
   coverage (new runtimes and deeper Mac telemetry).
2. **Clean break.** Require OpenChamber 2.x and restructure freely. Old hosts get a legacy 1.6.x line.
3. **OMLX Scope** (sibling repo and Mac app) is out of scope.
4. **One public 2.0.0 release.** Internal betas are fine.
5. **Attribution: "auto + armed".**
   - Auto-label as "This chat · inferred" only when unambiguous; otherwise withhold.
   - Add an armed **Next reply** capture and turn markers.
   - Use the official SDK only. The private `/api/global/event` is rejected: it breaks P2 and returns 401 here.
6. **History: local ledger.**
   - A bounded per-reply ledger in `host.storage`, a 15–60 min in-memory service trend, and the oMLX `/admin/api/usage`
     read-through.
   - Baselines and regression flags.
   - Model names are stored locally and never shared. The service writes nothing to disk.
7. **Alerts only while a Scope view is mounted** (panel, page or Work Status section). No background watcher, no osascript.
8. **Runtimes.**
   - Add llama.cpp `llama-server` and Ollama.
   - Upgrade Splash to 1.1, oMLX to 0.7, and Bionic/LM Studio.
   - vllm-mlx and mlx-lm stay.
9. **Deeper Mac telemetry:** GPU (ioreg), pressure level and wired limit (sysctl), thermal (pmset), per-runtime footprint,
   and optional macmon power with tok/s per W. No sudo, powermetrics or osascript.
10. **1.6.1 hotfix first**, for the `lms` relaunch bug (Stage H).
11. **Keep the extras in 2.0:**
    - `lms runtime ls` engine card
    - two-column page layout
    - turn summary
    - llama speculative-decoding stats
    - Splash vision chips
    - Copy baseline summary
    - alert log
    - tok/J "vs usual"
12. **`/scope` slash command ships in 2.0**, via `background.entry`.
13. **MLX Scope replaces the host's "Turn stats" in Work Status** (owner request, 2026-09-29).
    - **The platform facts:** OpenChamber 2.0.4's Work Status panel has a user-level "Panel sections" chooser, where each section can be hidden or dragged to reorder. It lists Session, Project, Usage, Turn stats, Subagents, MCP, Pinned messages, Context sources and extension sections. There is no API to hide a host section, so the swap is a user setting.
    - **The design:** the MLX Scope section is a drop-in, richer Turn stats replacement. It uses Turn stats' label/value row layout and covers the same slots where local runtimes can report them:
      - response tok/s (runtime-exact);
      - whole-turn time, and model vs tool/wait time (attributed turns only);
      - TTFT; tokens in, cached and out; cache reuse %;
      - context used; vs-usual.
      Cost is left out for local models. It also adds live decode/prefill and memory chips. Its height is ≤200 px expanded, set with `setHeight`.
    - **The swap flow:** a one-time tip, "Replace Turn stats: hide it in Panel sections and drag MLX Scope into its place", is dismissible and stored in `pref.v2`. README documents it too. On the owner's install it is configured during Stage 12.

> **One deviation, flagged for the owner:** the "title-generation step" special case is **not** implemented. It would need
> `~/.config/openchamber/settings.json` (`smallModelOverride`), which also holds client tokens and relay keys and must never
> be read. It would also invent a classification (P3). Title-generation requests fall under the general rule, which
> withholds them when ambiguous. The ⓘ says OpenChamber's own background model calls can appear inside an inferred turn.

### Verified platform facts that shape everything
**Versions and manifest**
- SDK 2.0.4 keeps manifest `apiVersion 1` and wire `v: 1`.
- 2.x-only manifest keys need an `engines.openchamber` floor. The format allows only a floor; older git installs get
  `host-too-old`.

**Surfaces**
- `contributes.statusSection` (2.0.1+) adds a frame to the chat's Work Status panel.
  - The frame is torn down on collapse.
  - Users can hide it. It needs no new capability.
  - It can call `setBadge`, `toast` and `serviceRequest`.
- Rail tabs stay **mounted when hidden** (`display:none`, while `document.hidden` stays false). The page is an overlay above
  the chat.
- The badge clears only when a non-headless panel **mounts**.
- A panel-only command resolver makes the host mount the whole panel headless. With a `background.entry`, the background
  frame (`surface:'background'`) handles `onResolve` and the panel never does.

**Sessions**
- `onSessionLifecycle` needs no grant and covers only the open session.
- It carries no timestamp and **replays the last phase** to late subscribers and on session switch.
- The `sessions` grant is all-or-nothing: approving Scope approves it. It exposes project names and folders, chat titles and
  activity.
- There is no supported per-session token event and no service→panel push, so polling stays.

**Storage**
- 64 KiB per value, 2 MiB and 2,000 keys per extension, wiped on uninstall.
- Each operation re-reads and zod-validates the whole namespace file on the OpenChamber server. Each `set` rewrites it
  (temp file plus rename).
- Every failure reaches the guest as the same `HOST_REJECTED`.
- `guest-storage/mlx-scope.json` exists (55 B).

**Limits and grants**
- Response ≤256,000 chars · toast ≤500 chars · request timeout 20 s · ≤32 subscriptions per frame · background frames get
  a 20 s deadline.
- Grants are rechecked for scope equality: any exec or capability change, added or removed, re-prompts every install.

**Existing code**
- `readCommand` passes env `{LANG, LC_ALL}` only (`service/native-command.ts:38`), so every exec must use an absolute path.

**The `lms` wake-up bug**
- `lms ps`, `log stream` and `runtime ls` call `createClient`. Without `LMS_API_SERVER_INFO_PATH`, that calls
  `findOrStartLlmster`, which **launches Bionic/LM Studio**.
- `--port 1234` does not help: the public port doesn't serve the lms websocket.
- 1.6.0 already triggers it: `touch()` runs before the read (`service/lmstudio.ts:37`), and the stream restart loop is
  `lmstudio-activity.ts:317-321`.
- `lms log stream --stats` works only with `--source model`, which streams prompt and response text. **Rejected.**

---

## 1. Principles for 2.0

| # | 2.0 rule |
|---|---|
| P1 Observer only | **Unchanged.**<br>- Adapters send GET only, except the existing oMLX `POST /admin/api/login`.<br>- A per-binary argv allowlist test enforces the exact `lms` argv set (`log stream -s server --json`, `ps --json`, `runtime ls`), always spawned with `LMS_API_SERVER_INFO_PATH` and only after `GET /lmstudio-greeting` → `{"lmstudio":true}` within 10 s.<br>- llama-server `/slots` and `/metrics` are gated on `is_sleeping === false` until S7b proves they are safe.<br>- No pmset verb other than `-g therm`. |
| P2 Official APIs | Unchanged. Attribution uses `onSession`, `onSessionLifecycle`, `onProjects`, `onSessions`, `listSessions`. |
| P3 Never invent | **Sharpened.** Every capability descriptor has a `basis`: `reported`, `derived`, `observed`, `last-observed` or `estimate`. Anything that isn't `reported` is labelled, and unreported readings are left out. A test enforces that a non-null field implies its capability is present. |
| P4 Server-wide | **Amended (decision 5).**<br>- "This chat · inferred" appears only under the §5.5 rule.<br>- Armed results read "Next reply · armed".<br>- Everything else is server-wide.<br>- Session titles, IDs and folders are never rendered, stored or sent to the service. |
| P5 Lightweight | - The service holds in-memory rings, filled only by view-driven reads.<br>- `setTimeout` only (deadlines, idle-stops, restart backoff, shutdown); a test asserts no `setInterval`.<br>- The service writes nothing.<br>- Hidden frames do nothing: the IntersectionObserver gate is in §4.4.<br>- The status section uses a **glance tier** of probes.<br>- Ledger writes are batched, with zero idle writes. |
| P6 Private sharing | - Model names stay in the local ledger and the in-view UI only.<br>- One sanitizer (`panel/share/report.ts`) covers every share path: Copy, Add to chat draft, `/scope`, toasts, baseline summary, `capture.v2`.<br>- Canary tests in two classes (§8). |
| P7 Honest qualification | - A live or fixture column per runtime in COMPATIBILITY.<br>- Receipts hold shapes, counts and timings only.<br>- The exact release artifact and the git-update path are rehearsed before launch (§9 Stage 12). |
| P8 Recognisable | - Keep the 1.6 tokens (`panel/style.css:7-27`), card system and four tabs.<br>- A mock-first gate (G2).<br>- No new visual language. |
| P9 One side-effect frame | Ledger writes, toasts and the badge come only from the **leader**: one visible frame, elected in service memory by priority page > panel > status. |
| P10 Contract before features | No feature code until contract v2, the registry and the golden tests are green. Presenters are pure, with injected clocks. |
| P11 Rebuildable frames | Every frame rebuilds its full state from the service plus storage within one poll. |

---

## 2. Stage H: 1.6.1 hotfix (before any 2.0 work)

**Branch.** `hotfix/1.6.1` from `v1.6.0`. Engines, SDK and the exec list are unchanged, so there is **no re-approval**.

**Fixes**
1. **No-wake `lms`.**
   - Spawn every `lms` child with `LMS_API_SERVER_INFO_PATH=<lmstudioHome>/.internal/http-server.json`, where
     `lmstudioHome` comes from the same candidates as `findLms` (`lmstudio-activity.ts:230-235`). This goes into the stream
     spawner env (`lmstudio-activity.ts:238-240`).
   - Move `activity.touch()` in `service/lmstudio.ts:37` to **after** a successful inventory read.
   - Gate `start()` and `scheduleRestart()` on a successful `GET /lmstudio-greeting` within the last 10 s. After the runtime
     disappears there is no restart; the stream stops.
2. **v0 fallback.** It also triggers on HTTP 200 with a body `{"error":"Unexpected endpoint…"}` (`service/lmstudio.ts:39-44`).
3. **Tests:**
   - a fake `lms` that records argv and env;
   - zero spawns while the connection is unreachable;
   - no restart after the runtime goes away;
   - a fixture for the 200 + error body.

**Verification**
- `bun run check:all` passes.
- `scripts/smoke-service.mjs` passes.
- Owner-run: with Bionic up, `lms` activity still streams. Optionally, the owner quits Bionic with Scope open and confirms
  with `ps -A` that nothing relaunches within 3 min.
- `LMS_API_SERVER_INFO_PATH` is re-verified here with Bionic up.

**Release**
- **[OWNER GATE H1]** merge to `main`, tag `v1.6.1`, and release. Hosted CI is locked, so this uses a local macOS receipt plus
  an owner waiver, or waits for billing to be fixed.
- Git installs, including the owner's, update to it.
- Branch `legacy/1.6.x` is then cut locally at `v1.6.1`, as the line for pre-2.0.4 hosts.

---

## 3. Stage 0: spikes (settle every unknown before the permission freeze)

**Rules**
- Throwaway extensions live in `~/CodexWork/scope-spike*/`, outside the repo. The **owner installs and removes each one from
  a folder [OWNER GATE]**.
- Runtime probes are GET only.
- No inference, no `lms load`/`unload`/`server start`, and splish is never started.
- Any chat traffic is the owner's normal work.
- Findings go to `docs/2.0/SPIKES.md` as **shapes, counts, timings and key names only**. No values, paths, IDs or model names
  (§8 scrub gate).

| ID | Settles | Go → / fallback |
|---|---|---|
| **S1 Status section** | `statusSection` with `entry` = the panel entry (a single bundle) on 2.0.4:<br>- `serviceRequest` from the status frame<br>- `setHeight` clamp to 24–320<br>- teardown on collapse, hide, chat switch<br>- mount cost of the full panel bundle<br>- whether IntersectionObserver v1/v2 detects `display:none` rail tabs and the page overlay | Renders, no blank surface, mount ≤100 ms → go. Mount >100 ms → split out a `status/` bundle. Status unusable → rail Compact (≤160 px) is the glance view. Floor stays `>=2.0.4`. |
| **S2 Sessions** | In panel, **page** and status frames, over 10–15 min of the owner's normal local chats (Bionic, oMLX, a subagent, a permission prompt, a new chat):<br>- `onSession().model` format for local providers<br>- runtime → lifecycle lag<br>- replay behaviour<br>- `onSessions` activity, `parentId` and how often `unknown` appears<br>- project count (2 today) | Model present and lag ≤1 s → go. Otherwise: model missing → auto withheld as `model-unknown`; lag >2 s → hold time = measured lag; `onSessions` unusable → armed-only (owner yes needed). |
| **S4 `/scope`** | `commands` plus `background.entry`:<br>- cold resolve including service spawn and `/health`, against the 20 s deadline<br>- chip `{providerId,id,title,url,text}` visible and removable<br>- what happens to a pending GitHub/Linear chip<br>- how the chip persists in the session snapshot<br>- **Never send.** | Cold ≤8 s → go. Otherwise owner decides: drop, or keep with a warning. |
| **S5 Storage** | `get`/`keys`/`set` p50/p95 at 0.1, 1 and 1.4 MiB; OpenChamber-process CPU and event-loop lag during a full ledger read; bytes written per flush; limit behaviour; two-frame races; restart survival | `get` p95 ≤30 ms at 1.4 MiB, and ≤150 MiB/day written at typical use → ledger cap 1,280 KiB. Otherwise cap 768 KiB and a 120 s flush. |
| **S6 oMLX** | Read source: `/api/status` auth, `/admin/api/usage` params, the `api_key` in `/admin/api/stats` near `admin/routes.py:6497`, and whether 0.6.4 has these. Live GETs through `scripts/probe-runtimes.mjs`, a throwaway spike script that reuses `service/config.ts` credential resolution and **never** reads `settings.json`. | Shapes stable and usage ≤2 MB → go. Otherwise the sub-key fallback ships fixture-qualified; usage card hidden on 401. |
| **S7 Splash 1.1** | Read source for `/metrics` series names and `/status` `transport`, `status_stale`, `vision` and `input_modalities`. Capture from splish only if the owner runs it. (Port `:41343` is LM Studio's internal API, not Splash — not probed.) | Names confirmed → go. Otherwise `/metrics` off. |
| **S7b llama-server** | Read `tools/server` source: do `/slots`, `/metrics` or `/props` wake a sleeping server? Does `/slots` expose prompt text by version? | Safe → poll per §4.5. Otherwise only `/health` and `/props` while sleeping; `/slots` numeric allowlist only. |
| **S8 `lms`** | With Bionic up, time CPU-seconds and RSS for `ps --json` and `runtime ls` under the no-wake env (measured so far: ~0.13 s CPU and ~117 MB each). Record only the **boolean** values of Bionic `logSensitiveData` and `logIncomingTokens`. | Cadences fitted to the spawn and CPU budget. |
| **S9 Mac telemetry** | - Time `ioreg` and `pmset`, and `lsof`→`footprint` for :8001 and :1234.<br>- Validate ioreg `Alloc system memory` within ±10% of the **sum** of loaded runtimes' reported allocations (and of the single runtime when only one is loaded), across loads the owner makes.<br>- Check whether `pmset -g therm` ever records anything on the M5 under the owner's normal sustained load.<br>- Read the macmon field docs. | **G1 decision rows:**<br>- Alloc fails → show ioreg values labelled "GPU memory (driver-reported, not model size)", with no wired-limit alert.<br>- pmset never records → owner chooses to drop thermal (and `/usr/bin/pmset`) or keep it as "no warning recorded". |
| **S10 Bun** | Build the tracked bundles with Bun 1.3.14 and 1.4.2 in a scratch clone and `cmp` them. | Pin whichever reproduces. |
| **S11 Update and identity** | - How the approval dialog renders `~/…` exec strings.<br>- What each frame and storage get while approval is pending.<br>- How to run an **isolated OpenChamber instance** (separate data dir or second macOS user) for the Stage 12 git-update rehearsal.<br>- Concrete "restart Scope" instructions (pause/resume in Settings → Extensions). | Pick the rehearsal method. Bare `lms`/`macmon` plus a README path table if `~/` renders badly. |
| **S13 1.6 baselines** | `measure-overhead.mjs` extended to descendants (`ps -A -o pid,ppid,time,rss`) against 1.6.1. The owner screenshots 1.6 in 2.0.4, which closes PR #6's box. Screenshots stay out of the repo. | The numbers 2.0 is budgeted against. |

**Already settled from host code, so no spike is needed:**
- the lifecycle grant and its scope;
- status-frame badge and toast;
- extension id = `panel.id`;
- an update stops the service;
- `#ref` pinning;
- the payload and toast limits (they are SDK constants).

**G1 [OWNER GATE].** The owner reviews SPIKES.md, gives go/no-go per row, and **freezes the permission set** (§6). After G1,
any exec or capability change needs an owner yes.

---

## 4. Target architecture

### 4.1 Layout
Marker meanings: (N) new · (R) rewrite · (M) `git mv`, with history kept · (K) kept.

**`src/contract/` (R).** Replaces `src/telemetry.ts`, `src/runtime.ts` and `src/system.ts`. Pure and shared.
- `version.ts`: `CONTRACT_VERSION = 2`.
- `units.ts`: `*Bytes` (integers), `*Ms`, `*Tps`, `*Fraction`, `*W`, `*At`. No decimal GB anywhere.
- `capabilities.ts`: `{scope:'request'|'server'|'host', basis}`.
- `reasons.ts`: codes plus params. The English moves to `panel/present/messages.ts`.
- `runtime.ts`: adds `llama-server` and `ollama`.
- `snapshot.ts`: `parseSnapshotV2` keeps the cross-field rules at `telemetry.ts:787-792` and adds the honesty invariant.
- Also `completion.ts`, `host.ts`, `trend.ts`, `usage.ts`, `alerts.ts`, `hash.ts`. `hash.ts` is a pure-JS hash for the
  in-memory session tag, because `crypto.subtle` isn't guaranteed.

**`service/`**

| Path | Kind | What changes |
|---|---|---|
| `main.ts`, `server.ts` | R | Routes are GET-only; the 405 guard stays (`server.ts:22`); the bearer compare becomes constant-time (`:21`). |
| `core/registry.ts` | N | Descriptors `{id, hints, detect→confidence, cadence, capabilities, create}`. Replaces the ternary chain in `runtime-client.ts:135-170`. |
| `core/slot.ts` | N | Pure state machine: detecting → ready ⇄ degraded → failing(n) → redetect. |
| `core/scheduler.ts` | N | Keeps the slot key, in-flight sharing, 450 ms floor and 8-slot LRU from `runtime-client.ts:79-110`. Holds the only backoff. Adds `nextPollMs`. |
| `core/lease.ts`, `core/marks.ts`, `core/verdicts.ts` | N | Leader election in memory; ring of 64 turn marks; attribution verdicts per completion `seq`. |
| `history/ring.ts`, `history/completions.ts`, `history/alerts.ts` | N | `completions.ts` absorbs `panel/insights.ts:17-80` `SessionInsights` detection. `alerts.ts` is the pure evaluator plus toast rate limits and the alert log. |
| `lib/http.ts` | M | Adds `isRouteMissingBody()` and `requestText()`. |
| `lib/parse.ts` | N | One set of `obj`/`count`/`finite`/`modelLabel`. Replaces ~9 guards and 5 label regexes. |
| `lib/prometheus.ts` | N | |
| `lib/native-command.ts` | M | Byte-identical. |
| `lib/argv.ts` | N | Typed argv builders with validated loopback port and PID. |
| `config.ts` | K | Hints move into descriptors, adding `splish`. The `resolveOmlxConfig` seam (`:339-344`) is removed. The `MLX_SCOPE_*` and `OPENCODE_*` env branches stay as dev/test seams: `measure-overhead.mjs:70` and 8 test files use them. |
| `adapters/` | | `omlx.ts` (R), `omlx-normalize.ts` (M, verbatim from `telemetry.ts:272-657` apart from unit renames), `omlx-usage.ts` (N), `lmstudio.ts` and `lmstudio-activity.ts` (R, per connection), `lmstudio-cli.ts` (N), `splash.ts` and `splash-metrics.ts` (R), `vllm-mlx.ts` and `mlx-lm.ts` (R, degrade), `llama-server.ts` and `ollama.ts` (N). |
| `host/` | | `sampler.ts` (R of `system.ts`), `memory.ts` (R of `mac-memory.ts`), `gpu.ts`, `thermal.ts`, `footprint.ts`, `power.ts` (N). |

**`panel/`.** One bundle serves the rail panel, the page and the status section; `ctx.surface` selects the renderer and the
heavy views load lazily.

| Path | Kind | What changes |
|---|---|---|
| `main.ts` | R | Bootstrap only, ≤250 lines. `update()` (`:278-446`) is deleted. |
| `state/scope-state.ts` | N | Replaces ~33 module-level `let`s. |
| `data/client.ts` | N | Wraps `serviceRequest`; clock offset = median of 5 `serverNow − rtt midpoint`. |
| `data/visibility.ts` | N | IntersectionObserver v1, plus v2 `trackVisibility` where supported. |
| `data/poller.ts` | K | |
| `present/*.ts` | N | Pure: header, live, server, history, captures, glance, alerts, messages, and `format` (the only GiB formatter). |
| `render/dom.ts` | K | Patch helpers from `main.ts:166-176`. |
| `render/chart.ts` | R | From `signal.ts`. Keeps `traceGeometry`; adds marks and gap bands. |
| `render/views/*` | N | |
| `attribution/{sessions,join,next-reply}.ts` | N | `next-reply.ts` ports `omlx-scope-openchamber` `origin/work/openchamber-final-pass:panel/reply-capture.ts`. |
| `history/{ledger,ledger-schema,accounting,baselines,regress,migrate-v1}.ts` | N | |
| `alerts/signals.ts` | N | |
| `captures/` | R | `capture.ts` core kept; `saved.ts` becomes `store.ts`. |
| `share/{report,attach}.ts` | K + N | |
| `chart-inspector.ts`, `connections-view.ts`, `connection-help.ts`, `host-errors.ts`, `progress.ts`, `context.ts`, `resources.ts`, `preferences.ts`, `openchamber-view.ts` | K | |

**`background/` (N, ≤25 KB).** Handles `onResolve` for `/scope` only. It makes one `/v2/snapshot?surface=background` read,
never polls, never subscribes to sessions, and is never a lease candidate.

**`ui/tokens.css` (N).** Extracted unchanged from `panel/style.css:7-27`.

**Adding a runtime** becomes one adapter file, one registry line, one fixture folder and `messages.ts` entries.

### 4.2 Wire contract v2 (all routes GET, bearer, `no-store`, bodies asserted <256,000 chars)

**Routes**

| Route | Purpose |
|---|---|
| `/health` | Unchanged. |
| `/v2/snapshot?provider&runtime&frame&surface&tier&since&mark&attr&detail` | The main poll. |
| `/v2/trend?provider&runtime&window=900\|1800\|3600&series=` | ≤180 buckets of {min, max, last}, plus `gaps[]` and marks. |
| `/v2/usage?provider&range=7d\|30d\|90d` | oMLX read-through, 5 min cache, allowlisted fields. |
| `/snapshot` | **410** `contract_mismatch`, for 1.6 panels. |

**Version skew.** A 404 on `/v2/*`, for example from a still-running 1.6 service, is mapped by the panel to
`contract_mismatch`, with S11's concrete restart instruction.

**`SnapshotV2` fields**
- `contractVersion: 2`, `serverNow`.
- `service {version, instance}`.
- `connection {id, label, runtime, engine?, host?, generation, choices≤8, detection{basis, confidence}}`.
- `status {state: ready|degraded|detecting|failing|unconfigured|recovering, reason, params}`.
- `capabilities` (absent means not reportable).
- `runtime {phase, request{…}, server{active, queued, histograms?}, memory{processBytes?, modelBytes?, metalBytes?, ceilingBytes?}, residency[], slots[], catalog[], engines[]}`.
- `host {cpuFraction, mem*, mac{pressureLevel, wiredLimitBytes, swap*, …}, gpu?, thermal?, runtimeProcess?, power?}`.
  Each part carries `sampledAt`.
- `completions {instance, cursor, reset, items: CompletionV2[]}`.
- `marksHead`.
- `alerts[] {id, severity, since, params, toastSeq?}`.
- `alertLog[≤20]`.
- `lease {leader, epoch, ttlMs}`.
- `nextPollMs`.

**`CompletionV2` fields**
- `{seq, finishedAt, startedAt|null, model|null, basis, promptTokens?, cachedTokens?, outputTokens?, ttftMs?, prefillMs?, decodeTps?, prefillTps?, overlapped, aggregateOf?, verdict?, host{pressureMax?, swapDeltaBytes?, gpuAllocMaxBytes?, thermalWarning?, energyJ?, powerCoverage?}}`.

**Never on the wire:** PIDs, `api_key`, cookies, prompt text, file paths, session IDs or titles.

**Query parameters**
- `mark=<started|completed|failure>.<atMs>.<tag8hex>`. The service dedupes by `(tag, phase, |Δat| ≤ 1 s)`.
- `attr=<seq>.<inferred|withheld>.<reason>` records a frame's verdict next to its completion. Any later leader writes that
  same label. Rows with no verdict are "Server-wide · not observed".
- `tag8` is a hash of the session id salted with `service.instance`, and lives in memory only.
- `tier=glance|full`. `detail=server` gates reads that only the Server tab needs.

### 4.3 Pipeline
1. **Visible frames poll** per `nextPollMs`.
   - Panel and page: 500 ms active, 2 s idle.
   - Status: 1 s active, 3 s idle, 10 s after 5 min idle.
   - Energy-saving floors: 3 s for the panel, 5 s for status.
   - One backoff: `min(8 s, 0.5·2ⁿ)`.
   - While a higher-priority leader is visible, lower-priority frames get `nextPollMs ≥10 s`.
2. **Scheduler and slot.** The adapter reading joins the in-flight collection or reuses a cache younger than the cadence.
3. **Completion detectors** append to a ring of 128 per slot, with a monotonic `seq`.
4. **Trend ring.**
   - 2 s buckets × 1,800 (60 min): `Float64Array` time plus `Float32Array` values.
   - About 70 KB per slot, ≤8 slots.
   - A gap longer than 2.5× cadence is a segment break. **Nothing is appended without a view.**
5. **Lease.**
   - Among **visible** frames only, priority is page (3) > panel (2) > status (1). TTL is 12 s and `epoch` increments on
     handover.
   - Background and headless frames are never eligible.
6. **Attribution join.** Pure `join.ts` runs in each visible frame, and its verdicts go back via `attr=`.
7. **Ledger.** The leader appends from the ring, deduplicated by `(instance, seq)`, and batches its flushes (§5.6). The
   persisted cursor serves as the ack. A jump past the ring records a `gap`.
8. **Baselines and flags** are computed in memory. `baseline.v2` is written only when it changes, at most every 10 min.
9. **Alerts.**
   - Host and runtime alerts are evaluated in the service at request time; regression flags in the panel.
   - Every frame renders them inline.
   - Only the leader toasts (gated by `toastSeq`) and sets the badge.
   - A visible panel calls `setBadge(null)` itself.

### 4.4 Visibility gate and probe tiers
**Visibility gate.**
- `data/visibility.ts` feeds Poller pause, lease eligibility, the Next-reply hold, toasts and session subscriptions.
- `document.hidden` alone is insufficient: it is what `panel/main.ts:476,485` uses today.
- Browser test: a `display:none` iframe makes **zero** `serviceRequest`s.

**Probe tiers and spawn budget.** Every exec uses an absolute path, no shell and a validated argv.

| Probe | full tier (panel/page), idle / active | glance tier (status) |
|---|---|---|
| `vm_stat` + `sysctl -i vm.swapusage kern.memorystatus_vm_pressure_level iogpu.wired_limit_mb` | 10 s | 10 s |
| `ioreg -r -d 1 -w 0 -c IOAccelerator` (128 KiB cap) | 15 s / 5 s | 15 s |
| `notifyutil -g com.apple.system.thermalpressurelevel` (replaces pmset, G1) | 60 s | 60 s |
| `lsof -nP -iTCP:<port> -sTCP:LISTEN -t` (oMLX listener only) | on generation change + 120 s | — |
| `footprint -p <pid>` (**oMLX only**; re-check the pid's `ps -o lstart` start time before reading) | 30 s / 10 s | — |
| `lms ps --json --port <internal>` | on a generation change (from the `/api/v0/models` state) + 180 s | — |
| `lms runtime ls` | only while the Server tab is visible, cached 10 min | — |
| LM Studio liveness | `GET /lmstudio-greeting` (no spawn; replaces `lms server status`) | same |
| `macmon pipe -i 1000` | streamed like `lms` (`BoundedLines`, 60 s idle-stop) | — |
| **Spawns/min budget** | **≤24 idle / ≤36 active** | **≤18** |

---

## 5. Feature designs

> **G1 amendments (from `docs/2.0/SPIKES.md`, which is authoritative where it differs from this section)**
>
> **Splash**
> - Read `/status` only; no `/metrics`.
> - Latency uses native `ttft_ms` / `itl_ms` p50/p95 plus n.
> - State precedence: recovering > status_stale > not admitting > ready.
> - Recovering is polled no faster than every 30 s.
> - `last_crash_trace`, `transport.error`, `instance.*` and `identity.*` are never on the wire.
>
> **llama-server:** the S7b rule. `/slots` is polled only while `/metrics` reports `requests_processing` ≥ 1 on sleep-capable builds. Gauges are never used for rates.
>
> **oMLX**
> - `/admin/api/stats` is no longer called.
> - Usage `include_details` only for today, yesterday and 7d; `models[]` ≤ 50.
>
> **LM Studio:** the `/api/v0/models` state is the generation-change trigger.
>
> **Host telemetry**
> - ioreg GPU memory is shown as "driver-reported, not model size", and **no** GPU-limit alert uses it.
> - The runtime Metal meter never alerts.
> - Thermal comes from notifyutil.
>
> **Ledger flush:** at most every 5 min, or at 50 rows, or on hide.
>
> **Attribution**
> - Ignore all lifecycle replays (×3 on mount).
> - The unknown-activity rule counts only non-archived sessions updated in the last 24 h.
> - Deduplicate `onSession` repeats.
> - Parse `serviceRequest` bodies from strings.
>
> **Bun:** pin 1.4.2.
>
> **S2 owner decision (2026-09-29): drop the `sessions` capability.**
> - **Why:** `onSessions` cannot see the owner's "chats" group sessions (verified: seven new chats never appeared in either registered project). Its approval text is also broad.
> - **What attribution uses instead:**
>   - `onSession` (open chat: id, busy, model);
>   - `onSessionLifecycle` (open chat only; replays ignored);
>   - the provider and model match;
>   - runtime active requests ≤ 1 across the whole span;
>   - ring coverage.
> - **Conditions:** condition 1 (projects ready) and condition 2 (other running sessions and subagents) are removed. The subagent and other-chat reason codes go too. `other-provider`, `model-differs`, `overlap`, `not-observed`, `joined-mid-turn` and `outside-turn` remain.
> - **The ⓘ must say:** "Another chat alternating requests on the same runtime during this turn can't be ruled out."
> - **S2 measured:**
>   - Lifecycle `started` leads runtime busy by 0.14–0.20 s, and `completed` matches runtime idle within 0.5 s. Use a **1 s** hold and tolerance.
>   - Deduplicate lifecycle and session events on (session id, phase) changes, because the host re-sends them 2–3× per transition.
>   - Multi-step turns keep `started` across tool pauses.
>   - Post-turn title/recap requests fall outside the turn and are withheld.
> - **Manifest:** no `capabilities` entry. The approval dialog lists only the local service and its exec entries.

### 5.1 Registry and re-detection
**Detection pass.** One pass, with a per-pass cache. `isRouteMissingBody` counts as 404; 401/403 means an authenticated
runtime is present. The hinted descriptor goes first, then:

| Order | Probe | Identifies |
|---|---|---|
| 1 | `/health` | oMLX via `isOmlxHealth`; vllm-mlx by shape |
| 2 | `/props` with `build_info` and `total_slots` | llama-server |
| 3 | `/api/version` then `/api/ps` | Ollama |
| 4 | `/lmstudio-greeting` plus `/api/v1/models` | LM Studio family |
| 5 | `/status` with boolean `ready` | Splash |
| 6 | `/v1/models` where every `owned_by` is vllm-mlx | vllm-mlx |

mlx-lm is detected by hint only.

**Re-detection** triggers on:
- 3× `unsupported_contract`;
- `identity()` failing (every 60 s; oMLX every 300 s);
- the first success after ≥30 s unreachable.

This fixes the sticky `:8000` (`runtime-client.ts:135`). An explicitly chosen runtime is never auto-switched; instead the
panel shows "Looks like Splash now · Switch".

**Optional endpoints degrade** their capability instead of blanking the runtime: vllm-mlx `/health` (`vllm-mlx.ts:47`),
mlx-lm `/v1/models`, llama `/slots`/`/metrics`, Splash `/metrics`.

**"Automatic + explicit runtime"** keeps its 1.6 meaning: the first connection whose hint or detected runtime matches. It is
covered by a test with a persisted 1.6 selection.

### 5.2 Runtime currency
**Splash 1.1**
- `transport.recovering` → "Recovering", not offline. `status_stale` → "Status stale".
- `vision` and `input_modalities` → catalog chips.
- `/metrics` (5 s active, 30 s idle, only if it is Prometheus text with allowlisted names) → server TTFT/queue p50/p90 with
  *n*, `derived`.
- **Per-request TTFT only when** TTFT `_count` Δ=1, `completed` Δ=1, active ≤1 at both reads, and nothing is queued. It is
  labelled `derived`, never "exact". Otherwise it is recorded with `aggregateOf`.
- Metal memory stays separate from process memory (`splash.ts:80`).

**oMLX 0.7**
- Fall back to `/api/status` on admin 401/403, with coverage `server` and copy saying so. The "subkeys cannot read
  monitoring" text (`runtime-client.ts:114`) is removed.
- `/health` `engine_pool.final_ceiling` → `ceilingBytes`.
- `/admin/api/usage` read-through.
- `api_key` stripped, enforced by a canary fixture.

**Bionic / LM Studio**
- The Stage H fixes carry over.
- Activity is bound per connection and resets on stream restart or connection change. It counts as healthy only after the
  first parsed JSON record: the flag moves below `JSON.parse` (`lmstudio-activity.ts:293`).
- `lms ps --json` → loaded instances. `lms runtime ls` → Server "Engines" card ("splash 0.0.5 · yuzu").
- A parser fixture with `logSensitiveData`/`logIncomingTokens`-style lines asserts content is dropped, with bounded CPU.

**Fixtures.** Corpora live in `tests/fixtures/<runtime>/<version>/`, each with a `SOURCE.md` (synthetic, or captured and
**scrubbed**).

### 5.3 Prometheus parser, llama-server, Ollama
**`lib/prometheus.ts`**
- Handles 0.0.4 text: `# TYPE`, labels, escapes, `_bucket{le}`/`_sum`/`_count`, NaN/±Inf, and `llamacpp:` names.
- Bounds: 2 MB, ≤5,000 samples, and a per-adapter name allowlist. Label values never reach the wire.
- Fuzz corpus included.

**llama-server**
- `/health` returns 503 while loading. `/props` every 60 s supplies `n_ctx`, `is_sleeping` and the model from the last segment
  of `model_path`.
- `/slots` (1 s) and `/metrics` (5 s) run only while `is_sleeping === false`.
- Live rate: Δ`n_decoded`/Δt of the **single** busy slot, `observed`. With ≥2 busy slots, per-request speed is withheld.
- `/slots` is parsed for **numeric allowlisted fields only**.
- `/metrics` provides processing/deferred counts, server rates, and speculative-decoding acceptance (`derived`, on the Server
  tab).
- A completion is recorded when the only busy slot goes busy → idle.

**Ollama**
- `/api/version` (60 s) for detection and `/api/ps` (5 s) for residency.
- `size_vram` is labelled "GPU-resident (Ollama-reported)", never "VRAM".
- `expires_at` is shown as "unloads in".
- Coverage is inventory, with no completions. Copy: "Ollama reports residency only."

**Qualification.** Both are **fixture-qualified**: the owner archived these stacks on 09-20.

### 5.4 Host telemetry
**Signals**
- **Pressure:** `pressureLevel` 1/2/4 → "macOS memory pressure (kernel): normal / warning / critical". Other values are left
  out.
- **Wired limit:** `wiredLimitBytes` comes from `iogpu.wired_limit_mb` (40960 here).
- **GPU:** "GPU busy (driver-reported)", shown in the Mac card only. **Never** a headline, a score or an alert.
- **GPU memory:**
  - ioreg Alloc as "GPU memory in use (system-wide)" if S9 validates it. Otherwise it is labelled "driver-reported, not
    model size".
  - The runtime meter reads "<runtime> model memory vs macOS GPU wired limit" and never triggers an alert.
  - The **Near-GPU-limit alert uses only validated system-wide ioreg Alloc.**
- **Thermal:** shown only when pmset records a warning (subject to the S9/G1 decision).
- **Footprint:** "process listening on :port", only for runtimes where S9 sets `footprintMeaningful` and that don't already
  report process memory.
- **Power:** "Chip power (macmon estimate: <exact field>) · includes all apps · not wall power". `estimate` basis. The
  capability is absent without macmon, and Scope never installs it.

**tok/J** (shown as "tok/s per W")
- Computed only during decode, with active = 1 and power coverage ≥80%.
- "vs usual" uses a **separate, labelled estimate baseline** (n≥5).

**Tests**
- Parser fixtures (scrubbed; ioreg PIDs removed).
- Fake binaries in `tests/bin/`.
- Absent binary, timeout, and oversize output for every probe.
- argv validator tests.
- `sysctl -i` with a missing key still returns the other keys.

### 5.5 Attribution: auto, armed, markers
**Subscriptions**
- `onSession` and `onSessionLifecycle` always (no grant needed).
- `onProjects`/`onSessions` **only while `attribution.auto` is on and the frame is visible**. At most 31 subscriptions, taking
  the most recently updated projects, plus a `listSessions` sweep at each turn start for the rest.

**Titles and folders** are received from the host but never rendered, stored or sent anywhere.

**Lifecycle replay.** The first lifecycle event after mount or a session switch is treated as a **replay**: no mark is sent
and the window start is unknown (`joined-mid-turn`). Events are stamped on receipt, and wall time is "observed".

**Auto rule.** A reading or completion is labelled "This chat · inferred" only if **all** of these hold across its span,
with ±1.5 s clock tolerance:
1. The host is connected; every subscribed project is `ready`; no session updated in the last 24 h is `unknown`; the sweep
   is complete.
2. Exactly one session is `running`/`retrying`, it is the open session, and no running session has it as `parentId`.
   Permission and question waits count as not running.
3. The session's provider equals the monitored connection, and its model equals the runtime model after normalising both.
4. The runtime can count requests; active ≤1 at every sample; the event is not `overlapped` and has no `aggregateOf`.
5. The span lies inside a live-observed started → completed/failure window, and conditions 1–4 held for the S2 lag before it.
6. The preference `attribution.auto` is on (the default).
7. **The span is fully covered** by ring samples with no segment break, or by a healthy runtime event stream (the Bionic
   `lms` stream).

**Withhold reasons** (the item stays "Server-wide" with one reason):
- `projects-loading`, `projects-error`, `too-many-projects`
- `several-chats`, `subagent-running`
- `other-provider` (shown as "This chat uses Splish · Watch Splish")
- `model-differs`, `model-unknown`
- `cannot-count`, `overlap`, `outside-turn`, `joined-mid-turn`, `not-observed`
- `auto-off`

**Armed Next reply** (a port of PR #8, keeping `REPLY_WAIT_MS` 120 s and `REPLY_LIMIT_MS` 600 s)
- It won't arm when the chat's provider or model differs from the monitored connection; it offers "Watch …" instead.
- Conditions 2–4 are checked **per step**:
  - A failing step keeps its host wall time but is stored as a server-wide window.
  - A `t` row and a turn summary are written only if every step passes.
- Labelled "Next reply · armed".
- Cancels on chat switch, runtime unavailable, or the arming frame becoming invisible or unmounting.

**Turn summary** (DO, per decision 11). Shown only when every step in the turn is attributed:
- observed wall time minus waits;
- step count;
- first-step TTFT;
- total output;
- token-weighted decode rate, `Σtok/Σ(tok/tps)`;
- cache reuse %.

**Labels**
- The hero strip reads "Last reply · server-wide" unless the reply is attributed.
- Every History row carries its `attr` chip.
- The chart legend reads "Turn times from OpenChamber · readings are server-wide".

**Tests**
- `join.test.ts` truth table: every condition × pass/fail; replay on mount and switch; remount mid-turn; `unknown`; gap
  crossing; >31 projects; external request; clock skew ±5 s.
- Armed with a second chat, a subagent, or a model or provider mismatch.
- The PR #8 tests, ported.
- Presenter label assertions.
- The existing test that the chat title never renders (`tests/browser/preview.ts:204-207`), extended to every surface.

### 5.6 History: ring, ledger, oMLX usage, baselines
**Service trend**
- Live keeps 90 s. History shows 15, 30 or 60 min.
- Gaps are hatched: "Not observed · Scope wasn't open". Nothing is interpolated.
- Turn and step ticks are drawn.

**Completion bases.** Every History and baseline surface shows counts per basis, under a header reading "Observed while
Scope was open".

| Runtime | Completion signal | Basis |
|---|---|---|
| Bionic | `Done ·` line | `reported` |
| oMLX, vllm-mlx | request disappears | `last-observed` |
| Splash | counter Δ=1 | `derived` |
| llama-server | slot busy → idle | `observed` |

**Ledger rows**
- `r` (reply): `['r', finishedS, rt, modelRef, ctxB, uncB, prompt, cached, output, ttftMs, prefillTps×10, decodeTps×10, basis, attr, turnRef, cofactorBits, energyJ×10, id]`.
- `t` (turn): `['t', startedS, endedS, rt, modelRef, steps, output, firstTtftMs, wDecodeTps×10, waitMs, attr, cofactorBits]`.
- **No session tag is persisted.**

**Keys**

| Key | Contents |
|---|---|
| `meta.v2` | `{schema, migratedAt, accounting}` |
| `view.*`, `connection.selection` | Unchanged. |
| `pref.v2` | |
| `capture.v2.<ts36>` | ≤12 entries |
| `ledger.v2.models` | Label dictionary; written only when it changes. |
| `ledger.v2.c.<startSec36>.<rand4>` | Chunks ≤56 KiB serialized (asserted <60 KiB), about 600 rows. |
| `baseline.v2` | |
| `observation.v1.*` | **Kept, untouched, through 2.0.x.** |

**Budget and eviction**
- **Exact client-side accounting** of serialized size and key count, recomputed at leader start and updated per write.
- Ledger cap 1,280 KiB (768 KiB if S5 fails), with at least 128 KiB of headroom under 2 MiB at all times.
- Retention: 30 days by default, 90 at most.
- Eviction runs **only after a flush**: expired chunks first, then the oldest.
- On `HOST_REJECTED`, probe `get('meta.v2')`. If that fails, stop quietly (not approved or disabled). Otherwise back off and
  retry. **Never evict because of an error.**

**Writes**
- Leader only.
- A flush fires on `completed`, when the frame becomes invisible, or at 50 pending rows. Flushes are ≥60 s apart (hide
  flushes ≥10 s).
- One `set` per flush, plus the dictionary only when it changes.
- **Zero writes when idle**, tested including leader handover.

**First run.** The first ledger write from any surface, including status, shows "Recording reply history locally · Open
Scope to manage".

**History → Storage controls**
- A usage bar, retention, Pause, and Clear (with confirmation).
- **Copy baseline summary** (DO): sanitized, models aliased "Model A/B", ≤32,000 chars.
- The **alert log** (DO) is kept in service memory, last 20 entries.

**oMLX usage.** A card labelled "Recorded by oMLX", covering 7/30/90 days with hourly or daily buckets. It is never merged
into the ledger, and says it has no TTFT.

**Baselines**
- Decode rate keyed by `rt|modelRef|ctxBucket`, with buckets <8k, 8–32k, 32–64k, 64–128k and >128k.
- TTFT and prefill rate keyed by `rt|modelRef|uncachedBucket`.
- 14-day window, last 50 values; the current 30 min are excluded.
- Excluded rows: `aggregateOf`, overlapped rows (for per-request metrics), `estimate`, gap rows, and `last-observed` rows
  (for TTFT and token statistics).
- p50 needs n≥5 and p90 needs n≥10, always shown with *n*.

**Regression flag**
- Fires when the median of the last 3 replies within 30 min is ≤0.85×p50 (rates) or ≥1.25×p50 (TTFT). It clears within 10%.
- A single reply only gets a delta chip.
- Co-factors are listed as "Observed during these replies", never as causes.

**Tests**
- A fake storage enforcing the host limits and the whole-file serialization rule.
- Accounting checked against serialized size.
- 20k-row simulation.
- Idempotent replay; handover with pending rows; chunk-key uniqueness.
- Eviction; the `HOST_REJECTED` paths.
- Zero idle `set` calls.
- Baseline golden values.

### 5.7 Alerts (only while a Scope view is mounted and visible)

| Alert | Where it shows |
|---|---|
| Runtime lost | in view, badge, error toast once per episode |
| Model unloaded | in view, badge, info toast ≤1 per 30 min |
| Pressure warning (level 2) | in view, badge |
| Pressure critical (level 4) | in view, badge, toast ≤1 per 30 min |
| Swap growth (+≥1 GiB within 5 min) | in view, badge, info toast |
| Near GPU wired limit (validated ioreg Alloc ≥90% → <85%) | in view, badge |
| Thermal (if kept) | in view, badge, info toast |
| Slower than usual (§5.6 flag) | in view; toast only in "All" mode |
| Splash recovering, oMLX prefill stall, oMLX memory guard | in view (existing behaviour) |

**Rules**
- Swap growth and every other windowed alert are evaluated only within **one contiguous segment with ≥80% coverage**.
- There is never an alert on GPU utilisation.
- Toast limits: ≤1 per minute and ≤3 per hour, held in service memory. Toasts are non-persistent and clamped to 500 chars by
  the sanitizer.
- Badge = the count of active badge-eligible alerts.
- Preference `alerts.toasts`: `critical` (the default), `all` or `off`.

**Tests**
- A fake-clock table for hysteresis, dwell and cooldown, including a case that crosses a gap.
- The rate limiter.
- Only the leader toasts or badges.

### 5.8 OpenChamber 2 surfaces
**Work Status section** (`statusSection`, same entry, title "MLX Scope")
- Line 1: phase dot · short model · tok/s (or prefill % + ETA, labelled a runtime estimate) · attribution tag.
- Line 2: a 15 min sparkline, pressure/GPU/thermal chips, and the top alert.
- `setHeight`: 56, or 80 with an alert, or 24 for a non-local chat ("Chat uses a non-local model").
- Uses the glance tier and respects Energy-saving.
- It can lead: ledger, toasts and badge work only while visible.
- The same component is the rail's **Compact** mode (≤160 px). This replaces today's ~490 px compact view.

**Page** (`page:true`, `ctx.surface==='page'`). A two-column Live | History layout (DO, per decision 11).

**`/scope`** (DO, decision 12). `commands:[{name:"scope"}]` plus `background.entry`. The resolver returns
`{providerId:'mlx-scope', id, title:'MLX Scope diagnostics', url:README, text}`:
- `text` is ≤16,000 chars from `share/report.ts`.
- It starts with a header: "Sent to this chat's model, which may be a cloud provider".
- It carries the runtime kind (no model name), phase, rates with basis, context bucket, baseline deltas with *n*,
  pressure/GPU/thermal, and the attribution label.
- README and PRIVACY state that it replaces a pending GitHub or Linear chip, and that it persists in the session record.

**Kept:** the `open-mlx-scope` session action; `host.toast` replaces the home-made `#action-status` (`main.ts:533-538`).

### 5.9 UX and IA: four tabs (Live · Server · History · Captures), behind a mock-first gate
**Live**
- Hero: attribution chip, one hero speed with a basis ⓘ, and a "Last reply / This chat" strip that includes Next reply and
  vs-usual.
- Mac card: pressure, GPU, wired-limit meter, thermal, footprint, power and tok/J (inside the details disclosure).

**Server**
- Runtime card: detected runtime, version, engine and detection basis.
- Histograms, residency/slots, `lms` instances, the Engines card, the ceiling, and speculative-decoding stats.
- "Input context" is removed here; it appears only on Live, as "Context used".

**History:** trend, replies, turn summaries, baselines, oMLX usage, storage, alert log.

**Captures**
- Compare and Saved merge into one tab: Next reply, the 30/60 s window, ≤12 saved.
- **Monitoring keeps running.** The suspend in `main.ts:486-490` is removed.

**Connection** has one entry point: ⋯ → Connection. The diagnosis callout links there.

**Removed:** dead UI (`.request-output`, `.recent-speed`, `style.css:137`), and the coverage-gating CSS
(`style.css:341-346`), which is replaced by presenter capability checks.

**G2 [OWNER GATE], before any panel feature code: `docs/design/2.0-mock.html`.**
- Static, using the real tokens and v2 fixtures.
- States covered:
  - decode, inferred;
  - withheld (2 chats, subagent);
  - oMLX prefill;
  - Next reply: armed, measuring and result;
  - Splash recovering; offline;
  - needs-approval;
  - llama slots; Ollama residency;
  - pressure plus swap alerts;
  - History with gaps; storage full;
  - the status section in 4 states;
  - the page at 1,160 px.
- Shots at 320/430/1,160 px × dark/light, saved to `docs/design/2.0-mock-shots/`. The existing `mock-shots/` stays as it is.
- The owner also confirms these defaults:
  - history on, with the first-run notice;
  - toasts critical-only;
  - auto-labelling on;
  - retention 30 days;
  - whether the status section may toast.

---

## 6. Manifest and permissions (frozen at G1)

```diff
- "@openchamber/sdk": "1.24.2"            + "@openchamber/sdk": "2.0.4"      + "packageManager": "bun@<S10>"
- "engines": { "openchamber": ">=1.24.2" } + "engines": { "openchamber": ">=2.0.4" }
+ "capabilities": ["sessions"]
+ "statusSection": { "entry": "panel/index.html", "title": "MLX Scope", "height": 72 }
+ "commands": [{ "name": "scope", "description": "Attach a private MLX Scope diagnostics summary" }]
+ "background": { "entry": "background/index.html" }
  exec: "/usr/bin/vm_stat", "/usr/sbin/sysctl",
-       "lms",
+       "/usr/sbin/ioreg", "/usr/bin/notifyutil", "/usr/sbin/lsof", "/usr/bin/footprint",
+       "~/.lmstudio/bin/lms", "~/.cache/lm-studio/bin/lms", "/opt/homebrew/bin/macmon", "/usr/local/bin/macmon"
  files: + background/index.html, background/main.js, ui/tokens.css
```

**Floor `>=2.0.4`**
- `statusSection` needs 2.0.1, but 2.0.4 is the only host we can qualify (P7), and 2.0.2 showed a black surface.
- Lowering it later is CONSIDER.

**Re-approval**
- One re-approval covers everything.
- `host-errors.ts` gains a needs-approval state: "MLX Scope 2.0 needs one approval: GPU, thermal and process readings; chat
  activity for per-chat labels (Scope sees project names, folders, chat titles and activity but never stores, shows or sends
  them); reply history stored locally."
- README gets a "What 2.0 asks you to approve and why" table, plus an enterprise-mode note (a service extension needs its
  repo allowlisted).
- **No exec or capability change in 2.0.x, whether adding or removing.**
- If a feature slips before release, its entries are removed. That needs an owner yes.

**`verify-package.ts`**
- A **two-way exec match**: every declared path is spawned in `service/main.js`, and every absolute spawn path is declared.
- Bundle ceilings: panel ≤260 KB, service ≤170 KB, background ≤25 KB.
- The background CSP must equal `panel/index.html:6`.
- The leak check at `:38` extends to all bundles.
- The existing 2 MiB (`:41`) and `page` (`:42`) checks stay.

---

## 7. Migration, legacy and rollback

**Storage: migrate, never destroy.**
- `view.*` and `connection.selection` are kept. `view.compact` now means the ≤160 px glance view.
- `observation.v1.*` → `capture.v2.*` through `migrate-v1.ts`:
  - reuses `sanitizeObservation` (`panel/saved.ts:47-61`);
  - converts **GiB → bytes as ×2³⁰**, because 1.6 stores GiB (`saved.ts:36`);
  - covers `measurements` and `reference`.
- v1 keys **stay** through 2.0.x (≤48 KiB) and are deleted in 2.1.
- The golden test uses a real 1.6-written record.

**Legacy line**
- `legacy/1.6.x`, cut from `v1.6.1`, takes security and correctness fixes only.
- README: "OpenChamber 1.24.x–2.0.3: install `…/mlx-scope-openchamber#legacy/1.6.x`".
- Legacy releases after 2.0 use `gh release create --latest=false`.
- `ci.yml` push branches gain `legacy/**`.

**Rollback runbook** (`docs/2.0/ROLLBACK.md`; required before G6)
- Fix forward with 2.0.1. Semver must increase.
- Severe case: users pin `#legacy/1.6.x`. v1 captures survive because the keys are kept; the ledger is not visible to 1.6.
- Owner-side: update `~/CodexWork/splish-local/RUNBOOK.md:124-127` and check `tools/setup_check.sh:45-50`.
- Keep `docs/design/mock-shots/live-dark-1160.png`, which `tools/vision_check.sh:10` needs.

**Docs (Stage 11)**

| Doc | Change |
|---|---|
| README | Surfaces, attribution rules, approvals table, legacy pin, enterprise note, "community-maintained". |
| CHANGELOG | 2.0.0 with Breaking and Upgrading sections; reconcile the untagged 1.1.1 and 1.2.0 entries. |
| COMPATIBILITY | Host 2.0.4; a live or fixture column per runtime. |
| METRICS | Units, basis, capability table, left-out policy, pressure, GPU, power field, tok/J. |
| PRIVACY | Ledger contents and per-reply timestamps, retention, location under `~/.config` (included in backups), Clear/Pause; the `sessions` exposure; `/scope`; the Bionic log-flag note. |
| SECURITY, CONTRIBUTING | Drop "one-time release"; exec list; "no sudo, osascript or powermetrics"; Bun pin; dev seams; fixture scrub rules. |
| ARCHITECTURE | The pipeline and the tier/cadence table (fixes `:37`). |
| CONFIGURATION | llama-server, Ollama and splish hints. |

**Link rule.** `connection-help.ts:24` links prerelease versions to `main` and releases to `v${version}`.

---

## 8. Quality gates and verification

1. **Build and CI**
   - Bun pinned (S10) via `packageManager`, `.bun-version` and `bun-version-file`.
   - The tracked-bundle diff covers `panel/main.js`, `service/main.js` and `background/main.js`.
   - tsconfig `include`, test/build scripts and `.gitattributes` gain `background/`.
   - **Chromium is the primary browser gate** (the host is Electron/Chromium 150); WebKit is secondary.
   - Pixel baselines run on macOS only; Linux runs DOM assertions.
   - Hosted CI is billing-locked, which is an **[OWNER]** fix. Until then `scripts/ci-local.sh` writes
     `docs/receipts/ci-<sha>.json`, labelled "local macOS leg". The Linux leg needs hosted CI or an explicit waiver.
   - A manual release runbook mirrors `release.yml` (tag = version, notes, sha256) and is used only under a waiver.
2. **Unit and contract**
   - Per-adapter fixture → reading → `parseSnapshotV2` round-trip.
   - The honesty invariant.
   - The 38-case `tests/fixtures/omlx-monitoring.json` stays the normalizer oracle.
   - `http.ts` direct tests: 2 MB cap, redirect refusal, timeout, 200+error body.
   - The P1 method, path and argv allowlist.
   - No `setInterval` in `service/`.
   - Unit lint: `*Bytes` values are safe integers.
   - Every `/v2/*` route at maximum fill serializes to <256,000 chars.
3. **Golden gate for the refactor**
   - Stage 1 captures 1.6 DOM text and screenshots on `tests/browser/host.html` for every fixture state.
   - **Stage 2a** must reproduce them byte-identically. Its v2 fixtures come from a reviewed, unit-tested v1→v2 converter.
   - **Stage 2b** behaviour fixes each ship with a listed, owner-visible golden diff.
4. **Browser**
   - Fix the vacuous selectors at `preview.ts:100,114`.
   - `host.html` emulates 2.0.4: surfaces `status`/`background`, `setHeight`, scripted lifecycle (including replay) and
     `onSessions` feeds, `setBadge`/`toast` recorders, storage quotas and whole-file semantics, `display:none` tabs, leader
     handover.
   - `toHaveScreenshot` at 320/430/1,160 × dark/light, for 4 tabs, the page, and the status section at 280×(24/56/80).
   - A `crypto.subtle`-undefined case.
5. **Overhead** (`scripts/measure-overhead.mjs`, in `check:all`)
   - Measures the service plus all descendants, using fake binaries.
   - Phases: no view, panel active and idle, status only, panel + status, paused, macmon.
   - Budgets:
     - idle ≤ S13 baseline + 0.5 points of one core;
     - decode with panel + status ≤ baseline + 1.5 points and ≤3% absolute;
     - service RSS ≤ baseline + 40 MiB, with per-child ceilings listed separately (`lms` stream, `lms` one-shots, macmon);
     - spawns per §4.4;
     - 60 s after the last view: **0 runtime requests and 0 spawns**, and children gone by 65 s.
   - Real host: an **8-hour status-only soak**, renderer CPU sampled, and OpenChamber-process bytes written ≤150 MiB/day.
6. **Smoke** (`scripts/smoke-service.mjs`)
   - Adds Splash `/status` + `/metrics`, llama-server, Ollama, fake `lms` and macmon, the v2 routes, and the `/snapshot` 410.
   - Runs with a temporary HOME; an fs spy asserts **no files are created**.
7. **Privacy canaries** (a property test with a sink matrix)
   - **Class A** — session IDs and titles, project names and folders, request IDs, `api_key`, cookies, prompt text, paths,
     usernames, PIDs — is forbidden **everywhere**: routes, query parameters, storage, DOM, shares, logs.
   - **Class B** — model names — is allowed in `/v2/snapshot`, `/v2/usage`, the in-view DOM and the ledger. It is forbidden
     in Copy, compose, `/scope` text, toast message and `copy`, the baseline summary, `capture.v2` and receipts.
8. **Committed-file scrub gate** (`scripts/scan-committed.ts`, run in check and CI)
   - Covers `tests/fixtures/**`, `docs/receipts/**`, `docs/2.0/**` and screenshots.
   - Rejects `/Users/`, the owner's username, key, bearer and cookie patterns, UUID-shaped IDs, non-allowlisted model names,
     and long free text.
   - Owner-real screenshots never go into the repo.
9. **Real-host qualification** → `docs/receipts/2.0.0-host-qualification.json`, owner-run on 2.0.4 desktop.
   - **beta.0** (after Stage 8): all surfaces render, with no blank or black surface.
   - **beta.N** (Stage 12): the dialog lists exactly the §6 set, and every surface renders.
   - Visibility and teardown:
     - hidden tabs are idle;
     - status tears down, rebuilds, and keeps its markers.
   - Signals: the badge sets and clears; a toast shows once.
   - Attribution:
     - inferred on a single chat;
     - withheld with 2 chats or a subagent;
     - Next reply on a reply the owner sends;
     - **zero wrong labels** across scripted runs;
     - the hit rate is reported.
   - Runtimes: oMLX and Bionic live; splish if it's running.
   - Ledger:
     - survives a restart;
     - Clear works;
     - no idle writes (`ls -l` on the file).
   - `/scope` chip shows, with nothing sent.
   - The original `mlx-scope` 1.6 install is **paused** during overhead runs.
10. **Git-update rehearsal of the exact artifact** (before G6)
    - In the isolated instance (S11), git-install `…#rc/2.0.0` while that branch still points at v1.6.1, and save a capture.
    - Push the 2.0.0 RC to `rc/2.0.0` **[OWNER GATE]**.
    - Trigger the update, then check the re-approval, the needs-approval frames, the migration and the version-skew message.
    - The RC is compared with the last beta: only `version` and `panel.id` may differ, and the bundles must be byte-identical.
    - If the owner declines the rehearsal, COMPATIBILITY and the receipt say "git-update path not rehearsed".
11. **Independent code and privacy review** before G4.

---

## 9. Staged execution

**Branch.** Local `next/2.0`, cut from `v1.6.1`, with one commit per stage.

**Every stage exits on:** `tsc` clean · `bun test` green · browser suite green · bundles rebuilt and reproducible ·
scrub gate green · a stage note in `docs/receipts/`.

| Stage | Content | Exit / gate |
|---|---|---|
| **G0 [OWNER]** | Approve this plan. It pre-approves the Stage 1 edits that don't change visuals: the SDK dependency bump with engines unchanged, the tokens extraction, and the test fixes. | — |
| **H** | 1.6.1 hotfix (§2) | **H1 [OWNER]**: merge, tag and release 1.6.1; `legacy/1.6.x` cut locally |
| **0** | S1–S13 | SPIKES.md → **G1 [OWNER]**: go/no-go, permission freeze, S9 decision rows |
| **1** | Bun pin; SDK 2.0.4 with engines unchanged; vacuous selector fixes; 1.6 goldens and screenshots; descendant-aware overhead plus the 1.6 baseline; `ci-local.sh`; `scan-committed.ts`; fixtures; `ui/tokens.css`; **`2.0-mock.html` and `docs/design/2.0-contract.md`** | 1.6 behaviour unchanged → **G2 [OWNER]: mock sign-off** |
| **2a** | Contract v2, `core/*`, `lib/*`, normalizer move, 5 adapters at parity, v2 routes and the `/snapshot` 410, lease, `nextPollMs`, visibility gate, panel on presenters | **Goldens byte-identical**; round-trips; converter tests |
| **2b** | Re-detection, optional-endpoint degrade, LM Studio per connection, reason codes in `messages.ts` | Listed golden diffs; port-swap test |
| **3** | `prometheus.ts`; Splash 1.1; oMLX 0.7; Bionic `ps` and `runtime ls` | Corpora with SOURCE.md; `api_key` canary; argv allowlist |
| **4** | llama-server (sleep gate), Ollama | Detection matrix; `/slots` privacy test |
| **5** | Host tiers: sysctl `-i`, ioreg, pmset, lsof→footprint, macmon stream | Spawn and CPU budgets on macOS |
| **6** | Service history: ring, `/v2/trend`, detectors, cursor, marks, verdicts, `/v2/usage`, alert evaluator and log | Fake-clock tests; gap semantics; no `setInterval` |
| **7 Flip** | The §6 manifest, `files`, `verify-package.ts`, build wiring, `host.html` 2.0.4 emulation | `verify:package` green; the manifest parses with SDK 2.0.4 |
| **8** | State, presenters, 4 tabs, status section and Compact, page layout, toast and badge | Screenshots match the mock → **G3a [OWNER]: beta.0 host smoke** |
| **9** | Attribution: sessions, join, Next reply, markers, turn summary | Truth table; scripted-session browser tests |
| **10** | History tab, ledger, accounting, baselines, flags, alerts UI, migration | Storage simulation at the limits; zero idle writes; canaries |
| **11** | `/scope` and background entry; all docs; ROLLBACK.md | Link check; docs claim nothing unqualified |
| **12** | beta.N as `mlx-scope-beta` (**G3 [OWNER] for each install**); §8.9 checklist; one week of dogfooding; independent review; §8.10 rehearsal | Receipts complete → **G4 [OWNER]: acceptance** |
| **13** | **G5 [OWNER]**: hosted CI green, or a waiver plus the manual runbook. **G6 [OWNER]**: merge `next/2.0` → `main`, tag `v2.0.0` and release **in one sitting** (merging to main *is* the public launch). **G7 [OWNER]**: push `legacy/1.6.x`. **G8 [OWNER]**: any announcement. | Release digest recorded |

**Slip rule.** Nothing slips silently. Any item moves to 2.1 only with an explicit owner yes for that item. If it had exec
entries, they are removed before release.

---

## 10. Decision matrix and LEAVE THIS ALONE

**DO**
- 1.6.1 hotfix.
- Contract v2, registry, re-detection.
- Runtime currency: Splash 1.1, oMLX 0.7, Bionic `ps` and `runtime ls`.
- llama-server and Ollama, on the Prometheus parser.
- Host tiers, including GPU, pressure, wired limit, thermal (per G1), footprint and macmon.
- tok/J with its estimate baseline.
- Auto + armed attribution, markers, turn summary.
- Ring, ledger, baselines, flags, oMLX usage, Copy baseline summary.
- Mounted-only alerts, badge, toasts, alert log.
- Status section = Compact; page two-column layout.
- `/scope` via background entry.
- Single re-approval, legacy line, rollback runbook, quality and scrub gates.

**CONSIDER (2.1)**
- Follow-this-chat auto-switching.
- Prefill cost curve and heatmap charts.
- ioreg `recoveryCount`.
- A compaction-aware context meter (formula unverified).
- Lowering the floor to 2.0.1.
- `/v2/runtimes` probing of unselected connections.
- The `mount*` UI kit, only where it replaces code 1:1.
- `ready.locale`.
- vllm-mlx `/metrics`; llama router mode.
- Ledger daily roll-ups.
- Deleting the v1 keys.

**ALREADY SOLVED**
- CSP vs `guestFramePolicy` (`panel/index.html:6`).
- Loopback-only credentials (`config.ts:162-170`).
- Concurrency withholding (`telemetry.ts:381-383`).
- Splash Metal memory kept separate from process memory.
- Reproducible ZIP.
- Git-install update detection.
- Allowlisted sharing, append-only compose.
- OpenCode 2 providers ignoring `auth.json` (`config.ts:292`, intentional).

**REJECT**
- The `/api/global/event` SSE.
- `service.surface` as a push channel.
- osascript, powermetrics, sudo.
- Background watcher or notifications; service-written files.
- Token and cost accounting (the host has a Stats view).
- Runtime controls, benchmarks, test inference.
- `lms log stream --stats` / `--source model` (streams chat content).
- `lms` without the no-wake env.
- A panel-only `/scope` resolver.
- Title-generation classification.
- Persisting session tags.
- GPU% as a score or alert; wall-power claims.
- Public prereleases.
- `model`/`conversation` capabilities.
- MTPLX, exo, LocalAI, Jan; OMLX Scope work.

**LEAVE THIS ALONE**
- The patch-only DOM renderer (`main.ts:166-176`) and `Poller` single-flight.
- `traceGeometry` and the 90 s Live window.
- The 1.6 tokens, hero card and segmented tabs; `applyHostReady`; reduced-motion, contrast and forced-colors handling.
- `native-command.ts` (byte-identical).
- The `http.ts` rules: manual redirects, 2 MB cap, 3 s/8 s budgets.
- `parseLocalOrigin`.
- **Never read `~/.config/openchamber/settings.json`.**
- The oMLX normalizer's honesty logic.
- `BoundedLines` at 16 KiB and the `lms` 60 s idle-stop.
- The sanitizer allowlist.
- The `open-mlx-scope` id and the startup fallback in `panel/index.html`.
- `docs/design/mock-shots/`.
- The `MLX_SCOPE_*` dev seams.

---

## 11. Top risks

| Risk | Mitigation |
|---|---|
| False per-chat labels | 7-condition rule; withhold by default; replay handling; coverage condition; "inferred" ⓘ; `attribution.auto` preference; zero-wrong-label beta gate |
| Hidden frames doing work (rail tabs, headless panes, page overlay) | IntersectionObserver gate; background-only resolver; lease limited to visible frames; `display:none` test |
| Storage cost and quota (whole-file rewrite on the OpenChamber server) | S5 read and write measurements; exact accounting; one `set` per flush; zero idle writes; 768 KiB fallback; never evict on error |
| `lms` side effects (relaunch, content) | No-wake env; greeting gate; argv allowlist; `--stats` rejected; Stage H ships the fix now |
| Re-approval friction or a blank extension after update | Frozen set at G1; needs-approval state; git-update rehearsal; legacy line; rollback runbook |
| Refactor regressions (GB → bytes, 35 test files) | Byte-identical 2a goldens; converter tests; round-trips; unit lint |
| Overhead creep (status is ambient) | Glance tier; spawn and CPU budgets; 8 h soak; 0-spawn-after-60 s test |
| Privacy leaks via new paths or committed fixtures | Two-class canaries; one sanitizer; scrub gate; SPIKES and receipts store shapes only |
| Scope size (decisions 11 and 12 keep every extra) | Staged gates; mock gate; per-item slip rule with owner yes |
| Hosted CI locked | Owner fixes billing; local receipts labelled as such; waiver plus manual runbook |

### Critical files
- `service/runtime-client.ts`, `service/lmstudio.ts` and `service/lmstudio-activity.ts` (Stage H; registry, slot and scheduler)
- `src/telemetry.ts` (split into `src/contract/*`; normalizer to `service/adapters/omlx-normalize.ts`)
- `panel/main.ts` (bootstrap only), `panel/saved.ts` (migration source), `panel/insights.ts` (detectors move to the service)
- `package.json`, `scripts/verify-package.ts`, `scripts/measure-overhead.mjs`, `scripts/smoke-service.mjs`,
  `tests/browser/host.html`, `tests/browser/preview.ts`
- Prior art: `~/CodexWork/omlx-scope-openchamber` `origin/work/openchamber-final-pass:panel/reply-capture.ts`

All paths are relative to `~/CodexWork/mlx-scope-splash` unless stated otherwise. Implementation happens on a fresh branch
of `mlx-scope-openchamber`, not in the 1.6 design worktree.

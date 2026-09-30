# MLX Scope 2.0 · Stage 0 spike results

Recorded 2026-09-29 on OpenChamber 2.0.4 desktop (Electron 43.7 / Chromium 150), macOS on an M5 Pro with 48 GB.

**Method**
- The UI spikes used a throwaway folder-installed extension (`scope-spike`, outside this repository). It had a panel, a page, a Work Status section, the `sessions` capability, a slash command with a background entry, and a logging-only service.
- Runtime probes were GET-only. The one exception is the existing oMLX admin login. No inference was sent, and no model or server was loaded, unloaded, started or stopped.
- Every `lms` call carried the no-wake server-info path and an explicit port.
- This file records shapes, counts, timings and key names only.

Status: **GO**, **PARTIAL** (go with the listed fallback), **NO-GO** (replaced), or **PENDING**.

## Platform (S1–S5, S11)

### S1 · Work Status section, statusSection pointing at the panel entry — GO
**Install**
- Manifest `apiVersion 1` + `engines >=2.0.4` + `statusSection` + `commands` + `background` + `sessions` installs, and parses with SDK 2.0.4's `parseManifestJson`.

**Behaviour**
- `ctx.surface === 'status'`.
- `serviceRequest` works from the section.
- `setHeight`: 24, 56 and 112 exact; 400 → 320; 10 → 24.
- The section mounts only while the Work Status popover is open, and it stops polling when the popover closes.
- It is listed in the user's **Panel sections** chooser, where any section (host or extension) can be hidden or dragged. This is how MLX Scope can take Turn stats' place (owner decision 13).

**Mount behaviour**
- One bundle serves every surface. A 41 KB bundle reaches `ready` 1–4 ms after script start, well under the 100 ms split threshold. Keep one bundle.
- A status frame can mount while not visible (IntersectionObserver v1 reports `intersecting:false`). A section scrolled out of view inside the popover also reads not intersecting.

**Visibility gate**
- IntersectionObserver **v1 is reliable**. A hidden rail tab reports `intersecting:false` and a 0×0 rect, yet `document.hidden` stays false and 1.6-style polling continues (confirmed: the hidden spike panel kept pinging every 2 s).
- IntersectionObserver **v2 is unusable**: `isVisible` was `false` even for a visible panel.
- Occlusion by the page overlay therefore cannot be detected in the frame. It is handled by lease priority (the page leads; lower frames back off).

**Other findings**
- `serviceRequest` returns `body` as a **string**; parse it.
- "Expand panel" widens the rail panel; it stays `surface: 'panel'`.
- The full page was not opened: the background automation cannot drive the Extension pages dropdown. This is deferred to Stage 12 real-host qualification.

### S2 · Sessions, lifecycle, workspace activity — the `sessions` capability is DROPPED (owner decision); lag measurement below
**What 11 minutes of normal use showed**
- The owner created seven new chats. Both registered projects kept their session totals, and no session was ever `running` in any project snapshot.
- Sessions in the sidebar's "chats" group belong to no registered project, so `onSessions` cannot see them.
- Every project snapshot is re-sent roughly every 45 s (loading → ready), including all 1,112 records.

**Decision:** the owner approved removing the `sessions` capability.

**Lag measurement.** The owner sent 3 local messages to standalone Splash with the Work Status open. Runtime activity came from Splash `/status` sampled at 2 Hz.
- `started` leads runtime busy by 0.14–0.20 s.
- `completed` coincides with runtime idle within one 0.5 s sample, in all 4 turns.
- A multi-step turn (two runtime requests with a 1.5 s tool pause) keeps `started` across the pause.
- A 3 s background request after the last turn (title/recap generation) happened while the chat was `completed`. The rule correctly treats it as `outside-turn`.
- **Hold time and tolerance: 1 s** (the plan default was 2 s).

**More host behaviour**
- On every busy/idle transition the host re-sends `ready` and then replays `session` and the lifecycle phase. Each transition therefore reaches a frame 2–3 times. Deduplicate on (session id, phase) changes, not on events.
- A frame mounted mid-turn received `started` ×3 as replays. The first turn is therefore `joined-mid-turn`, as designed.
- `onSession().model` = `splish/<publisher>/<model>`. Attribution now relies on the open chat's `onSession` and `onSessionLifecycle` (neither needs a grant), the provider and model match, and runtime active requests ≤ 1.
Verified so far:

**Lifecycle replay**
- `onSessionLifecycle` needs no grant.
- A newly mounted frame receives the current phase **three times** (the first with no previous event, then two repeats). All replays must be ignored: the first event after mount or a session switch, and any repeat of the same phase for the same session.

**Session payloads**
- `onSession` repeats identical payloads many times; deduplicate them.
- `model` for a local provider has the shape `provider/segment/segment` (the modelID itself contains `/`). Match on the last segment, case-folded.

**Workspace data**
- There are 2 projects. One holds 16 sessions, all `idle`. The other holds 1,112 sessions, **all `unknown`**, with `state:'ready'`.
- A rule that withholds whenever *any* session is `unknown` would never label anything. It must consider only sessions updated in the last 24 h and not archived. The spike now logs `unknownRecent` and `archivedUnknown` to size this.
- The 1,112-record snapshot is delivered to each subscribing frame. Subscribe only while auto-labelling is on and the frame is visible (already in the plan).

**Still to measure during real use:** busy/lifecycle lag against runtime activity, `parentId` during subagents, and permission/question waits.

**Host "Turn stats" (built into Work Status)** already shows:
- response and whole-turn tok/s (approximate `~`);
- model and tool time;
- average TTFT;
- tokens in/out, cache %, cost.

MLX Scope's section must beat it with runtime-exact values (decision 13).

### S3 · Badge and toast from a status frame — GO
`setBadge(2)` and `toast(...)` both resolve `ok` from `surface:'status'`, and the badge renders on the rail icon.

### S4 · `/scope` via `background.entry` — GO
- The composer autocompletes the command. Enter selects it; a second Enter routes to `runGuestCommand` and **never** reaches the model.
- The background frame reports `surface:'background'` and `item:null`.
- The resolver answers about 2 ms after script start; the chip appears within about 20 ms with the service warm.
- The chip shows `id` + `title` and has link and remove controls. Remove works.
- After the service was killed, the host respawned it in about 1.2 s, well inside the 20 s deadline.

### S5 · Extension storage — GO (flush policy amended)

| At namespace size | get p50/p95 | keys p50/p95 | set small p50/p95 | set 56 KiB p50/p95 |
|---|---|---|---|---|
| 0.1 MiB | 2.8 / 4.8 ms | 1.6 / 2.1 ms | 2.3 / 2.8 ms | 3.1 / 3.7 ms |
| 1 MiB | 3.1 / 3.8 ms | 2.0 / 2.3 ms | 4.0 / 5.5 ms | 3.7 / 4.2 ms |
| 1.4 MiB | 3.3 / 4.5 ms | 2.3 / 2.8 ms | 4.0 / 4.3 ms | 3.8 / 4.3 ms |

**Limits and errors**
- A 65,536-byte value is accepted. A 65,537-byte value is rejected with the **specific** message "Storage value exceeds 64 KiB."
- Namespace full (reached at about 2,064,384 value bytes) and the 2,000-key limit (reached exactly) both return the **generic** "Storage operation failed. Check extension approval and storage limits." Client-side accounting is required, as planned.

**Concurrency and cost**
- Two concurrent read-modify-writes in one frame lost an update (final value 1). A single writer (the leader) with serialised writes is required.
- OpenChamber server cost is about 3.5 ms CPU per storage operation (8.3 s over about 2,400 ops). The server idled at about 1.7% of one core.

**Amendment:** flush at most every **5 min**, or at 50 pending rows, or on hide or pagehide. The service ring (128 completions per slot) holds rows in between.
- A 1.3 MiB namespace rewritten on every flush is then at most about 370 MiB/day under non-stop activity, and about 125 MiB over a typical 8 h day.

### S11 · Update, re-approval, identity — GO
**While approval is pending**
- Changing a folder install's manifest (version bump plus new exec entries) moves it to **Needs approval** at once. The mounted panel stays up.
- Every `serviceRequest` then fails with `NO_SERVICE: Allow this extension's local service in Settings → Extensions.` Map this to the 2.0 needs-approval state.

**The dialog**
- "review permissions" opens a dialog that re-lists **all** requested capabilities, not only the new ones.
- `sessions` is described as *"List projects, worktrees, and session states. Create and open sessions in any registered project, including new worktrees. Conversation content stays private."* The 2.0 approval copy must say Scope uses only the listing and activity part.
- Exec entries render verbatim, including `~/` paths: "Runs: ~/.lmstudio/bin/lms, /usr/sbin/ioreg". Keep the literal-path exec entries.

**After approval**
- The frames reload by themselves.
- A folder install's **running service is not restarted** by an approval or code change (same process before and after). Git updates stop the service before the swap, per the host documentation. Keep the `contract_mismatch` handling for a stale service.

**Instance and identity**
- Extension id = `panel.id` (the catalog showed `scope-spike`).
- The service environment is `ELECTRON_RUN_AS_NODE, HOME, LANG, LOGNAME, OPENCHAMBER_SERVICE_PORT, OPENCHAMBER_SERVICE_TOKEN, PATH, SHELL, TMPDIR, USER, __CF_USER_TEXT_ENCODING`. There is no `XDG_*` or `OPENCODE_*`.
- **Still open:** how to run an isolated OpenChamber instance for the Stage 12 git-update rehearsal.

## Runtimes (S6–S8)

### S6 · oMLX 0.7 (0.7.0rc1 installed; upstream main is also rc1) — GO
**`/api/status`**
- Accepts the main key **or sub keys** (Bearer or `x-api-key`), and is open with no key on a loopback-only, keyless config.
- Returns 23 keys, among them loaded models, active/waiting, token totals, cache efficiency, prefill/generation tps, and model memory used/max.
- Present in 0.6.4 too. This is the fallback when admin login returns 401/403.

**`/admin/api/usage`**
- Admin session cookie only. Main-key login only; sub keys cannot log in.
- `range` = today|yesterday|7d|30d|90d|month, plus `model` and `include_details`.
- 0.7 only (0.6.4 → 404). Hide the card on 401/404/503.

| Request | Measured size | Synthetic worst case |
|---|---|---|
| 90d, no details | 12 KB | 58 KB (50 models) |
| 90d, `include_details` | 158 KB | 1.09 MB |

- **Amendment:** request `include_details` only for today, yesterday and 7d (worst case about 85 KB). Build 30d and 90d from `daily`/`heatmap`, and cap `models[]` at 50, to stay under the 256,000-char route limit.

**`/admin/api/stats`**
- Carries the plaintext main key as a top-level `api_key`.
- **Amendment: 2.0 stops calling it.** `/api/status` and `/admin/api/activity` cover everything Scope shows. If it is ever called, strip `api_key`, `host`, `port` and `cli_prefix` at parse time (canary fixture).

**`/health`**
- `engine_pool{model_count, loaded_count, final_ceiling, current_model_memory}`, with no auth needed.

**Fixtures:** label them `0.7.0rc1` and re-diff at 0.7.0 final.

### S7 · Splash 1.1 (splish = owner fork, 64 commits past 1.1.0, server code identical) — GO with amendments
There is no version field (`schema_version` is 5 in 1.0–1.1). Detect 1.1 by feature: `vision`, `input_modalities`, `chat_template`.

**`/metrics`**
- 108 series, all matching the source. 11 are typed histograms (`splash_<stage>_seconds`); 96 are untyped flat samples.
- It adds nothing over `/status`, and each read costs a second native status call.
- **Amendment:** read `/status` only, and drop `/metrics`.
- Use native `metrics.ttft_ms` / `itl_ms` `{p50, p95, samples}`, labelled "native, last ≤4,096". The plan's p90 becomes **p95**.
- Per-request HTTP TTFT = Δ`latency.ttft.sum` only when Δ`count` = 1, Δ`requests.completed` = 1, and active ≤ 1 at both reads.

**`/status` → state precedence**
1. `transport.recovering` → Recovering
2. `transport.status_stale` → Status stale
3. `metal.healthy !== true` or `memory_pressure === 'critical'` → Not admitting
4. otherwise → Ready

In 1.1, `ready:false` is never "Loading": the port refuses connections during the initial load.

**Never forward**
- `transport.last_crash_trace` (a filesystem path) and `transport.error` (free text); forward presence as a boolean only.
- `instance.{pid, host, port, id}`, `identity.*`, and any `/v1/responses/*`.

**While `transport.recovering`:** poll `/status` no faster than every 30 s. Polling during recovery takes part in the server's restart retries.

### S7b · llama.cpp llama-server — plan rule NO-GO; replacement rule PARTIAL
**Why the plan's rule fails**
- On every sleep-capable build (b7492 and later), `GET /slots` resets the idle timer and wakes a sleeping server.
- `/metrics` wakes it on b7492–b10518, and is bypassed (cached while sleeping) from b10519.
- Every `/metrics` scrape resets the windowed `*_tokens_seconds` gauges. Use `*_total` deltas instead.
- Router mode: `/metrics`, `/slots` and `/props?model=` auto-load models. Out of scope.

**Replacement rule**
1. `/health` at any cadence (`503` = loading). Bare `/props` every 60 s, keeping a numeric/boolean allowlist.
2. `/metrics` only when `endpoint_metrics === true`, and only on builds ≥ b10519, < b7492, or without `is_sleeping`.
3. `/slots` only on builds ≥ b6337, as a numeric allowlist, at 1 s. On sleep-capable builds, poll it only while the latest `/metrics` shows `requests_processing ≥ 1`, and stop at the first idle read.
4. Without usable `/metrics` on a sleep-capable build, show no live slots ("start with `--metrics`").

**Privacy**
- `generation_prompt` (b8445+) and `LLAMA_SERVER_SLOTS_DEBUG` prompt fields are never read.
- `/props` `model_path` is an absolute path; keep only its last segment.

### S8 · `lms` CLI — GO

| Command | CPU | Max RSS | Bionic server CPU |
|---|---|---|---|
| `lms ps --json --port <internal>` | 0.16 s | about 119 MB | about 6 ms per call |
| `lms runtime ls --port <internal>` | 0.19 s | about 120 MB | about 4 ms per call |

- Both commands accept the hidden `--port`.
- `GET :<rest>/lmstudio-greeting` → `{"lmstudio":true}`.
- `GET /api/v0/models` (spawn-free, about 1.4 ms) reports per-model `state`. **Use it to detect a load/unload generation change**, then refresh `lms ps`.

**Cadence:** `lms ps` on generation change, otherwise every **180 s** on the full tier only; never on the glance tier, never faster than 60 s. `runtime ls` only while the Server tab is visible, cached 10 min.

**Bionic log flags** `logSensitiveData` and `logIncomingTokens` are both false. The parser still drops content lines; a fixture covers this.

## Mac telemetry (S9) — PARTIAL

| Probe | wall p50 / p95 | CPU p50 |
|---|---|---|
| vm_stat | 2.1 / 2.6 ms | 1.1 ms |
| sysctl -i (4 keys) | 2.0 / 2.5 ms | 1.0 ms |
| ioreg IOAccelerator | 18.1 / 18.7 ms | 16.0 ms (46 KB) |
| pmset -g therm | 8.2 / 10.7 ms | 4.7 ms |
| notifyutil -g thermalpressurelevel | 2.6 / 3.0 ms | 1.4 ms |
| lsof (one port) | about 53 ms | about 51 ms |
| footprint (oMLX / Bionic / Splash listener) | 27.5 / 63.6 / 19.6 ms | 24 / 60 / 16 ms |

**ioreg Alloc validation (NO-GO)**
- The only configuration available was Splash alone. There, Alloc was **+34%** against Splash's own current bytes and "In use" was −20%.
- Alloc includes reserved-but-unfilled GPU memory and other apps' memory, so it is not a model-size signal.
- Fallback: show "GPU memory (driver-reported, not model size)", with **no** wired-limit or near-GPU-limit alert driven by it.
- The Metal-limit meter uses only the selected runtime's own reported allocation, labelled as such, and never alerts.

**pmset**
- It recorded nothing now, and nothing over 7 days of `pmset -g log`.
- **G1 decision:** drop `pmset`. Use `/usr/bin/notifyutil -g com.apple.system.thermalpressurelevel` (0 nominal … 4 sleeping, the system thermal pressure level). Its argv is allowlisted to exactly `-g com.apple.system.thermalpressurelevel`.

**footprint**
- Meaningful for **oMLX only**, where the engine runs in the listener process and model memory lands in its footprint.
- Not meaningful for Splash: the engine is a child process and Splash reports its own memory.
- Not meaningful for Bionic: models run outside the app process; not yet confirmed with a model loaded.
- Process-name matching fails across tools (python3.11 / python3 / omlx-server). Instead, re-check the PID and its start time (`ps -o lstart`) before reading the footprint.
- Splash's own `/status instance.pid` is used only in-service, never on the wire.

**Budget**
- The planned idle tier (footprint on oMLX only, 3 lsof @120 s, `lms ps` @180 s) comes to about 0.44% of one core in child CPU.
- Footprint on all listeners, or `lms ps` @60 s, would exceed the +0.5-point budget.

**macmon** (not installed; fields confirmed from source)
- `macmon pipe -i <ms>` emits NDJSON with `cpu_power`, `gpu_power`, `ane_power`, `all_power` (= CPU+GPU+ANE), `sys_power` (SMC estimate, 0 when unavailable), `ram_power`, `gpu_ram_power`, `temp.cpu_temp_avg`/`gpu_temp_avg`, and `gpu_active_ratio`.
- Label: "Chip power (CPU+GPU+ANE, macmon estimate) · includes all apps · not wall power".
- Show `sys_power` only when it is greater than 0.

## Build and overhead (S10, S13)

### S10 · Bun — GO: pin **1.4.2**
- Only Bun 1.4.2 reproduces the committed v1.6.1 bundles byte for byte. 1.3.14 renames minifier identifiers.
- `ci.yml` pins 1.3.14, so the "Verify tracked bundles" step would fail today. That has been hidden by the billing lock.
- Stage 1 sets `packageManager: bun@1.4.2`, `.bun-version`, and `setup-bun` to 1.4.2.

### S13 · 1.6.1 overhead baseline — GO
Measured on a synthetic runtime and Node 22 harness; service CPU is % of one core.

| Phase | Service CPU | Children | Runtime requests |
|---|---|---|---|
| No view | 0.03–0.07% | 0 | 0 |
| Active polling at 500 ms | 0.20–0.43% | vm_stat + sysctl pair every 10 s (about 12 spawns/min) | oMLX about 2.1/s |
| Idle polling at 2 s | 0.07–0.18% | same pair | oMLX about 0.6/s |
| Tail, 60–90 s after the last request | 0 | 0 | 0 |

- Service RSS: cold 53–55 MiB; 79–86 MiB while polling. The live host shows 89–92 MiB under OpenChamber's runtime.
- Each child spawn costs about 0.6–0.7 ms of CPU.

**2.0 budgets**

| Condition | Budget |
|---|---|
| Idle view | ≤ 0.68% of one core |
| Active view | ≤ 1.9% of one core, and ≤ 3% absolute |
| No view | 0 spawns, 0 runtime requests, ≤ 0.07% |
| Service RSS | ≤ 132 MiB under OpenChamber |
| Spawns | ≤ 24/min idle, ≤ 36/min active, ≤ 18/min glance |
| Children | gone ≤ 65 s after the last read |

## G1 · decisions and permission freeze

Owner authority was delegated to the executing agent for this run ("full permission to execute the plan"). Each decision below is listed so the owner can review it.

**Exec (10 entries)**
- `/usr/bin/vm_stat`
- `/usr/sbin/sysctl`
- `/usr/sbin/ioreg`
- `/usr/bin/notifyutil`
- `/usr/sbin/lsof`
- `/usr/bin/footprint`
- `~/.lmstudio/bin/lms`, `~/.cache/lm-studio/bin/lms`
- `/opt/homebrew/bin/macmon`, `/usr/local/bin/macmon`

`pmset` is **not** declared. Each entry's exact argv is allowlisted in code and tested.

**Capabilities:** none. `sessions` was dropped after S2 (owner decision).

**Manifest:** `statusSection` (panel entry) + `commands` (`scope`) + `background.entry` + `page: true`. Engines floor `>=2.0.4`, SDK `2.0.4`.

**Runtime amendments**

| Runtime | Change |
|---|---|
| oMLX | No `/admin/api/stats`; usage details bounded |
| Splash | `/status` only; p50/p95; recovering cadence 30 s |
| llama-server | The S7b rule |
| LM Studio | `/api/v0/models` state for generation change; `lms ps` 180 s |

**Other amendments**
- Storage: 5 min flush policy.
- Telemetry: GPU memory driver-reported only, no GPU-limit alert; thermal via notifyutil.
- The S2 amendments above.

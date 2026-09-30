# MLX Scope 2.0 · module ownership and interfaces

Written by the scaffold track so the parallel tracks code against the same signatures. Every file named here as new
already exists on `mb/scaffold` with these exports and stub bodies; `bun run type-check` passes and nothing new is
wired into a running path, so the 1.6 goldens are unchanged. Authorities, in order: SPIKES G1/S2 amendments, the plan
§4–§8, `docs/design/2.0-contract.md`, the approved mock. Where this file and they differ, they win; tell the scaffold
owner.

## 1. Rules

- **One owner per file.** Only the owner edits it. Anyone else needs a change asks for it in their final answer
  ("interface change request"), unless §5 grants an additive exception.
- **Signatures here are frozen for the parallel phase.** An owner may add exports; changing or removing one listed
  here is an interface change request.
- **Stubs** return empty values (`[]`, `null`, `{}`) where a caller could plausibly reach them, and throw
  `'<name>: not implemented (<track>)'` only where nothing calls them yet. Replace them; keep the export names.
- **Wiring.** `service/main.ts`, `service/runtime-client.ts`, `service/core/compose.ts` and the snapshot branch of
  `service/server.ts` belong to svc-2b; `panel/main.ts` belongs to ui-core. Other tracks expose factories and classes
  and test them in isolation (unit tests, `createScopeServer(token, sources)`); they do not edit those files.
- **Moves (M) keep history** (`git mv`). A stub already sits at a rewrite (R) path so the registry can import it; an
  owner who prefers `git mv` of the 1.6 file replaces the stub with `git mv -f` and keeps the stub's exports.
- **Playwright ports.** `SCOPE_PREVIEW_PORT` (default 8787) moves the preview server, `baseURL` and the
  insecure-storage origin. Suggested: svc-2b 8788, svc-host 8789, svc-history 8790, ad-omlx 8791, ad-splash 8792,
  ad-lmstudio 8793, ad-llama-ollama 8794, attribution 8795, ledger 8796, ui-core 8797, ui-history 8798, scope-flip 8799.
  Example: `SCOPE_PREVIEW_PORT=8797 CI=1 bunx playwright test --project=chromium`.

## 2. Ownership map

Marker: N new (stub on this branch) · R rewrite of a 1.6 file (stub on this branch) · M `git mv` (not created) ·
K kept, edited in place · C contract file (`src/contract/*`).

| Track | Files |
|---|---|
| **svc-2b** | K `service/core/registry.ts` (DESCRIPTORS → `DescriptorV2`, §5.1 probe order), K `service/core/slot.ts`, K `service/core/scheduler.ts`, K `service/runtime-client.ts`, K `service/core/compose.ts`, K `service/server.ts` (snapshot branch, `Sources`), K `service/main.ts`, N `service/core/adapter-v2.ts` (after scaffold), N `service/lib/http-text.ts`, R `service/adapters/vllm-mlx.ts`, R `service/adapters/mlx-lm.ts`, N `panel/present/reasons.ts`, C `snapshot.ts`, `capabilities.ts`, `reasons.ts`, `runtime.ts`, `query.ts`, `convert-v1.ts`, `version.ts`, `guards.ts` |
| **svc-host** | N `service/lib/argv.ts`, R `service/host/sampler.ts` (from `service/system.ts`), R `service/host/memory.ts` (from `service/mac-memory.ts`), N `service/host/gpu.ts`, `thermal.ts`, `footprint.ts`, `power.ts`, C `host.ts` |
| **svc-history** | N `service/history/ring.ts`, `completions.ts`, `alerts.ts`, `usage-cache.ts`, C `trend.ts`, `completion.ts`, `alerts.ts` |
| **ad-omlx** | R `service/adapters/omlx.ts` (from `service/omlx-client.ts`), M `service/adapters/omlx-normalize.ts` (from `src/telemetry.ts:272-657`, verbatim apart from unit renames), N `service/adapters/omlx-usage.ts`, C `usage.ts` |
| **ad-splash** | R `service/adapters/splash.ts` (from `service/splash.ts`; no `splash-metrics.ts`: G1 dropped `/metrics`) |
| **ad-lmstudio** | R `service/adapters/lmstudio.ts`, R `service/adapters/lmstudio-activity.ts`, N `service/adapters/lmstudio-cli.ts` |
| **ad-llama-ollama** | N `service/lib/prometheus.ts`, N `service/adapters/llama-server.ts`, N `service/adapters/ollama.ts` |
| **attribution** | N `panel/attribution/sessions.ts`, `join.ts`, `next-reply.ts`, `turn.ts`, `wire.ts` |
| **ledger** | N `panel/history/ledger.ts`, `ledger-schema.ts`, `accounting.ts`, `migrate-v1.ts`, N `panel/captures/store.ts` (successor of `panel/saved.ts`), N `panel/testing/storage.ts` |
| **ui-core** | K `panel/main.ts` (bootstrap ≤ 250 lines), K `panel/state/scope-state.ts`, K `panel/data/client.ts`, K `panel/data/poller.ts`, K `panel/data/visibility.ts`, K `panel/present/{header,live,server,glance,captures,scope,reading,format,messages}.ts`, N `panel/present/status.ts`, `panel/present/alerts.ts`, N `panel/alerts/signals.ts`, N `panel/render/views/types.ts` and every other `panel/render/views/*` except `history.ts`, K `panel/render/*`, `panel/style.css`, `panel/index.html` |
| **ui-history** | N `panel/data/history.ts`, `panel/history/baselines.ts`, `regress.ts`, `summary.ts`, `panel/present/history.ts`, `panel/render/trend-chart.ts`, `panel/render/views/history.ts` |
| **scope-flip** | K `package.json` (§6 manifest, `files`, build scripts), K `scripts/verify-package.ts`, K `tests/browser/host.html` (2.0.4 emulation), N `panel/share/report.ts`, N `background/main.ts` (+ `background/index.html`), N `ui/tokens.css` (extract `panel/style.css:7-27` unchanged), docs (Stage 11) |

## 3. Service interfaces

### 3.1 Adapter contract and registry descriptor — `service/core/adapter-v2.ts`

```ts
type Tier = 'glance' | 'full';
const DETECT_ORDER = ['/health', '/props', '/api/version', '/lmstudio-greeting', '/status', '/v1/models'] as const;
interface RuntimeReply { status: number; body: Json | null; routeMissing: boolean }   // routeMissing: 200 "Unexpected endpoint" = 404
type RuntimeGet = (path: string) => Promise<RuntimeReply>;
type RuntimeGetText = (path: string, maxBytes?: number) => Promise<{ status: number; text: string }>;
interface ReadContext { deadline: number; tier: Tier; detail: boolean }
type CompletionDraft = Omit<CompletionV2, 'seq' | 'verdict' | 'host'>;
interface AdapterReadingV2 {
  at: number; status: StatusV2; capabilities: Capabilities; runtime: RuntimeV2;
  identity: Pick<ConnectionV2, 'version' | 'engine' | 'host'>;
  generationKey?: string;                    // opaque, never on the wire; a change bumps connection.generation
  completions: CompletionDraft[];            // finished since the previous read, oldest first
}
interface AdapterV2 { read(context: ReadContext): Promise<AdapterReadingV2>; identity(): Promise<boolean>; dispose(): void }
interface AdapterContextV2 {
  connection: { id: string; port: number }; get: RuntimeGet; getText: RuntimeGetText; config: OmlxConfig;
  fetchImpl: FetchImplementation; exec: Exec; now(): number; monotonic(): number; timeoutMs: number; budgetMs: number;
}
interface CadenceContext { activity: boolean; tier: Tier; recovering: boolean }
interface DetectStep { probe: DetectProbe; confidence: Confidence; match(reply: RuntimeReply, follow: RuntimeGet): boolean | Promise<boolean> }
interface DescriptorV2 {
  id: RuntimeKind; hints(id: string, name: string): boolean; detect: readonly DetectStep[];
  cadence(context: CadenceContext): number; capabilities: readonly CapabilityDescriptor[];
  identityEveryMs: number;                   // 60 s; oMLX 300 s
  create(context: AdapterContextV2): AdapterV2;
}
```

Contract for adapters:
- `read` returns a reading, never throws for runtime states it can name (`status` carries them); it throws
  `HttpFailure` only when the runtime cannot be read at all, which the slot turns into `failing`.
- `capabilities` lists exactly the keys the reading fills (P3); `parseSnapshotV2` withholds a value without its key.
- `completions` carry the contract §4 basis for the runtime. oMLX and vllm-mlx emit none: svc-history's `RequestWatch`
  derives `last-observed` ones from successive `runtime.request` readings.
- Nothing class A in any field; model names only in `runtime.*` and completion `model`.

Each adapter file exports its descriptor; svc-2b's `DESCRIPTORS` imports them once they are implemented:

| Export | File | Owner |
|---|---|---|
| `omlxDescriptor` | `service/adapters/omlx.ts` | ad-omlx |
| `splashDescriptor` | `service/adapters/splash.ts` | ad-splash |
| `lmstudioDescriptor` | `service/adapters/lmstudio.ts` | ad-lmstudio |
| `llamaDescriptor`, `ollamaDescriptor` | `service/adapters/llama-server.ts`, `ollama.ts` | ad-llama-ollama |
| `vllmMlxDescriptor`, `mlxLmDescriptor` | `service/adapters/vllm-mlx.ts`, `mlx-lm.ts` | svc-2b |

Adapter helpers (pure, fixture-tested):
- oMLX: `usagePath(range | 'today' | 'yesterday', details): string`, `normalizeOmlxUsage(body, range, now): UsageV2 | null`,
  `unavailableUsage(reason, range, now): UsageV2`, `readOmlxUsage(context, range): Promise<UsageV2>`.
- Splash: `SPLASH_RECOVERING_CACHE_MS = 30_000`, `splashStatus(body): StatusV2`,
  `splashCompletion(before, after, at): CompletionDraft | null` (Δ=1 rule, else `aggregateOf`).
- LM Studio: `modelsGenerationKey(body): string | null`; `parseServerRecord(line, at): ServerLineEvent | null`;
  `createConnectionActivity({ lms, serverInfoPath, now }): ConnectionActivity` (`touch(port)`, `view()`, `dispose()`);
  `parseLmsPs(text): ResidencyV2[]`, `parseRuntimeLs(text): EngineV2[]`,
  `createLmsCli({ exec, lms, serverInfoPath, now }): LmsCli` (`ps(port, generation)`, `runtimeLs(port)`), cadence
  constants `LMS_PS_MIN_MS`, `LMS_PS_EVERY_MS`, `LMS_RUNTIME_CACHE_MS`.
- llama-server: `LLAMA_METRICS`, `parseSlots(body): SlotV2[]`, `slotCompletion(previous, next, at)`,
  `llamaRates(previous, next)`, `llamaSpeculative(previous, next)` (both `PromParse`).
- Ollama: `parseOllamaVersion(body): string | null`, `parseOllamaPs(body): ResidencyV2[]`.

### 3.2 Exec allowlist — `service/lib/argv.ts` (svc-host; implemented)

```ts
const EXEC_PATHS: { vmStat, sysctl, ioreg, notifyutil, lsof, footprint };   // absolute
const LMS_HOME_PATHS = ['.lmstudio/bin/lms', '.cache/lm-studio/bin/lms'];    // under HOME
const MACMON_PATHS = ['/opt/homebrew/bin/macmon', '/usr/local/bin/macmon'];
const IOREG_MAX_BYTES = 128 KiB; MACMON_LINE_BYTES = 16 KiB
interface Argv { file: string; args: readonly string[]; timeoutMs: number; maxBytes: number; env?: Readonly<Record<string, string>> }
type Exec = (argv: Argv) => Promise<string | null>;
loopbackPort(value): number | null; processId(value): number | null;
vmStatArgv(); sysctlArgv(); ioregArgv(); notifyutilArgv();                    // Argv
lsofListenArgv(port); footprintArgv(pid); macmonArgv(macmon);                // Argv | null; footprint = --noCategories -f bytes -p <pid>
lmsArgv(lms, 'ps' | 'runtime-ls' | 'log-stream', port, serverInfoPath): Argv | null   // always --port + LMS_API_SERVER_INFO_PATH
allowed(argv, home): boolean      // exactly the argv the builders produce (file, args, limits, env); lms only under HOME with
                                  // env = { LMS_API_SERVER_INFO_PATH: <abs>/.internal/http-server.json }
createExec(home, read = readCommand): Exec              // the one-shot gate: allowlisted, env-free argv only; else null, no spawn
type StreamChild; type StreamSpawn = (argv: Argv) => StreamChild | null
createStreamSpawn(home, spawn?): StreamSpawn            // the streaming gate (macmon): allowlisted only, no shell, stderr ignored,
                                                        // env {LANG, LC_ALL, ...argv.env}
```

`native-command.ts` stays byte-identical at `service/native-command.ts` (not moved) and passes only `{LANG, LC_ALL}`,
so an `Argv` with `env` (lms) runs through the LM Studio adapter's own bounded spawner, never through `readCommand`; that
spawner must check `allowed(argv, home)` first. `service/lib/argv.test.ts` fails when any service file other than
`lib/argv.ts` and `native-command.ts` imports `node:child_process` (the 1.6 `lmstudio-activity.ts` and `mac-memory.ts` are
named exceptions until their rewrites retire them), and when `main.ts` reaches `mac-memory.ts`.

### 3.3 Prometheus parser — `service/lib/prometheus.ts` (ad-llama-ollama)

```ts
PROMETHEUS_MAX_BYTES = 2 MiB; PROMETHEUS_MAX_SAMPLES = 5_000
interface PromSample { name: string; labels: Readonly<Record<string, string>>; value: number }
interface PromParse { samples: PromSample[]; types: ReadonlyMap<string, PromType>; truncated: boolean }
parsePrometheus(text, { allow(name): boolean; maxBytes?; maxSamples? }): PromParse
sampleValue(parse, name, labels?): number | null
histogram(parse, name): { buckets: [le, count][]; sum; count } | null
```

Label values never reach the wire. Counters ≥ 1e6 arrive in exponent form; token counters move only at request end, so a
Δ of 0 mid-request is "no rate yet", and rates divide by Δ`*_seconds_total`, not wall time (fixture report).

### 3.4 Host telemetry — `service/host/*` (svc-host; implemented)

Fields already in `SnapshotV2.host` (`src/contract/host.ts`), each part with its own `sampledAt`, absent without a reading:
`platform?`, `cpuModel?`, `logicalCores?`, `cpuFraction?`, `memTotalBytes?`, `memUsedBytes?`;
`mac { pressureLevel? 1|2|4, wiredLimitBytes?, swapUsedBytes?, swapTotalBytes?, wiredBytes?, compressedBytes? }`;
`gpu { busyFraction?, allocBytes?, inUseBytes? }` (driver-reported, never an alert);
`thermal { level 0–4 }` (notifyutil); `runtimeProcess { runtime: 'omlx', port, footprintBytes }` (never a PID);
`power { field: 'all_power', chipW, cpuW?, gpuW?, aneW?, sysW?, coverageFraction }` (macmon estimate).

```ts
PROBE_CADENCE = { memory, gpu, thermal, listener, footprint }: [fullIdle, fullActive, glance | null]
SPAWN_BUDGET_PER_MIN = { idle: 24, active: 36, glance: 18 }       // enforced over any 60 s window, whatever tiers read
probeCadence(probe, { tier, active }): number | null; spawnBudget({ tier, active }): number; cpuFraction(previous, current)
interface HostContext { tier: Tier; active: boolean; generation: number; omlxPort: number | null }
class HostSampler { constructor({ exec, now, platform?, home?, monotonic?, macmon?, spawn?, os? });
  sample(context): Promise<HostV2 | null>; energy(from, to): { energyJ, coverage } | null; dispose() }
parseVmStat(out); parseSysctl(out); parseIoreg(out, sampledAt); parseNotifyutil(out); parseLsofPids(out); parseFootprint(out)
parseFootprintReport(out): { name, pid, footprintBytes, peakBytes } | null      // exact `-f bytes` only; name/pid stay in memory
sameProcess(first, next): boolean                                               // the PID-reuse guard (no /bin/ps, see §6)
parseMacmonLine(line, sampledAt); findMacmon(access?): string | null            // a stat of MACMON_PATHS, never a spawn
createPowerStream({ macmon, now, spawn?, idleStopMs?, restartBaseMs? }): PowerStream   // `spawn` replaced the stub's `exec`
  // PowerStream: touch(); view(now): PowerV2 | undefined; energy(from, to): { energyJ, coverage } | null; dispose()
POWER_IDLE_STOP_MS = 60_000; POWER_VIEW_WINDOW_MS = 10_000; POWER_STALE_MS = 3_000; POWER_MIN_COVERAGE = 0.8; POWER_RING = 900
// src/contract/host.ts
hostCapabilities(host: HostV2 | null): CapabilityDescriptor[]   // exactly the parts present; host.power is 'estimate', the rest 'reported'
```

Wiring (additive, reported for svc-2b): `Sources.host?(context: HostContext): Promise<HostV2 | null>` in
`service/server.ts` replaces `Sources.system` (now optional) when present, and runs after the runtime read with
`hostContextOf(query.tier, reading)`: `active` = the reading is busy, `omlxPort` = `meta.port` only while an available oMLX
answered on it. `ReadingMeta.port?` (`service/runtime-client.ts`) is the connection's loopback port (null for a remote
host). `ComposeInput.host?` and `V1Extras.host?` carry the reading to the body; when present the bridge drops the 1.x
`system` host and takes `hostCapabilities(host)`; `hostLive` follows it. `service/main.ts` builds
`new HostSampler({ exec: createExec(homedir()), now: Date.now, home })` and disposes it on stop. svc-history's
`HostCofactors` gets `energyJ`/`powerCoverage` from `HostSampler.energy(startedAt, finishedAt)`.

Behaviour: macOS only (other platforms return the CPU/memory base with no spawn). A glance read never spawns lsof,
footprint or macmon and never extends the macmon idle-stop, but serves their fresh parts. A part outlives failed or
skipped reads for 3× its longest cadence, then it is a gap. lsof runs on a new port or generation, at once after the
listener disappears or fails the reuse guard, else every 120 s; two listening PIDs mean no footprint. macmon is
re-looked-up at most every 5 min while absent.

### 3.5 Service history — `service/history/*` (svc-history)

```ts
// ring.ts
TREND_BUCKET_MS = 2_000; TREND_CAPACITY = 1_800
type TrendSample = Partial<Record<TrendSeries, number>>
trendSample(runtime: RuntimeV2, host: HostV2 | null): TrendSample     // unreported → absent, never 0
class TrendRing { constructor(cadenceMs: () => number); append(at, sample); query({ windowMs, series }, now, marks: TurnMark[]): TrendV2 }
// completions.ts
COMPLETION_RING = 128
class CompletionRing { constructor(instance); get head(); append(draft, host): CompletionV2; since(since, verdict): CompletionsV2 }
class RequestWatch { observe(runtime: RuntimeV2, at): CompletionDraft[]; reset() }       // last-observed detector
class HostCofactors { observe(host: HostV2 | null, at); over(startedAt, finishedAt): CompletionV2['host'] }
// alerts.ts
TOAST_LIMITS = { perMinute: 1, perHour: 3 }
interface AlertInput { at; status: StatusV2; phase: Phase; loadedModels: number | null; host: HostV2 | null; covered: boolean }
class AlertBook { evaluate(input); view(leader, now): { alerts: AlertV2[]; alertLog: AlertLogEntryV2[] } }
class ToastLimiter { allow(now): boolean }
// usage-cache.ts
USAGE_CACHE_MS = 300_000
class UsageCache { constructor(now, ttlMs?); get(query: UsageQuery, read: () => Promise<UsageV2>): Promise<UsageV2> }
```

Routes: `Sources` in `service/server.ts` now has optional `trend?(query: TrendQuery): Promise<TrendV2>` and
`usage?(query: UsageQuery): Promise<UsageV2>`; absent → `501 not_implemented` (today's behaviour), present → `200` body.
svc-history builds those two functions; svc-2b passes them in `service/main.ts` at integration.

### 3.6 What `composeSnapshot` will take (svc-2b, target for svc-host/svc-history)

`composeSnapshot` moves from the 1.x reading to `{ reading: AdapterReadingV2 & { meta: ReadingMeta }, host: HostV2 | null,
completions: CompletionsV2, alerts: { alerts, alertLog }, service, serverNow, lease, marksHead, query }`. `compat`
stays on the wire until ui-core stops reading it (contract §11.1); ui-core deletes the `compat` reads, then svc-2b
deletes `CompatV1`.

### 3.7 As built by svc-2b (Stage 2b)

```ts
// service/core/registry.ts
descriptorsWith({ activity(port) }): readonly DescriptorV2[]   // the list; DESCRIPTORS = descriptorsWith({ activity: () => null })
descriptorOf(descriptors, runtime): DescriptorV2 | null
detect(descriptors, get, hinted?): Promise<Detection | { runtime: null; locked: boolean }>   // throws HttpFailure when a GET cannot complete
// service/core/legacy.ts (bridge, deleted as tracks land): legacyOmlx, legacyLMStudio(extras), legacySplash
// service/runtime-client.ts
interface ReadSelection { provider?: string; runtime?: RuntimeKind | null }; interface ReadRequest { tier: Tier; detail: boolean }
interface CompletionSink { head; append(draft, host): CompletionV2; since(since, verdict): CompletionsV2 }   // CompletionRing fits
type RuntimeReading = AdapterReadingV2 & { meta: { connection: ConnectionV2; port; slot; failures; idleMs; completions: CompletionSink | null; compat: CompatV1 } }
new RuntimeClient({ fetchImpl?, readConfig?, now?, monotonicNow?, lmstudioActivity?, descriptors?, exec?, instance?, completions?(instance, next) })
  .read(selection?, request?): Promise<RuntimeReading>; .completionHead; .dispose()
// service/server.ts
type Sources = { read(selection?, request?); host?(context: HostContext): Promise<HostV2 | null>; system?() /* 1.x fallback */; completionHead?();
  alerts?({ reading, host, leader, now }): { alerts; alertLog }; trend?; usage? }
// service/core/compose.ts
composeSnapshot({ reading, host, completions, alerts, service, serverNow, lease, marksHead, query }); hostCapabilities(host)
// service/lib/http-text.ts
requestText({ url, fetchImpl, timeoutMs?, maxBytes?, init? }): { status, text }; requestReply(...): RuntimeReply; isRouteMissingBody(body)
// src/contract/convert-v1.ts (bridge): v1Parts(v1): V1Parts; hostFromV1(system): HostV2 | null
```

Wiring for the integrator: `RuntimeGet` returns every status (it throws only when a GET cannot complete) and sends the key to
every path but `/health`; paths must be origin-relative. `AdapterReadingV2.completions` are appended to the slot's sink once
per fresh reading; `generationKey` changes bump `connection.generation`. Swap `legacy*` for the ad-* descriptors in
`descriptorsWith`, pass svc-host's exec and `HostSampler.sample` (`Sources.host`), svc-history's `CompletionRing` (as
`completions`), `RequestWatch` (last-observed drafts for oMLX and vllm-mlx) and `AlertBook` (`Sources.alerts`).

## 4. Panel interfaces

### 4.1 Wire query encoding (scaffold, in `src/contract/query.ts`)

`serviceRequest` takes `query: Record<string, string>` (SDK 2.0.4), so repeated parameters cannot be sent. `mark` and
`attr` are **one comma-joined value**; the parser also still accepts repeated parameters; caps count items.

```ts
encodeMarks(marks: SnapshotQuery['marks']): string | undefined   // 'started.1790690700000.deadbeef,completed.…', ≤ MAX_MARKS (4), newest kept
encodeAttrs(attrs: SnapshotQuery['attrs']): string | undefined   // '58.withheld.several-chats,59.inferred.-', ≤ MAX_ATTRS (8)
```

`panel/data/client.ts` `SnapshotQuery` gained optional `tier` (default `full`), `detail`, `mark`, `attr` (pre-encoded).

### 4.2 Attribution — `panel/attribution/*` (attribution)

```ts
// sessions.ts
LIFECYCLE_HOLD_MS = 1_000
interface TurnWindow { tag: string; startedAt: number | null; endedAt: number | null; outcome: 'completed' | 'failure' | null }
interface FrameSessionState { connected: boolean; chat: { tag; provider: string | null; model: string | null; busy } | null; windows: readonly TurnWindow[] }
class SessionFeed { constructor(host: Pick<HostClient, 'onSession' | 'onSessionLifecycle'>, now, instance: () => string | null);
  state(): FrameSessionState; drainMarks(): SnapshotQuery['marks']; onChange(listener): () => void; dispose() }
// join.ts
CLOCK_TOLERANCE_MS = 1_500
type JoinVerdict = { attr: 'inferred' } | { attr: 'withheld'; reason: WithholdReason }
type AttributionLabel = { kind: 'inferred' } | { kind: 'armed' } | { kind: 'server-wide'; reason: WithholdReason | 'all-requests' | 'not-observed' }
interface JoinContext { connection: { id; runtime; model }; canCount: boolean; covered(from, to): boolean; auto: boolean }
join(completion: CompletionV2, frame: FrameSessionState, context: JoinContext): JoinVerdict
sameModel(chat, runtime): boolean; labelOf(completion): AttributionLabel
// next-reply.ts
REPLY_WAIT_MS = 120_000; REPLY_LIMIT_MS = 600_000
class NextReply { get state(): NextReplyState; arm(now, frame, context); observe(completions, frame, now); cancel(reason); drainAttrs() }
// turn.ts
interface TurnSummary { wallMs; modelMs; toolMs; steps; firstTtftMs; promptTokens; cachedTokens; outputTokens; decodeTps; cacheFraction }
summarizeTurn(window: TurnWindow, steps: readonly CompletionV2[]): TurnSummary | null
// wire.ts
class WireQueue { mark(items); attr(items); query(): { mark?: string; attr?: string }; acknowledge() }
```

Session ids and titles never leave `sessions.ts`: the tag is `tag8(id, service.instance)` (`src/contract/hash.ts`).
S2 rules: ignore lifecycle replays (×3 on mount and switch), dedupe on (session, phase) changes, 1 s hold; no
`sessions` capability, so the "several chats / subagent" reasons are never produced.

### 4.3 Ledger store — `panel/history/*`, `panel/captures/store.ts` (ledger)

```ts
// ledger-schema.ts
KEYS = { meta: 'meta.v2', pref: 'pref.v2', models: 'ledger.v2.models', chunkPrefix: 'ledger.v2.c.', baseline: 'baseline.v2',
         capturePrefix: 'capture.v2.', legacyObservationPrefix: 'observation.v1.' }
CHUNK_TARGET_CHARS = 56 KiB; CHUNK_MAX_CHARS = 60 KiB
type SizeBucket = 0 | 1 | 2 | 3 | 4                       // <8k, 8–32k, 32–64k, 64–128k, >128k tokens
type LedgerAttr = 'inferred' | 'armed' | `withheld:${WithholdReason}` | 'not-observed'
type ReplyRow = ['r', finishedS, rt, modelRef, ctxB, uncB, prompt, cached, output, ttftMs, prefillTps10, decodeTps10, basis, attr, turnRef, cofactors, energyJ10, id]
type TurnRow  = ['t', startedS, endedS, rt, modelRef, steps, output, firstTtftMs, wDecodeTps10, waitMs, attr, cofactors]
type GapRow   = ['g', fromS, toS]
sizeBucket(tokens); chunkKey(startS, rand4); parseRow(value): LedgerRow | null
// accounting.ts
STORAGE_LIMITS = { valueBytes: 64 KiB, totalBytes: 2 MiB, keys: 2_000 }; LEDGER_CAP_BYTES = 1_280 KiB; HEADROOM_BYTES = 128 KiB
entryBytes(key, value); class Accounting { recompute(entries); apply(key, before, after); fits(bytes) }
// ledger.ts
FLUSH_EVERY_MS = 300_000; FLUSH_ROWS = 50; HIDE_FLUSH_GAP_MS = 10_000; RETENTION_DAYS = { default: 30, max: 90 }
class Ledger { constructor({ storage, now, retentionDays? }); state; firstRun; start(); append(completions, label); appendTurn(row);
  due(reason, now); flush(reason); read(fromS?, toS?); models(); accounting(); setRetention(days); setPaused(paused); clear(); dispose() }
// migrate-v1.ts: captureFromObservation(value): CaptureV2 | null; migrateV1(storage, now): Promise<MigrationResult>
// captures/store.ts: CAPTURE_LIMIT = 12; interface CaptureV2; class CaptureStore { list(); save(capture); remove(key) }
// testing/storage.ts: createFakeStorage({ reject? }) → host.storage + stats() + dump()   (shared by every panel track)
```

Only the leader calls `start`, `append`, `flush` (`snapshot.lease.leader`); a handover restarts from the persisted
cursor. `id = ${instance}.${seq}` is the (instance, seq) dedupe key; no session tag is stored.

### 4.4 Baselines, regressions, history fetch — ui-history

```ts
// history/baselines.ts
BASELINE_WINDOW_MS = 14 d; BASELINE_VALUES = 50; BASELINE_EXCLUDE_RECENT_MS = 30 min
type BaselineMetric = 'decodeTps' | 'prefillTps' | 'ttftMs' | 'tokPerJ'
interface BaselineKey { rt: RuntimeKind; modelRef: number; bucket: SizeBucket }
interface Baseline { p50: number | null; p90: number | null; n: number }
type Baselines = ReadonlyMap<string, Baseline>;  interface BaselineStoreV2 { v: 2; computedAt; entries }
baselineKey(metric, key); buildBaselines(rows: ReplyRow[], now): Baselines; baselineFor(baselines, metric, key)
// history/regress.ts
interface RegressionFlag { metric; key; recentMedian; p50; n; since; cofactors }
interface VsUsual { metric; ratio; n; basis: 'reported' | 'estimate' }
evaluateRegression(recent, baselines, now, previous): RegressionFlag[]; vsUsual(row, baselines, metric): VsUsual | null
// history/summary.ts: SUMMARY_MAX_CHARS = 32_000; baselineSummary(baselines, models, version, now): string
// data/history.ts
type HistoryResult<T> = { ok: true; body: T } | { ok: false; reason: FrameReason | 'unparseable' | 'not_served' }
trendQuery(request): Record<string, string>; usageQuery(request): Record<string, string>
class HistoryClient { constructor(host: Pick<HostClient, 'serviceRequest'>); trend(request): Promise<HistoryResult<TrendV2>>; usage(request): Promise<HistoryResult<UsageV2>> }
// present/history.ts: presentHistory(input: HistoryInput): HistoryView
// render/trend-chart.ts: trendGeometry(trend, series, width?, height?): TrendGeometry | null
// render/views/history.ts: mountHistory: MountView
```

### 4.5 Alerts, status section, views, reasons, sanitizer

```ts
// alerts/signals.ts (ui-core)
type ToastPreference = 'critical' | 'all' | 'off'
badgeCount(alerts): number; toastFor(alert, preference): ToastRequest | null
class Signals { constructor(host: Pick<HostClient, 'setBadge' | 'toast'>, preference: () => ToastPreference);
  apply(snapshot: SnapshotV2, flags: readonly RegressionFlag[]); panelMounted(); dispose() }   // leader only; toast once per toastSeq
// present/alerts.ts (ui-core): presentAlerts(alerts, log, now): AlertsView
// present/status.ts (ui-core)
interface StatusSectionInput { now; reading: Reading; snapshot: SnapshotV2 | null; attribution: AttributionLabel;
  turn: TurnSummary | null; vsUsual: VsUsual | null; sparkline: TrendV2 | null; chatIsLocal: boolean | null;
  expanded: boolean; tipDismissed: boolean }
interface StatusSectionView { mode: 'glance' | 'turn-stats' | 'non-local'; height; line1; line2; rows: StatusRow[]; tip }
presentStatusSection(input): StatusSectionView        // heights 24 / 56 / 80 / ≤ 200
// render/views/types.ts (ui-core)
type Tab = 'live' | 'server' | 'history' | 'captures'
interface ViewContext { host; surface; now(); visible(); leader() }; interface ViewHandle { update(snapshot | null); dispose() }
type MountView = (root: HTMLElement, context: ViewContext) => ViewHandle
// present/reasons.ts (svc-2b): statusMessage(reason, params, runtime, context?); statusCopy(...) → { severity, title, detail, action? };
//   frameMessage(reason); withholdMessage(reason | 'all-requests', chatRuntime); WITHHOLD_PHRASES;
//   alertMessage(id, params); alertCopy(id, params) → { title, detail }   (model-unloaded names the model: in-view only)
// share/report.ts (scope-flip; redact/clamp/toastText/scopeItem implemented, scopeText stub)
TOAST_MAX_CHARS = 500; SCOPE_TEXT_MAX_CHARS = 16_000; SCOPE_HEADER
redact(text, forbidden); clamp(text, max); toastText(text, forbidden); scopeText(input): string; scopeItem(text, readmeUrl): AttachIssueRequest
// background/main.ts (scope-flip): resolveScope(host, request): Promise<AttachIssueRequest | null>
```

## 5. Shared files with additive exceptions

| File | Owner | Others may |
|---|---|---|
| `src/contract/snapshot.ts` | svc-2b | ad-llama-ollama adds `SlotV2`/`rates`/`speculative` fields; ad-lmstudio `EngineV2`/`ResidencyV2.source`; ad-splash `CatalogV2`. Additive only, with the parser and `HONESTY` row in the same commit. |
| `src/contract/reasons.ts` | svc-2b | Adapter tracks add a `StatusReason` with its `STATUS_PARAMS` allowlist. |
| `service/server.ts` | svc-2b | svc-history: none needed (use `Sources.trend` / `Sources.usage`). |
| `docs/design/2.0-contract.md` | svc-2b | Any track appends its amendment under a new "§12.x" heading. |
| `docs/2.0/INTERFACES.md` | scaffold | Owners update their own section when they add exports. |

## 6. Scaffold decisions and open issues

Decided here (listed in contract §12):
1. **`mark`/`attr` as comma lists** (§4.1). The SDK's `query` is `Record<string, string>`.
2. **`CatalogV2.inputModalities` accepts `'pdf'`**: Splash 1.1 reports it (fixture report).
3. **`native-command.ts` and `http.ts` stay where they are.** The plan's `lib/` moves would only add churn to the
   byte-identical file; the new text helpers live in `service/lib/http-text.ts`.
4. **`background/` is type-checked and scanned** (`tsconfig.json` include, `scan-committed.ts` roots); it is not
   bundled or declared yet (scope-flip).

Open, for the named track:
- **svc-host (resolved, for owner review):** `/bin/ps` stays outside the G1 exec freeze. A `ps -o lstart=` or an extra
  `lsof` before every footprint read would also break the active budget (31.5 → 37.5 spawns/min > 36). The reuse guard
  instead compares each `footprint --noCategories -f bytes` report with the first one after the lsof lookup: same PID, same
  process name, and a lifetime peak (`phys_footprint_peak`) that never shrinks. A reused PID starts a new peak. Adding
  `/bin/ps` later is one manifest entry plus a `psArgv` builder; the `ps.*` fixtures stay for that.
- **ad-omlx:** `/admin/api/usage` has `daily` only with `include_details`, so 30d/90d have no per-day request counts;
  `UsageV2.buckets[].requests` is required today. Propose the contract change (optional `requests`, or token-only
  buckets) with the parser. 1.6's health check rejects a healthy `engine_pool: null` body. `cache_efficiency` is a
  percent in `/api/status` but a ratio in usage.
- **ad-splash:** `metal.failure_reason` is free text (canary planted); treat it like `transport.error` (presence only).
  Counters reset on engine restart (a negative Δ is a reset, not a completion); walk histogram buckets by bound.
- **ad-lmstudio:** the 1.6 parser (`lmstudio-activity.ts:72`) accepts a fake `Done ·` inside generated text; stock
  LM Studio prints no `Done ·` line, so its completions exist only on Splash-engine Bionic.
- **ad-llama-ollama:** b10519 clears an idle slot's `n_decoded`; keep the last busy read. Windowed gauges differ by
  build (b10519 reads 0 mid-request, b6700 never resets): never use them for rates.
- **attribution:** `SessionSnapshot.model` format for local providers decides `sameModel`; the ⓘ must carry "Another chat
  alternating requests on the same runtime during this turn can't be ruled out."
- **ui-core / svc-2b:** `compat` removal order (§3.6). `snapshotQuery` still sends `tier=full` unless told otherwise;
  the status surface must pass `tier: 'glance'`.
- **scope-flip:** `ui/tokens.css` (a Stage 1 item) was never extracted; `background/index.html`, build script, `files`,
  bundle ceilings and the two-way exec match are all still to do.

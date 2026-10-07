# Metric reference

MLX Scope shows only what a runtime or the Mac reports. A reading the runtime can't provide is **left out**: no dash,
no zero, no "not reported" cell. Unknown is not zero, and idle time is a gap in a chart, never a zero. Runtime readings
describe the selected server, not a selected chat, unless a reply is labelled "This chat · inferred" or "Next reply ·
armed".

## Units

| Unit | Meaning |
| --- | --- |
| Memory | Integer bytes on the wire; displayed in **GiB** (1,024³ bytes). There is no decimal GB anywhere |
| Time | Milliseconds on the wire; displayed as ms or seconds |
| Speed | Tokens per second (tok/s) |
| Fractions | 0–1 on the wire; displayed as percentages |
| Power | Watts (W); energy in joules (J) |
| Context size | Exact token counts in views; `/scope` and the reply history use ranges: under 8k, 8k–32k, 32k–64k, 64k–128k, over 128k |

## Basis

Every value records how it was obtained. Anything that is not **reported** says so in the view (as a muted suffix or in
an ⓘ), in reports and in `/scope`.

| Basis | Meaning |
| --- | --- |
| reported | The runtime or macOS reports this value directly |
| derived | Computed from reported counters, for example tokens divided by the runtime's own seconds counter |
| observed | Measured by Scope from successive samples, for example a llama-server slot's decoded tokens over time |
| last observed | The last value Scope saw before a request disappeared (oMLX, vllm-mlx); a completed request's final figures may differ |
| estimate | A model of a quantity, not a measurement: a runtime's prefill stage estimate, macmon chip power, tokens per joule |

How a finished reply is detected, per runtime:

| Runtime | Completion signal | Basis |
| --- | --- | --- |
| Bionic (Splash engine) | The server log's `Done ·` line | reported |
| oMLX, vllm-mlx | The request disappears | last observed |
| Splash (standalone) | Completed counter rises by exactly one, with nothing else active or queued | derived |
| llama-server | The only busy slot goes idle | observed |

A step of Splash's counter that covers several requests is recorded once, marked as covering several; per-request
figures are not assigned to any of them. Ollama and mlx-lm report no completions.

## Capabilities

Each connection declares what it can report. A value appears only with its capability, and a test enforces that no
value travels without one.

| Capability | Readings |
| --- | --- |
| Request decode / prefill rate | Speed of the one active request |
| Request prefill progress / estimate | Current-stage progress, and the runtime's stage estimate |
| Request TTFT, tokens, elapsed, context | Time to first token, prompt/cached/output tokens, elapsed time, context used and limit |
| Server requests | Active and queued counts; `null` means the runtime cannot count, and nothing is shown |
| Server averages | Session averages since start: decode, prefill, cache efficiency, request totals, uptime |
| Server latency | Native first-token and inter-token p50/p95 with sample counts (Splash) |
| Server rates / speculative | Splish/Splash recent prefill and generation throughput; llama-server prompt/decode rates and draft acceptance, over a stated window |
| Server memory (process, model, Metal, ceiling) | Each kept separate; never added together |
| Server residency, slots, catalog, engines | Loaded models, llama-server slots, available models, `lms runtime ls` engines |
| Server usage | oMLX's own 7/30/90-day records |
| Server completions | Finished replies, with their basis |
| Host CPU, memory, swap, pressure, wired limit | macOS host readings |
| Host GPU busy, GPU memory | Driver-reported (`ioreg`) |
| Host thermal, footprint, power | Thermal pressure, the oMLX process footprint, macmon chip power |

## Readings

| Reading | Meaning |
| --- | --- |
| Generation speed | Reported per-request speed, only for identifiable, fresh work |
| Recent output | Observed output-token increments divided by sampled wall time; not a runtime request average |
| Prefill remaining | Reported current-stage work remaining; oMLX counts or a supported vllm-mlx fraction |
| Reported estimate | A runtime's estimate for the current prefill stage, not time until an answer |
| Input reused | Request-matched cached tokens divided by reported prompt tokens |
| Context used | Reported prompt plus output tokens against the reported model limit; not OpenCode's compaction threshold |
| Active / queued | Reported server counts; oMLX queue overlap is removed only when proven |
| CPU | Change in non-idle host CPU time across all logical cores between observations |
| Non-free RAM | Physical memory minus OS-reported free memory; includes reclaimable pages; not memory pressure |
| Wired / compressed | Physical pages reported by `vm_stat`, using its reported page size |
| Swap | Current `sysctl vm.swapusage` value |
| Memory pressure | The kernel's level from `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical. Other values are left out |
| GPU wired-memory limit | `iogpu.wired_limit_mb`; left out when it is 0 (not set) |
| GPU busy | Device utilization as the graphics driver reports it. Shown in the Mac card only; never a score, a headline or an alert |
| GPU memory | Allocated and in-use system memory as the graphics driver reports it. It includes other apps and reserved memory, so it is **not model size**, and no alert uses it |
| Thermal pressure | macOS thermal pressure level from `notifyutil`: nominal, moderate, heavy, trapping, sleeping. Warns from heavy |
| oMLX process footprint | `footprint` of the process listening on the oMLX port; the process ID never leaves the service |
| Model allocation | Reported model allocation, separate from process footprint |
| RAM / SSD cache | Reported server cache sizes, kept separate from model allocation |
| Splish/Splash recent generation speed | 1,000 × change in native output tokens / change in native decode-command milliseconds, across a rolling observation window of up to five seconds (derived). At least three valid samples spanning two seconds are required; the actual interval is shown in the full view or tooltip. Combined server throughput across all requests, excluding draft candidates |
| Splish/Splash recent prefill speed | 1,000 × change in native processed input tokens / change in native prefill-command milliseconds, using the same qualification rules and an independent observation interval (derived). Combined prompt-processing throughput across all requests; it is not whole-request progress or a cache-reuse percentage |
| Splash average since engine start | Native lifetime aggregate since engine start, shown separately in Server & Mac details and copied diagnostics |
| Splash completed / failed | Native counters since engine start; reset on engine restart |
| Splash Metal allocation | Current and peak Metal allocator values; not process RSS or model-only memory |
| Splash latency | Splash's own first-token and inter-token p50/p95 with the sample count; not Scope's measurement |
| llama-server slot speed | Observed decoded-token change of the single busy slot; withheld with two or more busy slots |
| llama-server rates | Token counters divided by the server's own seconds counters over the stated window (derived). The counters move only when a request completes, so a zero change mid-request is "no rate yet" |
| Ollama GPU-resident size | Ollama's `size_vram`, shown as "GPU-resident (Ollama-reported)" |
| Runtime memory guard | oMLX guard state, not macOS memory pressure |
| Chip power | macmon's `all_power` field: CPU+GPU+ANE, an **estimate** that includes all apps and is not wall power. Absent without macmon |
| Tokens per joule (tok/J) | Output tokens per joule of chip power, equal to tok/s per W. Computed only during decode with one active request and power coverage of at least 80%; an estimate with its own separate baseline |

When reported, Live shows the runtime process footprint and model allocation beside whole-host memory. These are
server-wide readings, can overlap, and must not be added together or attributed to a chat. Compressed memory means
physical pages occupied by the compressor, not the logical uncompressed size.

## Runtime coverage

LM Studio reports model inventory and loaded-instance context limits. mlx-lm reports available model files without
residency. Ollama reports residency only. These views retain host resources while leaving live request metrics out. A
model file's size is not process RAM, and a configured context limit is not remaining context.

vllm-mlx per-request speed is withheld until output counters advance and again when they stop advancing for five
seconds. Its top-level speed is omitted because backend meanings differ. Only batched MLLM prefill fractions strictly
between zero and one are usable. LLM output-limit progress never becomes prefill. Reuse requires the text batched
engine, a recognized cache classification, and valid request-matched counts. Metal allocator values never become a
process footprint. See [Compatibility](COMPATIBILITY.md).

## oMLX prefill

Processed and total counters belong to the current runtime stage. Cached prefix reuse is separate and is not subtracted
from the total a second time. Staged or speculative prefill can change the stage total; the fraction is not
whole-request completion. Unfinished work below one percent remaining displays `<1%`, never a premature zero.

An unchanged stage counter is labelled **Waiting for progress** after 15 seconds. The last percentage may remain visible
as a held reading, but live speed and estimate are withheld. A valid stage estimate comes from `prefilling[].eta`
alongside consistent processed/total counters and positive reported speed. It is rounded up and only changes with a new
observation. Paused, stale, malformed, completed, and ambiguous stages have no estimate. There is no synthetic countdown.

## Recent output and oMLX DFlash

Recent output uses at most ten seconds of observed output counters, requiring three samples spanning at least two
seconds. It resets on request/model changes, backwards counters or clocks, missing identity, stale output, and monitoring
gaps. The chart never joins observed rates to reported averages as one continuous trace. Primary DFlash reports accepted
output through generic activity counters; its total activity elapsed time also includes preparation, so it is not a
request-average generation duration. Speculation summaries and acceptance totals are not assigned to a live request.

## Context, reuse, and concurrency

Prompt plus output is compared with the reported model context limit. During prefill, output is zero for this
calculation. Reused tokens still occupy context and are not subtracted again. Missing or inconsistent counts suppress
the reading. This is neither a reserved output/reasoning budget nor an allocation guarantee.

Single-request headline speed and progress are withheld during ambiguous concurrency. The loaded-model roster can show a
model's single-request readings when that model's counters are identifiable. A combined server rate is not fabricated
from several requests. Distributed rank summaries do not establish request identity.

## Trends and freshness

Splish/Splash's recent **Prefill** and **Generation** speeds each use the oldest and newest eligible counter samples
within five seconds of the latest sample. They do not average individual batch rates. The “last 2–5 s” interval in
the full view or tooltip is the span between observations; the rate's divisor is accumulated native command time for
that stage. The intervals can differ. This engine measurement does not establish
when tokens arrive in OpenChamber. Independently sampled monitors may report different rates when their windows cover
different work.

Only fresh, ready, active native work can produce a recent rate, and the newest pair must advance both the stage's
tokens and command time. Prefill requires active prompt processing; generation requires active decoding or pending
decode-mask work. A missing rate shows a short waiting state, never a lifetime or
retained-rate fallback. Idle, stale/malformed data, recovery, disconnect, backwards counters/clocks, endpoint/model/engine
changes, monitoring pause, and gaps longer than five seconds reset the window. Hidden or energy-saving monitoring with
longer intervals cannot sustain a recent rate; resuming collects a new baseline. Prompt processing alone does not imply
active decoding. Concurrent decode work is combined server throughput.

The Splash Live chart shows these recent engine readings, each over up to five seconds. Completed-reply measurements,
reply baselines, historical records, and the runtime's average since engine start retain their separate meanings.

Live keeps a 90-second window. History charts the last 15, 30 or 60 minutes from the service's in-memory trend (2-second
samples, 180 buckets of minimum, maximum and last). A bucket with no reading is empty, never zero, and stretches when no
Scope view was open are hatched "Not observed · Scope wasn't open". Nothing is interpolated. Turn start and finish ticks
come from OpenChamber's turn events. Charts appear after two samples.

A view marks its reading stale when no fresh observation arrives within six seconds, or twice its poll interval plus one
second when that is longer. Hidden and paused views stop polling. Restoring a view waits for a fresh reading before
showing live throughput.

## Per-chat labels

A reply is "This chat · inferred" only when the open chat uses the watched connection and model, the runtime counted at
most one active request at every sample, the reply lies inside a turn Scope saw start and finish, its samples have no
gap, and auto-labelling is on. Everything else is "Server-wide" with one reason (another provider, a different model,
concurrency, outside the turn, joined mid-turn, not observed, auto-labelling off). "Next reply · armed" applies the same
per-request rule to each step of the armed reply. A turn summary (wall time minus waits, steps, first-step TTFT, total
output, token-weighted decode rate, cache reuse) appears only when every step is attributed.

## Baselines and "vs usual"

Baselines come from the local reply history of the last 14 days, the last 50 values per key, excluding the current 30
minutes. Decode speed is keyed by runtime, model and context range; prefill speed and time to first token by runtime,
model and uncached-input range. Replies that covered several requests, overlapped another request, or carry an
estimate are excluded from per-request baselines, and last-observed replies from time-to-first-token baselines. The
median (p50) needs at least 5 values and p90 at least 10; both are always shown with their sample count *n*. A single
reply gets a "vs usual" ratio. "Slower than usual" flags when the median of the last three replies within 30 minutes is
at most 0.85× the usual rate, or at least 1.25× the usual time to first token, and clears within 10%. Conditions present
during those replies (pressure, swap growth, thermal pressure) are listed as "observed during", never as causes.

## Captures

A 30/60-second capture consumes existing snapshots and never starts inference. Monitoring keeps running while a capture
records. A request capture begins with one identifiable active model. Inventory-only connections capture host resources
without a generation rate or request-count change. The capture closes at its target window and retains the duration
actually observed. Manual stop, pause, hidden view, lost connection, concurrency, changed model, clock reversal, or a gap
over 12 seconds leaves a labelled partial observation.

Observed generation rate is summed token increments divided by the duration of valid adjacent generation intervals. At
least two seconds are required for a rate. Reported request averages are not mixed into this calculation. Resource means
use distinct host samples, without time weighting. None of these values establishes a lifetime peak, exclusive request
usage, or GPU memory. Percentage comparison with a pinned reference requires the same model and at least five seconds of
observed generation in each window; differences are descriptive, not causal.

Saved captures are user-triggered, timestamped, and sanitized. OpenChamber extension storage retains the 12 newest.
They contain measurements without model names, request identifiers, credentials, chat content, or private paths.

## Standalone Splash prompt progress

The optional OpenCode companion reads Splash's supported `prompt_progress` stream messages from existing replies.
`processed / total` is whole-prompt completion, including the `cache` portion; it is separate from prefill speed and
cache reuse. The companion enables `return_progress: true` on eligible streaming requests without changing the route
or starting another request. See [companion setup](../bridge/opencode/README.md).

Scope publishes a percentage only with a fresh ready Splash status, one active request reading its prompt, and one
matching primary response record for the configured provider, endpoint and model. Other response kinds participate
in ambiguity checks but are not shown as the main prompt. Cached progress stays usable for 15 seconds; after six
seconds without a newer event it is labelled as the last reading. Progress never advances on a timer. Generation,
recovery, a connection or server identity change, contradictory counts, and expired records clear it. Pause and resume
require a newer event before displaying progress again. Near-complete unfinished values stay below 100%.

The existing oMLX percentage remains the current reported stage. Scope does not pretend staged oMLX counts and Splash's
whole-prompt counts have the same denominator.

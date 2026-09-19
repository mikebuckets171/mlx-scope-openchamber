# Metric reference

Missing, unsupported, or contradictory measurements display `—`. Unknown is not
zero. Runtime measurements describe the selected server, not a selected chat.
Memory is displayed in **GiB** (1,024³ bytes).

| Reading | Meaning |
| --- | --- |
| Generation speed | Reported per-request speed from oMLX or vllm-mlx, only for identifiable, fresh work |
| Recent output | Observed output-token increments divided by sampled wall time; not a runtime request average |
| Prefill remaining | Reported current-stage work remaining; oMLX counts or a supported vllm-mlx fraction |
| Reported estimate | oMLX’s estimate for the current prefill stage, not time until an answer |
| Input reused | Request-matched cached tokens divided by reported prompt tokens |
| Context headroom | Reported model limit minus prompt and output tokens; not OpenCode’s compaction threshold |
| Active / queued | Reported server counts; oMLX queue overlap is removed only when proven |
| CPU | Change in non-idle host CPU time across all logical cores between observations |
| Non-free RAM | Physical memory minus OS-reported free memory; includes reclaimable pages |
| Wired / compressed | Physical pages reported by `vm_stat`, using its reported page size |
| Swap | Current `sysctl vm.swapusage` value |
| oMLX process footprint | Process memory reported by oMLX’s enabled memory guard |
| Model allocation | Reported model allocation, separate from process footprint |
| RAM / SSD cache | Reported server cache sizes, kept separate from model allocation |
| Runtime memory guard | oMLX guard state, not macOS memory pressure |

Non-free RAM is not Activity Monitor’s **Memory Used**. Compressed memory means
physical pages occupied by the compressor, not the logical uncompressed size.
No GPU, fan, thermal, or private memory-pressure measurements are inferred.

## Runtime coverage

LM Studio reports model inventory and loaded-instance context limits. mlx-lm
reports available model files without residency. These views retain host resources
while leaving live request metrics unavailable. A model file's size is not process
RAM, and a configured context limit is not remaining context.

vllm-mlx per-request speed is withheld until output counters advance and again
when they stop advancing for five seconds. Its top-level speed is omitted because
backend meanings differ. Only batched MLLM prefill fractions strictly between zero
and one are usable. A held fraction waits for observed advancement after a
monitoring gap; there are no processed-token counts or stage estimates. LLM
output-limit progress never becomes prefill. Reuse requires the text batched engine,
a recognized cache classification, and valid request-matched counts. Metal allocator
values never become a process footprint. See [Compatibility](COMPATIBILITY.md).

## oMLX prefill

Processed and total counters belong to the current runtime stage. Cached prefix
reuse is separate and is not subtracted from the total a second time. Staged or
speculative prefill can change the stage total; the fraction is not whole-request
completion. Unfinished work below one percent remaining displays `<1%`, never a
premature zero.

An unchanged stage counter is labelled **Waiting for progress** after 15 seconds.
The last percentage may remain visible as a held reading, but live speed and
estimate are withheld. Pausing labels retained progress; resuming waits for a
fresh reading. Missing counters do not produce invented counts or percentages.

A valid stage estimate comes from `prefilling[].eta` alongside consistent
processed/total counters and positive reported speed. It is rounded up and only
changes with a new observation. Paused, stale, malformed, completed, and
ambiguous stages have no estimate. There is no synthetic countdown.

The reviewed [oMLX prefill tracker](https://github.com/jundot/omlx/blob/14194fe74bab38b89c144bd89656fbedca641d14/omlx/prefill_progress.py)
supplies these counters and estimates.

## Recent output and oMLX DFlash

Recent output uses at most ten seconds of observed output counters, requiring
three samples spanning at least two seconds. It resets on request/model changes,
backwards counters or clocks, missing identity, stale output, and monitoring gaps.
The chart never joins observed rates to reported averages as one continuous trace.

Primary DFlash reports accepted output through generic activity counters.
Its total activity elapsed time also includes preparation, so it cannot be used
as a request-average generation duration. Before output arrives, processing
remains visible without invented prefill progress or an estimate. Standard
fallback prefill and generation use their normal reported telemetry.

Speculation summaries and acceptance totals are not assigned to a live request.
See [Compatibility](COMPATIBILITY.md) for source-review boundaries.

## Context, reuse, and concurrency

Prompt plus output is subtracted from the reported model context limit. During
prefill, output is zero for this calculation. Reused tokens still occupy context
and are not subtracted again. Missing or inconsistent counts suppress headroom.
This is neither a reserved output/reasoning budget nor an allocation guarantee.
An oMLX request profile may override the physical model’s context limit; activity does
not reveal enough profile identity to reconstruct that exact request budget.

Reuse requires a cache lookup matching the same request. Unreused input does not
necessarily equal a prefill-stage total. Cache sizes and completed session totals
are server-wide; stale totals are labelled separately from current activity.

Single-request headline speed and progress are withheld during ambiguous
concurrency. The loaded-model roster can show a model’s single-request readings
when that model’s counters are identifiable. A combined server rate is not
fabricated from several requests. Distributed rank summaries do not establish
request identity and do not become per-request telemetry.

## History and freshness

Charts retain a bounded 90-second window. Throughput has a zero baseline; host
percentages use a fixed 0–100% scale. Pause, disconnect, missing measurements,
request changes, and long gaps break the trace rather than inserting zeros.
Compact mode retains bounded observations while avoiding hidden chart updates.

Point at the throughput chart, or focus it and use arrow keys, to inspect actual
samples. Home/End select the oldest/newest sample; Escape returns to the current
view. No interpolated estimate or additional runtime read is created.

A delayed service response becomes visibly stale after six seconds, or ten with
energy-saving updates. Hidden and paused views stop polling. Restoring a view
waits for a fresh reading before showing live throughput.

Recent generations retain eight last-seen observations in view memory. A request
that disappears may have completed, been cancelled, or become unobservable.
Rows therefore say **No longer observed** or **Monitoring gap**. Their output
and speed are last-seen values, not guaranteed final totals. Clearing this history
does not reset runtime statistics.

## Compare and Saved

A 30/60-second capture consumes existing snapshots and never starts inference.
A request capture begins with one identifiable active model. Inventory-only
connections capture host resources without a generation rate or request-count
change. The capture closes at its target window
and retains the duration actually observed; a late response does not fill an
unobserved ending or add time beyond that window.
Changing connections clears working histories, captures, and pinned references.
Manual stop, pause, hidden view, lost connection, concurrency, changed model,
clock reversal, or a gap over 12 seconds leaves a labelled partial observation.

Observed generation rate is summed token increments divided by the duration of
valid adjacent generation intervals. Only matching service-local request epochs
contribute; resets are never bridged. At least two seconds are required for a
rate. Reported request averages are not mixed into this calculation.

Resource means use distinct host CPU and memory samples, without time weighting
or counting cached repeats again. Process footprint is a sampled peak. None of
these values establishes a lifetime peak, exclusive request usage, or GPU memory.
Reported request-count changes are server-wide and follow the runtime counter’s
meaning, not a guarantee of successful completions. Missing/stale totals, counter
resets, or a server restart make that change unavailable for the window.

A pinned reference is held alongside the current capture. Percentage comparison
requires the same model and at least five seconds of observed generation in each
window. Differences are descriptive, not causal: prompts, cache states, and other
work can differ. These are observations, not controlled benchmarks.

Saved summaries are user-triggered, timestamped, and sanitized. OpenChamber
extension storage retains the 12 newest; saving another replaces the oldest
when full, as indicated by the Save control. They contain measurements without
model names, request identifiers, credentials, chat content, or private paths. They can be
copied, deleted individually, or cleared. Since a saved report omits model
identity, it should not imply that two saved observations used the same model.

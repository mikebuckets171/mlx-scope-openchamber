# Media monitoring

Open **MLX Scope → Media** to see active and recent image/video jobs. The Session section gives priority to a job belonging to the current chat, with a count of other jobs. Unassigned means the source supplied no matching chat ownership; Scope never guesses ownership from timing or the selected model.

## Getting connected

Scope discovers recognized running ComfyUI installations, configured local media sources, the standard local-video queue and private telemetry feeds. Open **Connections** for source readiness. **Monitor media** pauses media collection independently of LLM monitoring.

ComfyUI basic monitoring needs no helper. Choose **Enable detailed media progress** to install the bundled passive helper into a recognized ComfyUI `custom_nodes/mlx_scope` folder. If several installations are found, choose the one for this connection. A custom server address and installation folder can be supplied in Advanced. No command-line setup is needed for supported installations.

The helper is initially qualified for ComfyUI 0.38.0. It loads when ComfyUI ordinarily starts. Scope displays **Installed · activates next time ComfyUI starts** until it verifies the helper; it never restarts ComfyUI. Updates preserve the private helper token, and removal only touches a verified Scope-owned helper. Modified or conflicting installations are preserved and explained.

## Reading progress

A circular indicator shows the backend's measured percentage for the displayed phase or node, not the whole render. The ring never displays a number: the percentage is text beside it (for example **Sampling · 40%**, with **8 / 20 steps** below), so it can never clip the stroke. Assistive technology reads the ring itself as “Sampling progress · this phase only” with the value “40% · 8 / 20 steps · Sampling only”. Encoding references, sampling, decoding and finishing can each have separate counters. Vpipe blocks and decoder tiles retain those units. Qualified sampler counters can be labelled steps; unknown counters remain units. A still, dotted track means the backend has not supplied a measured range. Synthetic startup counters are not displayed as measurements.

The ring moves only toward something a source reported. It draws from empty to its value once when that phase's state arrives (about 200 ms), then eases directly from one received value to the next; it never invents intermediate values, loops or spins. A new phase, node or counter unit replaces the ring rather than easing across phases. A confirmed cancellation drains the ring in about 120 ms. A completed job keeps a full, dimmed ring beside its measured finish. Waiting, queued, indeterminate and **Last reported** rings are still. Hidden views animate nothing, and Reduce Motion makes every change instant.

Elapsed time uses the source’s reported start time, or its queue time when no start is supplied. An observation timestamp means the source was checked; the time progress changed is a separate value. Old file observations and disconnected sources never become fresh merely because Scope polled them. A retained percentage is labelled **Last reported** and its ring stays still; live progress and cancellation are withdrawn. Scope never invents a weighted whole-render percentage, and shows a finish time only as described below.

## Finish time

A finish time is clock time, not a countdown. Scope shows one only while a source declares that the job's current phase is its final or dominant phase, so the end of that phase is effectively the end of the job. In every other phase the line is absent rather than guessed.

- **finishes around 9:41 PM** — the measured estimate, rounded up to the next whole minute in your locale's time format.
- **finishes any moment** — the estimate is less than a minute away, or less than a minute overdue. An estimate more than a minute overdue is removed.
- **last estimate · around 9:41 PM** — the job is stale or its source is unavailable. The last live estimate is held, dimmed and never extended.
- **finished 9:38 PM** — the measured completion time reported by the source.

The service measures the rate from at least two reports of the current phase whose values and producer timestamps both increase. It uses the producer's own times (its progress-change time, or the observation that first carried each value), never the time Scope happened to read it, and keeps only the latest eight distinct reports. The estimate is the latest report's time plus the remaining counters at that rate; it never precedes that report and is dropped beyond 24 hours. Any change of phase, node or counter unit starts a new measurement, so a rate is never stitched across phases or carried across an unmeasured one. Waiting, queued, cancelling, indeterminate and ended jobs carry no estimate. The Session section repeats only a live estimate; the Media view shows each form under the job's detail lines.

Which sources declare an eligible phase:

| Source | Finish time | Why |
| --- | --- | --- |
| ComfyUI | Never | A graph can run several sampler passes, upscalers or decoders in any order; no node is known to end the job. |
| Qwen image | Never | Its own telemetry has no counters, and its correlated ComfyUI counters carry no final-phase knowledge. One request can also run nested generations. |
| Local video | Never | A job can render a sequence of shots, each repeating sampling, and decoding, finishing and joining after sampling can take minutes. |
| Private feed | When the producer sets `"finalPhase": true` | Only the producer knows its pipeline. The declaration applies to that job's current observation. |

While a Scope surface is visible, active media is checked every two seconds; a source with only finished jobs is checked every five seconds. If no source is detected, discovery retries every 30 seconds. Hidden surfaces and disabled media make no media requests. A backend may publish progress less often than Scope checks it: **Sources checked** confirms the check, while the job's update age identifies its latest report.

**Cancel job** appears only when the adapter supports exact cancellation and the job is freshly observed. Confirm the named job. Scope shows Cancelling until the owner reports a terminal state; an unconfirmed result remains explicit. It never falls back to a global interrupt. Queue ownership, scheduling, handoffs, retries and completion notifications stay with the generating tool.

## Integration contract

The versioned `MediaJobV1` contract carries source/job identity, kind and a short explicit name, state and phase, optional measured phase-local counters (`value`, `total`, `unit`, `basis: "phase"`), source observation and sampling timestamps, optional lifecycle/progress timestamps, freshness, hashed ownership and cancellation capability. Optional `lastProgress` and `lastProgressAtMs` retain a historical report for the same phase while live `progress` is null. They clear on incompatible phase or lifecycle changes and never enable cancellation. Optional `etaAtMs` is the service's finish-time estimate for a live, running job with measured counters, with `etaBasis: "measured-window"`; it must not precede the job's progress report (or observation) and must fall within 24 hours of it. While the job is stale or unavailable, `lastEtaAtMs` holds the last estimate for the retained `lastProgress` under the same rules, and live `etaAtMs` is absent. Parsers drop either field when those conditions fail, and snapshots without them remain valid. `MediaSnapshotV1` bounds sources and jobs separately from all LLM records. The TypeScript contract and strict allowlist parser are available in the source repository under `src/contract/media.ts`.

The service supports ComfyUI, local-video, Qwen image and a generic private file feed. Source configuration is a private JSON file at `~/.config/mlx-scope/media.json`, with `schemaVersion: 1`, an optional global `enabled` flag and up to eight configured sources. Each source has an `id`, `kind`, `label`, and its supported loopback origin or local directory. Installation and token paths stay inside the service; they are never public job metadata. Connections manages normal ComfyUI configuration.

For additional producers, use the private feed adapter and publish only sanitized counters and lifecycle metadata. Files must be owner-only regular files, written atomically, bounded and expiring. Follow the source contract and adapter fixtures for exact validation. A file feed is read-only: arbitrary executable paths, cancellation URLs, prompts and image/video payloads are not accepted as control instructions. A new cancellation capability requires a reviewed backend adapter.

A feed source config is `{ "id": "studio", "kind": "feed", "label": "Studio", "directory": "/absolute/private/feed" }`. Publish a regular `.json` file with mode `0600`, no larger than 64,000 bytes, and replace it atomically. Use current Unix milliseconds in the envelope below; `expiresAtMs` must be later than the current time and no more than 60 seconds after `observedAtMs`. A source reads at most 16 files and 32 jobs per file, with the final response capped at 64 jobs across eight sources.

```json
{
  "schemaVersion": 1,
  "observedAtMs": 1800000000000,
  "expiresAtMs": 1800000030000,
  "jobs": [{
    "id": "render-42",
    "kind": "image",
    "state": "running",
    "phase": "sampling",
    "progress": {"value": 3, "total": 20, "unit": "steps", "basis": "phase"},
    "startedAtMs": 1799999990000,
    "ownership": {}
  }]
}
```

Scope supplies `sourceId`, a neutral name, `sampledAtMs`, `observedAtMs`, freshness and disabled cancellation when normalizing a file feed. Supply `progress: null` when no valid measured range exists. Use `phaseKey` (a 64-character lowercase hexadecimal digest) when multiple nodes can repeat a phase. Session ownership uses the SHA-256 convention in `src/contract/chat-key.ts`; omit ownership when it is unknown. Never hash a guessed association. After 15 seconds without a new source observation, a nonterminal job is stale even if its envelope has not expired.

To allow a finish time, add `"finalPhase": true` to a running job only while its current phase is the last one, or so dominant that its end is effectively the job's end; omit it in every other phase. Only the boolean `true` counts. Supply `progressAtMs` (when the counters last changed) for the most accurate rate; otherwise Scope uses the envelope's `observedAtMs` that first carried each value. Scope measures the estimate itself: `etaAtMs`, `lastEtaAtMs` and `etaBasis` supplied by a producer are ignored, and `finalPhase` never appears in Scope's own responses.

The optional helper uses ComfyUI’s extension loader and a GET route on its existing server. It reads a qualified internal progress registry, so unsupported registry versions fall back to basic monitoring. It creates no generation nodes, independent service, model workload or persistent watcher. Basic APIs and helper coverage are documented independently; Scope does not promise detailed progress for every custom node.

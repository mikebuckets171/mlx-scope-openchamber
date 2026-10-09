# Media monitoring

Open **MLX Scope → Media** to see active and recent image/video jobs. The Session section gives priority to a job belonging to the current chat, with a count of other jobs. Unassigned means the source supplied no matching chat ownership; Scope never guesses ownership from timing or the selected model.

## Getting connected

Scope discovers recognized running ComfyUI installations, configured local media sources, the standard local-video queue and private telemetry feeds. Open **Connections** for source readiness. **Monitor media** pauses media collection independently of LLM monitoring.

ComfyUI basic monitoring needs no helper. Choose **Enable detailed media progress** to install the bundled passive helper into a recognized ComfyUI `custom_nodes/mlx_scope` folder. If several installations are found, choose the one for this connection. A custom server address and installation folder can be supplied in Advanced. No command-line setup is needed for supported installations.

The helper is initially qualified for ComfyUI 0.38.0. It loads when ComfyUI ordinarily starts. Scope displays **Installed · activates next time ComfyUI starts** until it verifies the helper; it never restarts ComfyUI. Updates preserve the private helper token, and removal only touches a verified Scope-owned helper. Modified or conflicting installations are preserved and explained.

## Reading progress

A circular indicator shows the backend's measured percentage for the displayed phase or node, not the whole render. Encoding references, sampling, decoding and finishing can each have separate counters. Vpipe blocks and decoder tiles retain those units. Qualified sampler counters can be labelled steps; unknown counters remain units. An indeterminate arc means the backend has not supplied a measured range. Synthetic startup counters are not displayed as measurements.

Elapsed time uses the source’s reported start time, or its queue time when no start is supplied. An observation timestamp means the source was checked; the time progress changed is a separate value. Old file observations and disconnected sources never become fresh merely because Scope polled them. A retained percentage is labelled **Last reported** and its ring stays still; live progress and cancellation are withdrawn. Scope invents neither an ETA nor a weighted whole-render percentage.

While a Scope surface is visible, active media is checked every two seconds; a source with only finished jobs is checked every five seconds. If no source is detected, discovery retries every 30 seconds. Hidden surfaces and disabled media make no media requests. A backend may publish progress less often than Scope checks it: **Sources checked** confirms the check, while the job's update age identifies its latest report.

**Cancel job** appears only when the adapter supports exact cancellation and the job is freshly observed. Confirm the named job. Scope shows Cancelling until the owner reports a terminal state; an unconfirmed result remains explicit. It never falls back to a global interrupt. Queue ownership, scheduling, handoffs, retries and completion notifications stay with the generating tool.

## Integration contract

The versioned `MediaJobV1` contract carries source/job identity, kind and a short explicit name, state and phase, optional measured phase-local counters (`value`, `total`, `unit`, `basis: "phase"`), source observation and sampling timestamps, optional lifecycle/progress timestamps, freshness, hashed ownership and cancellation capability. Optional `lastProgress` and `lastProgressAtMs` retain a historical report for the same phase while live `progress` is null. They clear on incompatible phase or lifecycle changes and never enable cancellation. `MediaSnapshotV1` bounds sources and jobs separately from all LLM records. The TypeScript contract and strict allowlist parser are available in the source repository under `src/contract/media.ts`.

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

The optional helper uses ComfyUI’s extension loader and a GET route on its existing server. It reads a qualified internal progress registry, so unsupported registry versions fall back to basic monitoring. It creates no generation nodes, independent service, model workload or persistent watcher. Basic APIs and helper coverage are documented independently; Scope does not promise detailed progress for every custom node.

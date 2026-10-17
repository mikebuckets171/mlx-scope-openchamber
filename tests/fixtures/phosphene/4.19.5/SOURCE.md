# Phosphene 4.19.5 fixture corpus

**Version represented:** Phosphene **4.19.5** (local commit `287a964`, as its `/version` reported on 2026-10-17).

**`status-idle.json` — captured and redacted.** One `GET /status` from a real Phosphene 4.19.5 at rest with one finished
render in its history. The adapter's allowlisted fields (`running`, `paused`, `paused_reason`, `current`, `queue`,
`server_now`, and each history entry's `id`, `status`, `started_ts`, `elapsed_sec` and `params.mode` / `params.engine`)
keep their captured values. Everything else was removed, or replaced by canaries the tests require never to leave the
adapter: `FIXTURE PRIVATE PROMPT`, `/Users/fixture/private/…` paths, a log line and an output entry. Machine, model and
installation details (memory, chip, macOS, versions of bundled libraries, model integrity, tiers) were dropped.

**`status-states.json` — synthesized from upstream source; no render was run or captured.** Field shapes follow the
4.19.5 source: `panel/routes_queue.py` (`get_status`, which builds the payload and the per-job `progress`),
`mlx_ltx_panel.py` `_compute_progress` (LTX: `phase` setup/download/denoise/decode/post, `denoise_step`,
`denoise_total`, `remaining_sec`) and the H3 runner's progress writer (`phase` load/denoise/decode, `window`,
`window_total`), the `waiting_note` path, and the history statuses `done`, `failed`, `cancelled`, `stopped` and
`skipped`. Ids, times, counters and estimates are invented; prompts, paths and errors are canaries.

Live verification of a running Phosphene render is recorded separately from these fixtures.

# Privacy

MLX Scope reads local runtime and host-resource measurements through its
OpenChamber-managed service. It does not upload telemetry, send prompts, change
runtime settings, or run an analytics service.

## Data handled

The service reads the configuration and credential sources listed in
[Configuration](docs/CONFIGURATION.md), including referenced credential files
and environment variables. Credentials and raw API responses stay service-side.
The panel receives allowlisted measurements, bounded model labels, and connection
choices. It does not receive prompts, completions, credentials, or raw request
identifiers. Absolute model paths are reduced to names before display.
Neither component rewrites configuration files or reads conversation content.
For LM Studio, the service follows LM Studio's server log with
`lms log stream -s server --json --port <port>` while MLX Scope is open. It parses only request
lifecycle lines (model name, prompt-processing percentage, and the completion
summary of token counts, time to first token, and tokens per second) and ignores
every other line. LM Studio redacts request bodies in this log by default; if you
turn that redaction off, those lines reach the service process but are still
discarded without being stored or sent to the panel.

Chart history, recent generations, and working captures remain in memory.
OpenChamber extension storage holds interface preferences and the selected provider
ID/runtime. It never stores connection URLs or keys. **Save** stores a sanitized
observation only on user action. The 12 newest summaries are retained; saving
another replaces the oldest when full, as shown by the Save control.

Saved observations include a timestamp and numeric measurements; they exclude
model names, chat content, request identifiers, credentials, and private paths.
**Delete** and **Clear saved** remove them through the same host storage API.
Storage follows the OpenChamber host's storage, backup, and access behavior.
A storage failure is reported without claiming the write succeeded and does not
stop monitoring.

## Sharing

**Share → Copy stats** and **Share → Add to chat draft** are explicit actions.
Reports exclude model names, paths, request identifiers, credentials, and
conversation content. Draft sharing appends text, preserves existing text, and
never sends a message. If you later send that draft, its provider receives the
report under that provider's policies.

**Setup guide** opens this project's public documentation on GitHub without
telemetry or credentials in the URL. **Check extension service** asks OpenChamber
for local service status. MLX Scope makes no automatic update checks; installation
and extension management belong to OpenChamber.

Review screenshots and copied reports before sharing. Never attach auth files,
raw server responses, or private conversations to a public issue.

## MLX Scope 2.0

> **Draft for 2.0 — finalised in Stage 11.** This section describes MLX Scope 2.0 as designed. It is not released and
> its features are not built yet; the plan stage that builds each one is in brackets. Lines marked **Pending** rest on
> facts that are not verified yet. Everything above this section describes the current 1.6.x release. At release, the
> paragraph above that begins "Chart history, recent generations" is replaced by the reply-history text below.

### Reply history stored on this computer [Stage 10]

2.0 keeps a local history of the replies it observed while a Scope view was visible. It lives in OpenChamber extension
storage, the same place 1.x keeps saved observations, on the computer that runs the OpenChamber server. On a default
macOS desktop install that is one file per extension under `~/.config/openchamber/guest-storage/`. Anything that backs up
that folder, such as Time Machine, also copies the history. **Pending:** the location for web and server installs.

**Each reply record holds**
- when the reply finished, to the second, and when its turn started and ended;
- the runtime kind and the **model name**, kept once in a local list and referenced by number;
- the context and uncached-input size range, prompt, cached and output token counts, time to first token, and prefill
  and decode speeds;
- how each value was obtained (reported, derived, observed, last observed, or estimate), and the per-chat label with its
  reason;
- which conditions were present during the reply (memory pressure, swap growth, thermal pressure), and the chip energy
  estimate when macmon is installed.

A turn record adds the step count, total output, first-step time to first token, a token-weighted decode speed and time
spent waiting.

**Never stored:** chat, session or project IDs; chat titles; project names or folders; prompt or response text; request
IDs; file paths; credentials. The service's per-chat tag is not stored either.

**What the times reveal.** The timestamps show when you used a local model, and someone with access to both could line
them up with your chat history in OpenChamber.

**Model names stay in Scope's own views.** They appear in the reply history and in Scope's panel, page and Work Status
section. They are left out of every share path: Copy, Add to chat draft, `/scope`, toasts, the baseline summary (which
calls models "Model A", "Model B"), and saved captures. **Pending:** the canary tests for these paths (plan §8.7) are
written in Stage 10.

**When records are written.** Only while a Scope view is visible, and only by one view at a time. Writes are batched: at
most every 5 minutes, at 50 pending replies, or when the view is hidden. Nothing is written while idle.

**Your controls, in History → Storage**
- **Keep N days:** 30 by default, 90 at most. Older replies are removed after the next write.
- **Pause recording:** stops new records and keeps the existing ones.
- **Clear…:** after confirmation, deletes every reply record and the baselines built from them.
- A usage bar shows the space used. History is capped at 1,280 KiB; when it is full, the oldest replies are removed first.
- The first recording shows "Recording reply history locally · Open Scope to manage".

**Uninstalling** MLX Scope in Settings → Extensions deletes all of its storage: reply history, baselines, saved captures
and any 1.6 observations. This is OpenChamber's documented behaviour for extension storage. Backups keep their own copies.

**1.6 saved observations** stay untouched through every 2.0.x release. 2.0 copies them into its own captures and leaves
the originals, so rolling back to 1.6 still shows them. See the [rollback runbook](https://github.com/mikebuckets171/mlx-scope-openchamber/blob/main/docs/2.0/ROLLBACK.md).

**Kept in memory only.** The service holds up to 60 minutes of trend readings, recent completions and the last 20 alerts.
It writes no files, and all of this is lost when the service stops. The oMLX usage card reads oMLX's own usage records
through its admin login. They are cached in memory for 5 minutes, never stored and never merged into the reply history.

### Per-chat labels without the sessions permission [Stage 9]

- Scope does not request OpenChamber's `sessions` permission. It cannot list your projects, worktrees or other chats.
- It uses only what OpenChamber gives every extension about the **open** chat: its ID, whether it is busy, its model, and
  its turn start and finish events.
- OpenChamber also passes the open chat's title. Scope never displays, stores or sends it.
- To mark turns, the service holds a short hash of the open chat's ID, salted per service start. It lives in memory only
  and is never stored, displayed or returned.

### `/scope` [Stage 11]

- Typing `/scope` attaches an "MLX Scope diagnostics" chip. Its text is at most 16,000 characters and is built by the same
  sanitizer as Copy.
- **It contains** the runtime kind, phase, speeds with their basis, the context size range, vs-usual changes with sample
  counts, memory pressure, GPU and thermal readings, and the per-chat label.
- **It never contains** model names, chat titles, IDs, paths, prompt text or credentials.
- Attaching sends nothing. When you send your message, the summary goes to this chat's model, **which may be a cloud
  provider**, under that provider's policies. The summary's first line says so.
- The chip **replaces a pending GitHub or Linear chip**, because the composer holds one of them at a time.
- After you send, OpenChamber keeps the chip and its text in the chat's session record, like any attached item.
- **Pending:** the replacement and session-record behaviour come from the OpenChamber SDK 2.0.4 documentation and were not
  observed in the Stage 0 spike (SPIKES S4).

### Mac readings and commands [Stage 5]

The commands 2.0 may run, and why, are listed in the README under "What 2.0 asks you to approve and why". For privacy:
- Scope runs no `sudo`, `osascript` or `powermetrics`.
- `ioreg` output includes the process ID of the latest GPU client, and `lsof` and `footprint` handle the oMLX process ID.
  Process IDs stay in the service and never reach the panel, storage or any share path.
- Chip power from macmon covers every app on the Mac, not only the runtime.

**Observer only.** Scope never starts, loads, unloads or wakes a runtime, and never sends inference.
- `lms` runs only after LM Studio has just answered, and always with the server-info path that stops it from launching
  LM Studio or Bionic (since 1.6.1).
- On llama-server builds that can sleep, Scope reads slots only while the server reports work in progress, so it never
  wakes it.

### Bionic and LM Studio server log [Stage 3]

2.0 keeps following `lms log stream -s server --json` for request lifecycle lines. If you turn on Bionic's or LM Studio's
`logSensitiveData` or `logIncomingTokens` setting, that log carries request bodies or generated text. Scope drops those
lines without storing or forwarding them.
- On the Mac used for the Stage 0 spike, both settings were off (SPIKES S8).
- The 2.0 parser is tested against recorded fixtures with both settings on. The fixtures contain canary text that must
  never leave the service. **Pending:** the Stage 3 adapter that these fixtures test.

### Alerts [Stages 6 and 10]

Toasts and the rail badge appear only inside OpenChamber, and only while a Scope view is visible. Toast text is limited to
500 characters, goes through the same sanitizer, and contains no model names.

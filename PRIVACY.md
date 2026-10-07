# Privacy

MLX Scope reads local runtime and host measurements through its OpenChamber-managed service. It does not upload
telemetry, send prompts, change runtime settings, or run an analytics service. Nothing leaves your computer unless you
share it yourself: Copy, Add to chat draft, Copy baseline summary, or a `/scope` chip you send.

## Data handled

The service reads the configuration and credential sources listed in [Configuration](docs/CONFIGURATION.md), including
referenced credential files and environment variables. It never reads OpenChamber's own settings file. Credentials and
raw API responses stay service-side. The views receive allowlisted measurements, bounded model labels, and connection
choices. They do not receive prompts, completions, credentials, request identifiers or process IDs. Absolute model
paths are reduced to names before display. Neither component rewrites configuration files or reads conversation
content.

**Bionic and LM Studio server log.** For LM Studio, the service follows LM Studio's server log with
`lms log stream -s server --json --port <port>` while a Scope view is open. It parses only request lifecycle lines
(model name, prompt-processing percentage, and the completion summary of token counts, time to first token and tokens
per second) and drops every other line. If you turn on Bionic's or LM Studio's `logSensitiveData` or
`logIncomingTokens` setting, that log carries request bodies or generated text; those lines reach the service process
but are dropped without being stored or sent to a view. The parser is tested against recorded fixtures with both
settings on, whose canary text must never leave the service.

**Kept in memory only.** The service holds up to 60 minutes of trend readings, recent completions and the last 20
alerts. It writes no files, and all of this is lost when the service stops. The oMLX usage card reads oMLX's own usage
records through its admin login; they are cached in memory for 5 minutes, never stored and never merged into the reply
history.

## Optional Splash prompt progress companion

The companion is installed separately in OpenCode. It parses the existing streaming request body in memory to add
Splash's `return_progress` option and observes the response as OpenCode reads it. It does not submit a prompt or change
the selected model. Scope's service still writes no files.

The companion stores brief numeric progress records under `~/.cache/mlx-scope/prompt-progress/`, using private
owner-only directories and files. Records contain prompt counts, timestamps, provider names, random response IDs and
hashes for matching the session, endpoint and model. No prompt, response text, credentials, headers or raw session or
model IDs are stored. Hashes can correlate known identifiers and are not anonymization. Entries expire after 15 seconds;
files are removed when streams finish or the companion unloads. A crash may leave an expired file.

The service reads a bounded set of matching records and sends only numeric progress and its freshness timestamp to the
views. Matching keys and response IDs never reach Scope history or shared diagnostics. See the
[companion data contract](bridge/opencode/README.md) for limits and validation.

## Reply history stored on this computer

MLX Scope keeps a local history of the replies it observed while a Scope view was visible. It lives in OpenChamber
extension storage, the same place 1.x keeps saved observations, on the computer that runs the OpenChamber server. On a
macOS desktop install that is one file per extension under `~/.config/openchamber/guest-storage/`. Anything that backs up
that folder, such as Time Machine, also copies the history. The location for web and server installs follows
OpenChamber's data folder and is verified in Stage 12.

**Each reply record holds**
- when the reply finished, to the second, and when its turn started and ended;
- the runtime kind and the **model name**, kept once in a local list and referenced by number;
- the context and uncached-input size range, prompt, cached and output token counts, time to first token, and prefill
  and decode speeds;
- how each value was obtained (reported, derived, observed, last observed or estimate), and the per-chat label with its
  reason;
- which conditions were present during the reply (memory pressure, swap growth, thermal pressure), and the chip energy
  estimate when macmon is installed.

A turn record adds the step count, total output, first-step time to first token, a token-weighted decode speed and time
spent waiting.

**Never stored:** chat, session or project IDs; chat titles; project names or folders; prompt or response text; request
IDs; file paths; credentials. The per-chat tag the service uses to mark turns is not stored either.

**What the times reveal.** The timestamps show when you used a local model, and someone with access to both could line
them up with your chat history in OpenChamber.

**Model names stay in Scope's own views.** They appear in the reply history and in Scope's panel, page and Work Status
section. They are left out of every share path: Copy, Add to chat draft, `/scope`, toasts, the baseline summary (which
calls models "Model A", "Model B"), and saved captures. Canary tests cover each of these paths.

**When records are written.** Only while a Scope view is visible, and only by one view at a time. Writes are batched: at
most every 5 minutes, at 50 pending replies, or when the view is hidden. Nothing is written while idle.

**Your controls, in History → Storage**
- **Keep N days:** 30 by default, 90 at most. Older replies are removed after the next write.
- **Pause recording:** stops new records and keeps the existing ones.
- **Clear…:** after confirmation, deletes every reply record and the baselines built from them.
- A usage bar shows the space used. History is capped at 1,280 KiB; when it is full, the oldest replies are removed first.
- The first recording shows "Recording reply history locally · Open Scope to manage".

**Other saved data.** View preferences and the selected provider ID and runtime (never a URL or key), and up to 12
captures you save yourself. Captures hold a timestamp and numeric measurements and exclude model names, chat content,
request identifiers, credentials and private paths. **Delete** and **Clear saved** remove them. A storage failure is
reported without claiming the write succeeded and does not stop monitoring.

**1.6 saved observations** stay untouched through every 2.0.x release. 2.0 copies them into its own captures and leaves
the originals, so rolling back to 1.6 still shows them. See the
[rollback runbook](https://github.com/mikebuckets171/mlx-scope-openchamber/blob/main/docs/2.0/ROLLBACK.md).

**Uninstalling** MLX Scope in Settings → Extensions deletes all of its storage: reply history, baselines, captures and
any 1.6 observations. This is OpenChamber's documented behaviour for extension storage. Backups keep their own copies.

## Per-chat labels without the sessions permission

- MLX Scope requests no capabilities. Without OpenChamber's `sessions` permission it cannot list your projects,
  worktrees or other chats.
- It uses only what OpenChamber gives every extension about the **open** chat: its ID, whether it is busy, its model,
  and its turn start and finish events.
- OpenChamber also passes the open chat's title. Scope never displays, stores or sends it.
- To mark turns, a view sends the service a short hash of the open chat's ID, salted per service start. The service
  keeps it in memory only and never stores, displays or returns it.

## Sharing

**Copy stats**, **Add to chat draft** and **Copy baseline summary** are explicit actions. One sanitizer builds every
shared text: it excludes model names, paths, request identifiers, credentials and conversation content. Draft sharing
appends text, preserves existing text, and never sends a message. If you later send that draft, its provider receives
the report under that provider's policies.

## `/scope`

- Typing `/scope` attaches an "MLX Scope diagnostics" chip. Its text is at most 16,000 characters and is built by the same
  sanitizer as Copy. It ignores anything typed after the command.
- **It contains** the runtime kind and version, status and phase, speeds with their basis, the context size as a range,
  the last reply's per-chat label and vs-usual changes with sample counts, memory pressure, GPU and thermal readings, and
  active alert names.
- **It never contains** model names, chat titles, IDs, paths, prompt text or credentials.
- To build it, Scope reads its own service once and two local history values (the baselines and the model list, to
  match the last reply). It writes nothing.
- Attaching sends nothing. When you send your message, the summary goes to this chat's model, **which may be a cloud
  provider**, under that provider's policies. The summary's first line says so.
- The chip **replaces a pending GitHub or Linear chip**, because the composer holds one of them at a time, and after you
  send, OpenChamber keeps the chip and its text in the chat's session record, like any attached item. Both come from the
  OpenChamber SDK 2.0.4 documentation and are verified in Stage 12.

## Alerts

Toasts and the rail badge appear only inside OpenChamber, and only while a Scope view is visible. Toast text is limited to
500 characters, goes through the same sanitizer, and contains no model names.

## Mac readings and commands

The commands MLX Scope may run, and why, are listed in the README under "What 2.0 asks you to approve and why". For
privacy:
- Scope runs no `sudo`, `osascript`, `powermetrics` or `pmset`.
- `ioreg` output includes the process ID of the latest GPU client, and `lsof` and `footprint` handle the oMLX process
  ID. Process IDs stay in the service and never reach a view, storage or any share path.
- Chip power from macmon covers every app on the Mac, not only the runtime.

**Observer only.** Scope never starts, loads, unloads or wakes a runtime, and never sends inference.
- `lms` runs only after LM Studio has just answered, and always with the server-info path that stops it from launching
  LM Studio or Bionic (since 1.6.1).
- On llama-server builds that can sleep, Scope reads slots only while the server reports work in progress, so it never
  wakes it.

## Links

**Setup guide** opens this project's public documentation on GitHub without telemetry or credentials in the URL.
**Check extension service** asks OpenChamber for local service status. MLX Scope makes no automatic update checks;
installation and extension management belong to OpenChamber.

Review screenshots and copied reports before sharing. Never attach auth files, raw server responses, or private
conversations to a public issue.

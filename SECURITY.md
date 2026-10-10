# Security

## Reporting a vulnerability

Use this repository's private **Security → Report a vulnerability** option when available. Otherwise open an issue
asking for a private reporting channel without publishing exploit details. Include the affected version, minimal
reproduction, required access, and impact in the private report. Never include credentials, auth files, session
cookies, or private conversations in public issues.

MLX Scope is a community-maintained project. Reports are welcome. Response and fix times depend on maintainer
availability and are not guaranteed.

## Supported versions

| Line | Hosts | Fixes |
|---|---|---|
| 3.x | OpenChamber 2.0.4 and newer | Security and correctness fixes ship on the current line |
| `legacy/1.6.x` | OpenChamber 1.24.x–2.0.3 | Security and correctness fixes only |
| Anything older | — | None. Update, or pin the legacy line |

## Boundaries

OpenChamber sandboxes the panel, page, Work Status section and `/scope` frames. Its approved local service runs under
the same user account as the host and can read configured runtime credentials. The manifest's command list describes
intended use, not an operating-system sandbox: OpenChamber treats it as advisory, and an approved service can run any
command the user can. The list is MLX Scope's promise, enforced by its own code and tests. Review the source and install
releases you trust.

**Local service routes**
- Monitoring routes answer `GET` only. `/v2/companion/setup` additionally accepts an authenticated, bounded JSON
  `POST` with exactly one `enable` or `disable` action. `/v2/media/setup` accepts strict allowlisted configuration/helper actions; `/v2/media/cancel` accepts only a source ID and job ID. Reading setup status never changes configuration.
- Every route, including health, requires OpenChamber's service token, compared in constant time.
- Responses are `no-store` and stay under OpenChamber's 256,000-character response limit.
- The retired 1.x route `/snapshot` answers `410 contract_mismatch`, so a mismatched view and service fail visibly
  instead of misreading each other.
- Query parameters are validated against a fixed grammar; a malformed one is rejected by name, and no value is logged or
  echoed.

**Commands**
- The manifest declares exactly 11 executable paths, each by absolute path: `/usr/bin/vm_stat`, `/usr/sbin/sysctl`,
  `/usr/sbin/ioreg`, `/usr/bin/notifyutil`, `/usr/sbin/lsof`, `/usr/bin/footprint`, `~/.lmstudio/bin/lms`,
  `~/.cache/lm-studio/bin/lms`, `/opt/homebrew/bin/macmon` `/usr/local/bin/macmon`, and `~/.config/opencode/bin/local-video`. The README lists what each one
  runs and why.
- Each binary has an argument allowlist in code, and a test enforces it. Ports and process IDs are validated before they
  reach an argument list. Commands run without a shell and with a small fixed environment: `LANG=C` and `LC_ALL=C`, and
  for `lms` also `HOME`, a fixed `PATH` and the LM Studio server-info path. Output is size- and time-bounded.
- Packaging matches both ways: every declared path is used by the built service, and every executable path the service
  names is declared.
- **Never run:** `sudo`, `osascript`, `powermetrics` or `pmset`. `lms` never runs `load`, `unload`, `server start`, or a
  log stream that carries model input or output (`--source model`, `--stats`).
- 3.1 adds `local-video cancel <validated-job-id>` only for an explicitly confirmed job in the standard queue. A permission-list change returns the extension to host approval. Scope requests no capabilities.

**Passive runtime reads and scoped controls**
- Runtime URLs are restricted to explicit HTTP loopback origins. `localhost` is canonicalized without DNS; remote
  targets and redirects are rejected.
- Runtime requests are `GET` only, size- and time-bounded. Exceptions are the oMLX admin login (after oMLX health identification) and explicit media cancellation through a qualified exact-job endpoint. An authentication challenge alone does not identify a runtime.
- Credentials are matched to the configured provider and origin. Missing credentials work only when the server already
  permits access; a rejected supplied key is never retried without authentication.
- oMLX: Scope does not call `/admin/api/stats`, whose response includes credentials. Usage details are bounded, and admin
  responses are reduced to an allowlist.
- Bionic and LM Studio: `lms` starts only after the LM Studio greeting answered within the last 10 seconds, always with
  the explicit port and server-info path that keep it from launching LM Studio or Bionic.
- llama-server: on builds that can sleep, slots are read only while `/metrics` reports work in progress, so Scope never
  wakes a sleeping server. Only numeric slot fields are read, never prompts, and the model path is cut to its file name.
- Splash: Scope reads `/status` and, when installed, the companion's bounded private progress files. While the server is recovering it polls at most every 30 seconds so it does not add
  to the restart retries. Crash traces, error text and instance identifiers are never forwarded.
- Scope never starts, loads or unloads a model or server, and never sends inference.

**Log parsing.** The LM Studio server log is read only for request lifecycle lines. With Bionic's or LM Studio's
`logSensitiveData` or `logIncomingTokens` on, lines carrying request bodies or generated text are dropped. Completion
summaries are accepted only from the runtime's own lifecycle lines, so generated text that imitates one is not counted.

**Sharing and storage**
- One sanitizer builds every shared text: Copy, Add to chat draft, `/scope`, toasts, the baseline summary and saved
  captures. Model names, IDs, titles, paths, keys and prompt text never reach these paths.
- Sharing requires a user action. Draft sharing appends and cannot send; `/scope` attaches a chip and never sends it.
- Only one visible view writes history storage. The service writes a private, expiring chat-demand file while watched;
  explicit companion setup can install owned plugin files and update the plugin configuration.

Automated checks cover these contracts: unit and fixture tests, privacy canaries across every share path, a
committed-file scrub, the package checks, and browser tests. They are not an independent security audit or a guarantee
against defects; they do not substitute for independent review.

## Optional OpenCode companion

The companion uses OpenCode's supported request/response hooks for one configured loopback Splash provider. It enables
one documented boolean option on existing streaming requests; it does not start inference, change routes, or override
global fetch. It preserves response bytes, cancellation and backpressure. Invalid or oversized progress frames disable
observation while response delivery continues. Private cache writes are bounded and atomic. Consumers reject malformed,
expired, unsafe, oversized or ambiguous records and publish only corroborated numeric progress. Its matching hashes
and response IDs are never exported. The companion has its own focused stream, isolation, permission and expiry tests.

Chat delivery uses only the qualified OpenCode 2.0.25 event protocol and loopback request metadata. Unsupported
protocols fail closed while runtime monitoring continues. Estimates use character counts, never stored text; only
bounded numeric measurements and hashed matching keys enter private expiring files. Both service and companion reject
symlinks, non-regular files, unsafe permissions, oversize bodies, stale timestamps and ambiguous matching writers.
Event work stops when the visible-view demand expires. See [Privacy](PRIVACY.md) for storage and removal details.


## Media helpers and cancellation

The ComfyUI helper is optional, initially qualified for 0.38.0, and loads through its supported custom-node mechanism. Its read-only route requires a private bearer token and loopback access. It emits sanitized bounded registry counters on demand, without producer hooks, WebSocket replacement or generation work. Setup only replaces/removes unchanged managed files; token permissions, ownership and intervening edits are verified, with rollback on configuration conflict.

Media records exclude prompts, references, file paths, credentials and raw error messages. Private feed files must be owner-only regular files, bounded and expiring. Job ownership is accepted only from explicit source metadata. Hashes are matching identifiers, not anonymization.

Cancellation rechecks the observed job and the adapter's qualified exact-job capability. ComfyUI uses its job-ID API, Qwen maps its job ID to the existing request cancellation event, and local-video uses its allowlisted job-ID command. No global interrupt, broad process kill, generation retry or arbitrary feed-supplied cancellation URL is permitted. The UI remains Cancelling until acknowledgement is observed.

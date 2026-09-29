# Security

## Reporting a vulnerability

> **Draft for 2.0 — finalised in Stage 11.** The "one-time release" wording is replaced by the community-maintained
> status the README already states.

Use this repository's private **Security → Report a vulnerability** option when
available. Otherwise open an issue asking for a private reporting channel without
publishing exploit details. Include the affected version, minimal reproduction,
required access, and impact in the private report. Never include credentials,
auth files, session cookies, or private conversations in public issues.

MLX Scope is a community-maintained project. Reports are welcome. Response and fix
times depend on maintainer availability and are not guaranteed.

## Boundaries

OpenChamber sandboxes the panel. Its approved local service runs under the same
user account as the host and can read configured runtime credentials. The manifest's
command list describes intended use, not an operating-system sandbox. Review the
source and install releases you trust.

- Every service route, including health, requires OpenChamber's authorization token.
- Runtime URLs are restricted to explicit HTTP loopback origins. `localhost` is
  canonicalized without DNS; remote targets and redirects are rejected.
- Credentials are matched to the configured provider and origin. oMLX health
  identification precedes its admin login. An authentication challenge alone
  does not identify a runtime.
- Missing credentials work only when the server already permits access. A rejected
  supplied key is never retried without authentication.
- Configuration and referenced-file reads, response bodies, subprocess output,
  timeouts, histories, connections, and storage are bounded. Native diagnostics
  use two fixed commands without a shell. LM Studio activity uses one fixed
  `lms log stream -s server --json --port <port>` command without a shell. It starts
  only on demand, after the LM Studio server of the local LM Studio home has
  answered, and only with the port that running app recorded. With an explicit
  port, `lms` connects to that app and exits if it is gone instead of launching
  LM Studio or Bionic.
- API responses are normalized into an allowlist before reaching the panel.
  oMLX admin responses can contain sensitive fields; raw responses are never shared.
  Inference response streams are not observed. LM Studio's server log is read only
  for request lifecycle lines; any other line, including request bodies if LM Studio
  redaction is disabled, is discarded.
- Sharing requires a user action and can append to a draft, but cannot send it.

MLX Scope does not manage models, clear caches, run inference, create credentials,
or change access policy. Automated checks cover these contracts; they are not an
independent security audit or a guarantee against defects.

## Supported versions

> **Draft for 2.0 — finalised in Stage 11.** 2.0 is not released. **Pending:** the `legacy/1.6.x` branch is published at
> owner gate G7.

| Line | Hosts | Fixes |
|---|---|---|
| 2.0.x | OpenChamber 2.0.4 and newer | Security and correctness fixes ship as the next 2.0.x patch release |
| `legacy/1.6.x` | OpenChamber 1.24.x–2.0.3 | Security and correctness fixes only |
| Anything older | — | None. Update, or pin the legacy line |

## MLX Scope 2.0 boundaries

> **Draft for 2.0 — finalised in Stage 11.** This section describes MLX Scope 2.0 as designed. None of it is built yet;
> the plan stage that builds each part is in brackets. Everything above this section describes the current 1.6.x release.

**Local service routes** [Stage 2a]
- Every route answers `GET` only; any other method gets `405`.
- Every route, including health, requires OpenChamber's service token, compared in constant time.
- Responses are `no-store` and stay under OpenChamber's response limit.
- The retired 1.x route `/snapshot` answers `410 contract_mismatch`, so a mismatched panel and service fail visibly
  instead of misreading each other.

**Commands** [Stages 5 and 7]
- The manifest declares exactly 10 commands, each by absolute path: `/usr/bin/vm_stat`, `/usr/sbin/sysctl`,
  `/usr/sbin/ioreg`, `/usr/bin/notifyutil`, `/usr/sbin/lsof`, `/usr/bin/footprint`, `~/.lmstudio/bin/lms`,
  `~/.cache/lm-studio/bin/lms`, `/opt/homebrew/bin/macmon` and `/usr/local/bin/macmon`. The README lists what each one
  runs and why.
- Each binary has an argument allowlist in code, and a test enforces it. Ports and process IDs are validated before they
  reach an argument list. Commands run without a shell and with a small fixed environment: `LANG=C` and `LC_ALL=C`,
  and for `lms` also `HOME`, a fixed `PATH` and the LM Studio server-info path (as in 1.6.1). Output is size- and
  time-bounded.
- A packaging check matches both ways: every declared path is used by the service, and every absolute path the service
  spawns is declared.
- **Never run:** `sudo`, `osascript`, `powermetrics` or `pmset`. `lms` never runs `load`, `unload`, `server start`, or a
  log stream that carries model input or output (`--source model`, `--stats`).
- OpenChamber treats a service's command list as advisory: an approved service can run any command the user can. The list
  is Scope's own promise, enforced by its code and tests, not an operating-system sandbox.
- **Pending:** the footprint design re-checks the oMLX process's start time with `/bin/ps` (SPIKES S9), which is not in
  the frozen list. The check or the list must change before release, with an owner decision.

**No new permissions beyond the service** [Stage 7]
- 2.0 requests no capabilities. The `sessions` permission was dropped after the Stage 0 spike, so Scope cannot list
  projects, worktrees or chats.
- The exec list and capabilities stay fixed across 2.0.x. Any change, even a removal, would send every install back to
  approval.

**Runtimes stay untouched** [Stages 3 and 4]
- Runtime requests are `GET` only, to explicit loopback origins, with redirects refused and responses size-bounded.
  The one exception is the existing oMLX admin login.
- oMLX: 2.0 stops calling `/admin/api/stats`, whose response includes credentials. Usage details are bounded.
- Bionic and LM Studio: `lms` starts only after the LM Studio greeting answered within the last 10 seconds, always with
  the explicit port and server-info path that keep it from launching LM Studio or Bionic.
- llama-server: on builds that can sleep, slots are read only while `/metrics` reports work in progress, so Scope never
  wakes a sleeping server. Prompt fields are never read, and the model path is cut to its file name.
- Splash: while the server is recovering, Scope polls at most every 30 seconds so it does not add to the restart
  retries. Crash traces, error text and instance identifiers are never forwarded.
- Scope never starts, loads or unloads a model or server, and never sends inference.

**Log parsing** [Stage 3]
- The LM Studio server log is read only for request lifecycle lines. With Bionic's or LM Studio's `logSensitiveData` or
  `logIncomingTokens` on, lines carrying request bodies or generated text are dropped.
- 2.0 is designed to close a 1.6.x parser weakness. 1.6 accepts a completion summary anywhere in a log message, so with
  `logIncomingTokens` on, generated text that imitates a summary can show as a completion with wrong numbers. 2.0 accepts
  summaries only from the runtime's own lifecycle lines. **Pending:** the Stage 3 adapter and its fixture tests.

**Sharing and storage** [Stages 10 and 11]
- One sanitizer builds every shared text: Copy, Add to chat draft, `/scope`, toasts, the baseline summary and saved
  captures. Model names, IDs, titles, paths, keys and prompt text never reach these paths.
- `/scope` attaches a chip and never sends it.
- Only one visible view writes storage, and the service writes no files.

Automated checks will cover these contracts. They are not an independent security audit; plan §8 schedules an independent
code and privacy review before acceptance.

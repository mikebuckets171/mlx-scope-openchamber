# Security

## Reporting a vulnerability

Use this repository's private **Security → Report a vulnerability** option when
available. Otherwise open an issue asking for a private reporting channel without
publishing exploit details. Include the affected version, minimal reproduction,
required access, and impact in the private report. Never include credentials,
auth files, session cookies, or private conversations in public issues.

This is a one-time personal-project release with no planned maintenance or
updates. Reports are welcome, but a response or fix is not guaranteed.

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
  use two fixed commands without a shell.
- API responses are normalized into an allowlist before reaching the panel.
  oMLX admin responses can contain sensitive fields; raw responses are never shared.
  Runtime conversation logs and inference response streams are not observed.
- Sharing requires a user action and can append to a draft, but cannot send it.

MLX Scope does not manage models, clear caches, run inference, create credentials,
or change access policy. Automated checks cover these contracts; they are not an
independent security audit or a guarantee against defects.

# Security

## Reporting a vulnerability

Use this repository’s private **Security → Report a vulnerability** option when
available. Otherwise open an issue asking for a private reporting channel without
publishing exploit details. Include the affected version, minimal reproduction,
required access, and impact in the private report. Never include credentials,
auth files, session cookies, or private conversations in public issues.

Fixes target the latest published release.

## Boundaries

OpenChamber sandboxes the panel. Its approved local service runs under the same
user account as the host and can read the saved oMLX credential. The manifest’s
command list describes intended use, not an operating-system sandbox. Review the
source and install releases you trust.

- The service accepts only authenticated loopback requests, including health.
- oMLX connections are restricted to numeric loopback HTTP. Health identification
  precedes credential use. Redirects are rejected rather than forwarding keys.
- Missing credentials work only when the existing server policy allows access.
  A rejected supplied key is never retried without authentication.
- Configuration reads, response bodies, subprocess output, timeouts, histories,
  and storage are bounded. Native diagnostics use two fixed commands without a shell.
- Runtime responses are normalized into an allowlist before reaching the panel.
  oMLX admin responses can contain sensitive fields; raw responses are never shared.
- Sharing requires a user action and can append to a draft, but cannot send it.

MLX Scope does not manage models, clear caches, run inference, or change access
policy. Automated checks cover these contracts; they are not an independent
security audit or a guarantee against defects.

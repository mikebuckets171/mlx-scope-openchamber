# Configuration

MLX Scope uses your existing local runtime connection. It does not rewrite
OpenChamber, OpenCode, runtime, model, cache, or inference settings.

## Getting connected

Start your runtime's local server and configure it as a provider in OpenChamber
or OpenCode, as you normally would for chatting. Open MLX Scope: **Automatic**
prefers the provider of the global selected model, then the named oMLX connection.
Existing oMLX settings provide a fallback when no oMLX provider was found.

Use **Change** beside the connection status when you want another configured server. Select its
**Connection**, leave **Runtime** on automatic detection or choose the matching
runtime, then select **Use connection**. This changes only what MLX Scope observes.
It saves the provider ID and runtime choice, never an endpoint or API key.

A connected limited-telemetry view is working: LM Studio, mlx-lm, and Splash do
not expose the same passive request telemetry as oMLX. Read
[Compatibility](COMPATIBILITY.md) before troubleshooting an unavailable metric.

## Discovery

Files belong to the computer running the OpenChamber server. Provider IDs can be
custom names; they do not have to be `omlx` or another runtime's name.

| Source | Use |
| --- | --- |
| `${XDG_CONFIG_HOME:-~/.config}/opencode/config.json` | Legacy compatibility input; OpenCode 2 no longer reads this filename |
| `${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.json` | OpenCode 1 `provider` entries or OpenCode 2 `providers` entries, plus the global selected model |
| `${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.jsonc` | JSONC overlay in either provider format |
| Absolute `OPENCODE_CONFIG_DIR/opencode.json(c)` | Alternate OpenCode 2 global config root, when available to the extension service; the default global root and its legacy `config.json` are not read in this mode |
| Absolute `OPENCODE_CONFIG` | Explicit configuration overlay, when available to the service |
| `OPENCODE_CONFIG_CONTENT` | Final inline configuration overlay, when available to the service |
| `~/.local/share/opencode/auth.json` | Legacy saved API keys for OpenCode 1-shaped providers, matched by provider ID; not used for native OpenCode 2 entries. `OPENCODE_AUTH_CONTENT` takes precedence when present. |
| `~/.omlx/settings.json` | oMLX server host/port fallback and matching native credential |

Configuration merges in table order through `OPENCODE_CONFIG_CONTENT`. Comments and
trailing commas are supported. Each file read is limited to 1 MB; non-files,
oversized files, and files that change while read are rejected. An unreadable or
malformed provider configuration is reported rather than silently ignored.
At most 64 provider entries are inspected and eight connections retained.

OpenCode 2's native provider shape is `providers.<id>.settings.baseURL` and
`providers.<id>.settings.apiKey`; OpenCode 1 uses
`provider.<id>.options.baseURL` and `provider.<id>.options.apiKey`. When both
forms define the same provider ID, the native OpenCode 2 entry takes precedence.
Project-level configuration is not resolved, so providers defined only in a
project's `opencode.json(c)` are not discovered.

Endpoints must be HTTP on `127.0.0.1`, `localhost`, or `[::1]`, with an explicit
port and either no path or `/v1`, for example `http://localhost:1234/v1`.
`localhost` is normalized to `127.0.0.1` without DNS. Remote hosts, credentials
inside URLs, query strings, fragments, custom paths, and redirects are rejected.
The oMLX bind address `0.0.0.0` is converted to `127.0.0.1` only when reading its
native server settings.

## Credentials

For each configured provider, the service uses the first available source:

1. `provider.<id>.options.apiKey` or
   `providers.<id>.settings.apiKey`.
2. For a legacy provider entry, the same provider ID's `type: "api"` entry in
   OpenCode's legacy auth file.
3. A populated environment variable named in that provider's `env` list.
4. oMLX's native `auth.api_key`, only when the configured endpoint exactly matches
   the native oMLX origin.

Endpoint and option-key values support `{env:VARIABLE}`, `${VARIABLE}`, and
`{file:path}` references. File references resolve relative to the configuration
file that supplied the field; absolute paths and `~/` are also supported. These
reads have the same file bounds. Relative file references in inline configuration
are unavailable because the extension has no project configuration context; use an
absolute or home-relative reference. Invalid inline credentials are reported rather
than falling back to a stale saved key. An unresolved explicit reference is reported;
it does not silently select another credential.

Environment references work only for variables available to the extension
service. OpenChamber 2 does not forward arbitrary host secrets or shell variables
to installed extension services, so `OPENCODE_CONFIG_DIR` and `XDG_CONFIG_HOME`
may not be available even when they are set for the OpenChamber host process.

OpenCode 2 imports connected credentials into its private database and may leave
the old `auth.json` file behind. MLX Scope does not inspect that database. It
ignores the legacy file for native OpenCode 2 `providers` entries to avoid using
an imported, potentially stale key. For legacy-shaped entries, the old file
fallback remains for compatibility and may not reflect the credential currently
active in OpenCode 2. If the service cannot resolve a supported key source, the
connection reports that a credential is unavailable; it does not guess or read
private credential storage.

Missing keys work only when the runtime already allows key-free access. A supplied
key that is rejected is never retried without authentication. Keys are used only
for their configured local connection and never reach the panel or its storage.

For **oMLX**, monitoring needs the main API key; inference subkeys do not grant
admin access. The service verifies oMLX's health identity before its login. For
**LM Studio**, use an existing API token if Require Authentication is enabled.
MLX Scope does not enable authentication, create tokens, or change permissions.

## Connection help

The monitor distinguishes missing configuration, invalid configuration,
authentication, offline, and unsupported-runtime states and retries automatically.
Keep the configured server on the OpenChamber host; a remote web browser still
observes that host's resources, not the browser's device.

**Check extension service** asks OpenChamber whether its local service is running.
It does not independently test the runtime. **Setup guide** opens this document.
Neither action restarts a service or changes settings.

| Symptom | Next step |
| --- | --- |
| No connection listed | Add a local provider in OpenChamber/OpenCode, then return to MLX Scope |
| Runtime is offline | Start that server on the OpenChamber host; monitoring reconnects automatically |
| API key required or rejected | Reconnect the selected provider with its existing valid key; use oMLX's main key for monitoring |
| Runtime cannot be identified | Choose its runtime in the connection setup; a generic OpenAI-compatible API may lack monitoring endpoints |
| Extension service unavailable | Review its local-service permission in Settings → Extensions |
| Missing Mac readings | The OpenChamber host must run macOS and permit the fixed diagnostic commands |

Unknown readings display `—`, never invented zeroes. Never paste credentials,
auth files, or raw server responses into a public issue.

## Development overrides

An explicitly launched service can use `MLX_SCOPE_BASE_URL`, `MLX_SCOPE_API_KEY`,
`MLX_SCOPE_MODEL`, and `MLX_SCOPE_RUNTIME`. The runtime value is `omlx`, `lmstudio`,
`mlx-lm`, `vllm-mlx`, or `splash`; the default is `omlx`. `OPENCODE_CONFIG` must be absolute.
Absolute `XDG_CONFIG_HOME` and `XDG_DATA_HOME` select alternate roots; relative
values are ignored. An absolute `OPENCODE_CONFIG_DIR` selects the OpenCode 2
global config directory when the service receives it; a relative value is
reported as unsupported rather than silently falling back to the default root.
An explicit base URL uses only its explicit key or an
origin-matched native oMLX key; it never borrows a named provider's credential.
These are isolated development inputs, not extension settings.

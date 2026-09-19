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

A connected inventory view is working: LM Studio and mlx-lm do not expose the
same passive request telemetry as oMLX. Read [Compatibility](COMPATIBILITY.md)
before troubleshooting an unavailable metric.

## Discovery

Files belong to the computer running the OpenChamber server. Provider IDs can be
custom names; they do not have to be `omlx` or another runtime's name.

| Source | Use |
| --- | --- |
| `~/.config/opencode/config.json` | Legacy provider configuration |
| `~/.config/opencode/opencode.json` | Provider URLs, options, and global selected model |
| `~/.config/opencode/opencode.jsonc` | JSONC overlay |
| Absolute `OPENCODE_CONFIG` | Explicit configuration overlay, when available to the service |
| `OPENCODE_CONFIG_CONTENT` | Final inline configuration overlay, when available to the service |
| `~/.local/share/opencode/auth.json` | Saved API keys, matched to the same provider ID; `OPENCODE_AUTH_CONTENT` takes precedence when present |
| `~/.omlx/settings.json` | oMLX server host/port fallback and matching native credential |

Configuration merges in table order through `OPENCODE_CONFIG_CONTENT`. Comments and
trailing commas are supported. Each file read is limited to 1 MB; non-files,
oversized files, and files that change while read are rejected. An unreadable or
malformed provider configuration is reported rather than silently ignored.
At most 64 provider entries are inspected and eight connections retained.
Project-level configuration is not resolved.

Endpoints must be HTTP on `127.0.0.1`, `localhost`, or `[::1]`, with an explicit
port and either no path or `/v1`, for example `http://localhost:1234/v1`.
`localhost` is normalized to `127.0.0.1` without DNS. Remote hosts, credentials
inside URLs, query strings, fragments, custom paths, and redirects are rejected.
The oMLX bind address `0.0.0.0` is converted to `127.0.0.1` only when reading its
native server settings.

## Credentials

For each configured provider, the service uses the first available source:

1. `provider.<id>.options.apiKey`.
2. The same provider ID's `type: "api"` entry in OpenCode's auth file.
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
service. OpenChamber does not forward arbitrary shell variables to installed
services. Use an existing saved provider credential when a variable is unavailable.

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
`mlx-lm`, or `vllm-mlx`; the default is `omlx`. `OPENCODE_CONFIG` must be absolute.
Absolute `XDG_CONFIG_HOME` and `XDG_DATA_HOME` select alternate roots; relative
values are ignored. An explicit base URL uses only its explicit key or an
origin-matched native oMLX key; it never borrows a named provider's credential.
These are isolated development inputs, not extension settings.

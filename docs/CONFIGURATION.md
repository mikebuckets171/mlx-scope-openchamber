# Configuration

MLX Scope reads an existing local connection. It never rewrites OpenChamber,
OpenCode, oMLX, model, cache, or inference settings.

## Discovery

Paths are on the computer running the OpenChamber server:

| File | Purpose |
| --- | --- |
| `~/.config/opencode/opencode.json` | `provider.omlx.options.baseURL` and selected model |
| `~/.config/opencode/opencode.jsonc` | JSONC overlay, merged after JSON |
| `~/.omlx/settings.json` | oMLX server host and port fallback |
| `~/.local/share/opencode/auth.json` | Saved `omlx` API credential |

Each read is limited to 1 MB. Non-files, oversized files, and files that change
while being read are rejected. A malformed explicit configuration does not
silently select another endpoint. Comments and trailing commas are supported.

The endpoint must be HTTP on numeric loopback `127.0.0.1` with an explicit port,
for example `http://127.0.0.1:8000/v1`. The provider’s `/v1` suffix is removed
for dashboard reads. Remote hosts, URL credentials, query strings, fragments,
and redirects are rejected. `localhost` and IPv6 aliases are not accepted.

The provider key must be `omlx`. Project-level overrides, custom provider names,
and OpenCode configuration substitutions are not resolved. Saved credentials use
`omlx.type: "api"` and `omlx.key`; credentials are read only by the service.

## Authentication

The service identifies the local oMLX health response before sending a key.
oMLX dashboard access uses the main API key; an inference subkey does not grant
admin access. With no saved key, monitoring works only if the server already
permits those loopback reads. A rejected supplied key is never retried without
authentication. MLX Scope does not change that policy.

OpenChamber supplies a separate authorization token for its extension service.
Every service route, including health, requires that token.

## Connection help

**Check connection** asks OpenChamber for its service status on demand. A running
service does not establish a working oMLX connection. **Setup guide** opens this
document. Neither action restarts a service or changes settings.

| Symptom | Check |
| --- | --- |
| No connection | oMLX is running on the OpenChamber server’s computer; the configured endpoint matches its numeric loopback URL |
| Authentication required | The existing OpenCode oMLX credential is the main API key and remains valid |
| Service unavailable | The local-service permission in Settings → Extensions is approved |
| Missing Mac readings | The host runs macOS; the fixed `vm_stat` and `sysctl vm.swapusage` reads can complete |
| Missing session totals | Live activity and session statistics can fail independently; retained totals are labelled |
| Missing progress | The engine may not report a current prefill stage; primary DFlash is one example |

Unknown or failed measurements display `—`; they do not become zero. Never paste
credentials, auth files, or raw server responses into a public issue.

## Development overrides

An explicitly launched service can use `MLX_SCOPE_BASE_URL`, `MLX_SCOPE_API_KEY`,
and `MLX_SCOPE_MODEL`. An `OPENCODE_CONFIG` override must be absolute. Absolute
`XDG_CONFIG_HOME` and `XDG_DATA_HOME` select alternate roots; relative values are
ignored.

OpenChamber does not forward arbitrary environment variables to installed
services. These variables support isolated development; they are not normal
extension settings. MLX Scope does not create or modify them.

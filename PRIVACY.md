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
Neither component rewrites configuration files or reads runtime conversation logs.

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

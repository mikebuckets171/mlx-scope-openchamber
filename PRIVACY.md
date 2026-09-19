# Privacy

MLX Scope reads local oMLX activity and host-resource measurements through its
OpenChamber-managed service. It does not upload telemetry, send prompts, change
runtime settings, or run an analytics service.

## Data handled

The service reads only the supported configuration and credential sources listed
in [Configuration](docs/CONFIGURATION.md). Credentials and raw runtime responses
stay service-side. The panel receives allowlisted measurements and bounded model
labels, never prompts, completions, credentials, or raw request identifiers.
Neither the panel nor the service rewrites configuration files.

Chart history, recent generations, and working captures remain in memory.
Interface preferences use OpenChamber extension storage. **Save** stores a
sanitized observation only on user action. The 12 newest summaries are retained;
saving another replaces the oldest when full, as shown by the Save control.
Saved observations include a timestamp and numeric measurements; they exclude
model names, chat content, request identifiers, credentials, and private paths.
**Delete** and **Clear saved** remove them through the same host storage API.

Storage belongs to the OpenChamber host and follows its storage, backup, and
access behavior. A storage failure does not stop monitoring and is reported
without claiming the write succeeded.

## Sharing

**Share → Copy stats** and **Share → Add to chat draft** are explicit actions.
Reports exclude model names, paths, request identifiers, credentials, and
conversation content. Draft sharing appends text, preserves existing text, and
never sends a message. If you later send that draft, its provider receives the
report under that provider’s policies.

**Setup guide** opens this project’s public documentation on GitHub without
telemetry or credentials in the URL. **Check connection** asks OpenChamber for
its local service status. There are no automatic update checks made by MLX Scope;
installation and extension management belong to OpenChamber.

Review screenshots and copied reports before sharing. Never attach auth files,
raw server responses, or private conversations to a public issue.

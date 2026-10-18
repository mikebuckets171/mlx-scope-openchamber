# ComfyUI progress helper

MLX Scope's optional helper exposes one authenticated, read-only custom route.
Enable it in **Connections → ComfyUI → Enable detailed media progress**. Setup
installs `__init__.py`, `snapshot.py`, and a private `scope-token` into
`custom_nodes/mlx_scope`. A running ComfyUI loads it next time it starts normally;
Scope never restarts ComfyUI. Basic queue monitoring works without the helper.

The helper initially qualifies **ComfyUI 0.38.0**. Other versions return
`supported: false`; Scope keeps basic lifecycle monitoring available. It does
not submit workflows, import nodes, open WebSockets, attach progress handlers,
run threads, poll in the background, or write telemetry. Its only work happens
when the visible Scope service requests a snapshot.

`GET /mlx-scope/v1/progress` requires a loopback connection and
`Authorization: Bearer <scope-token>`. The token is installed with mode `0600`;
missing, symlinked, shared, malformed, or oversized token files disable access.
The browser never receives the token. Responses use `Cache-Control: no-store`.

```json
{
  "schemaVersion": 1,
  "helperVersion": "1.0.0",
  "comfyVersion": "0.38.0",
  "supported": true,
  "observedAtMs": 1800000000000,
  "jobs": [{
    "promptId": "backend-job-id",
    "nodeId": "12",
    "phase": "sampling",
    "progress": {"value": 3, "total": 20, "unit": "steps"}
  }]
}
```

The `jobs` entries represent **current nodes within a running job**, not whole
workflow progress. Only a registry matching the running queue is accepted.
Reads are bounded to 1,024 registry entries and at most 16 running nodes. The
helper discards snapshots if the active registry or prompt changes during a
read. No workflow inputs, images, output paths, prompts, or credentials are
returned.

`progress` is optional. ComfyUI's synthetic `0 / 1` start counter and invalid
counters remain indeterminate. Only the qualified built-in `KSampler`,
`KSamplerAdvanced`, `SamplerCustom`, and `SamplerCustomAdvanced` classes use
`steps`. Other counters use `units`. Encoder/decoder phases are identified only
for known VAE node classes; unknown nodes remain `working`.

`observedAtMs` is the snapshot time. The registry supplies no update timestamp,
so the helper does not fabricate one; Scope separately records when it first
observes counter changes. A successful repeated read does not mean a counter
advanced.

CPU-only tests: `python3 -m unittest discover -s bridge/comfyui -p 'test_*.py'`.
They use in-memory queue/registry/HTTP stubs and never import an inference stack.

The implementation uses ComfyUI's documented [custom route mechanism](https://docs.comfy.org/development/comfyui-server/comms_routes)
and qualifies the [0.38.0 progress registry](https://github.com/Comfy-Org/ComfyUI/blob/v0.38.0/comfy_execution/progress.py).

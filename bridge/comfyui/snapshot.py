"""Passive, bounded ComfyUI progress snapshots. No GPU imports or callbacks."""
from __future__ import annotations

import math
import re
from itertools import islice

HELPER_VERSION = "1.0.0"
QUALIFIED_VERSION = "0.38.0"
MAX_NODES = 16
MAX_REGISTRY_NODES = 1024
_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
_SAMPLERS = frozenset({"KSampler", "KSamplerAdvanced", "SamplerCustom", "SamplerCustomAdvanced"})
_DECODERS = frozenset({"VAEDecode", "VAEDecodeTiled"})
_ENCODERS = frozenset({"VAEEncode", "VAEEncodeTiled", "VAEEncodeForInpaint"})


def identifier(value):
    return value if isinstance(value, str) and _ID.fullmatch(value) else None


def _running_ids(queue):
    """Use the qualified queue mutex; never copy pending workflows or history."""
    with queue.mutex:
        return {item[1] for item in islice(queue.currently_running.values(), MAX_NODES)
                if isinstance(item, (tuple, list)) and len(item) > 1 and identifier(item[1])}


def _finite_number(value):
    return isinstance(value, (float, int)) and not isinstance(value, bool) and math.isfinite(value)


def snapshot(progress_module, queue, version, observed_at_ms):
    """Take one read; discard it if the registry or running prompt changes meanwhile.

    The registry has no native update timestamps. This response records read time
    only; the consumer can separately track when it observes a counter changing.
    """
    result = {"schemaVersion": 1, "helperVersion": HELPER_VERSION,
              "comfyVersion": version if isinstance(version, str) else "unknown",
              "supported": version == QUALIFIED_VERSION,
              "observedAtMs": observed_at_ms, "jobs": []}
    if not result["supported"]:
        return result
    # Calling get_progress_state() would create a registry: never call it here.
    registry = getattr(progress_module, "global_progress_registry", None)
    if registry is None:
        return result
    try:
        prompt_id = identifier(registry.prompt_id)
        if not prompt_id or prompt_id not in _running_ids(queue):
            return result
        nodes = list(islice(registry.nodes.items(), MAX_REGISTRY_NODES))
        jobs = []
        for node_id, mutable_state in nodes:
            node_id = identifier(node_id)
            state = dict(mutable_state)
            if not node_id or getattr(state.get("state"), "value", state.get("state")) != "running":
                continue
            # Read only class_type. Never return node inputs, names, outputs or workflow content.
            node = registry.dynprompt.get_node(node_id)
            class_type = node.get("class_type") if isinstance(node, dict) else None
            phase = ("sampling" if class_type in _SAMPLERS else
                     "decoding" if class_type in _DECODERS else
                     "encoding-references" if class_type in _ENCODERS else "working")
            job = {"promptId": prompt_id, "nodeId": node_id, "phase": phase}
            value, total = state.get("value"), state.get("max")
            # start_progress inserts synthetic 0/1. A real single-unit 0/1 is
            # indistinguishable, so conservatively show indeterminate progress.
            if (_finite_number(value) and _finite_number(total)
                    and 0 <= value <= total <= 1_000_000_000 and total > 0
                    and (value, total) != (0, 1)):
                job["progress"] = {"value": value, "total": total,
                                   "unit": "steps" if class_type in _SAMPLERS else "units"}
            jobs.append(job)
            if len(jobs) == MAX_NODES:
                break
        if (getattr(progress_module, "global_progress_registry", None) is not registry
                or registry.prompt_id != prompt_id or prompt_id not in _running_ids(queue)):
            return result
        result["jobs"] = jobs
    except (AttributeError, KeyError, RuntimeError, TypeError, ValueError):
        # A concurrently replaced graph or incompatible registry exposes no old reading.
        result["jobs"] = []
    return result

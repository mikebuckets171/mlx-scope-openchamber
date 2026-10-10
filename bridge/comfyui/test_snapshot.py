"""CPU-only fixtures: no ComfyUI, torch, GPU, backend or HTTP server required."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location("scope_snapshot", Path(__file__).with_name("snapshot.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Queue:
    def __init__(self, prompt="prompt-1"):
        self.mutex = threading.RLock()
        self.prompt = prompt

    @property
    def currently_running(self):
        return {0: (0, self.prompt, {"sensitive": "never expose"})}


def registry(value=3, total=20, class_type="KSampler", state="running"):
    return SimpleNamespace(prompt_id="prompt-1", nodes={"12": {"state": state, "value": value, "max": total}},
                           dynprompt=SimpleNamespace(get_node=lambda _: {"class_type": class_type,
                                                                          "inputs": {"text": "SECRET"}}))


class SnapshotTests(unittest.TestCase):
    def read(self, reg=None, queue=None, version="0.38.0"):
        return MODULE.snapshot(SimpleNamespace(global_progress_registry=reg), queue or Queue(), version, 123456)

    def test_sampler_phase_local_progress_and_sanitization(self):
        result = self.read(registry())
        self.assertEqual(result["jobs"], [{"promptId": "prompt-1", "nodeId": "12", "phase": "sampling",
                                          "progress": {"value": 3, "total": 20, "unit": "steps"}}])
        self.assertEqual(result["observedAtMs"], 123456)
        self.assertNotIn("SECRET", json.dumps(result))
        self.assertNotIn("progressChangedAtMs", json.dumps(result))

    def test_synthetic_and_bad_numbers_are_indeterminate(self):
        for value, total in [(0, 1), (float("nan"), 5), (2, float("inf")), (-1, 5), (6, 5),
                             (True, 5), (1, False), (1, 0), ("2", 20), (1, 10**20)]:
            with self.subTest(value=value, total=total):
                self.assertNotIn("progress", self.read(registry(value, total))["jobs"][0])

    def test_unknown_units_are_not_steps(self):
        job = self.read(registry(class_type="UnqualifiedSampler"))["jobs"][0]
        self.assertEqual(job["phase"], "working")
        self.assertEqual(job["progress"]["unit"], "units")

    def test_encoders_decoders_have_truthful_phase(self):
        for cls, phase in [("VAEEncodeTiled", "encoding-references"), ("VAEDecode", "decoding")]:
            job = self.read(registry(class_type=cls))["jobs"][0]
            self.assertEqual(job["phase"], phase)
            self.assertEqual(job["progress"]["unit"], "units")

    def test_finished_pending_and_mismatched_jobs_are_withdrawn(self):
        for state in ["finished", "pending", "error"]:
            self.assertEqual(self.read(registry(state=state))["jobs"], [])
        self.assertEqual(self.read(registry(), Queue("another-job"))["jobs"], [])

    def test_unsupported_version_does_not_touch_queue_or_registry(self):
        for version in ["0.37.0", "0.38.1", None]:
            result = self.read(registry(), object(), version)
            self.assertFalse(result["supported"])
            self.assertEqual(result["jobs"], [])

    def test_idle_read_does_not_create_registry(self):
        self.assertEqual(self.read()["jobs"], [])

    def test_running_changes_during_read(self):
        queue = Queue()
        reg = registry()
        def changed(_):
            queue.prompt = "successor"
            return {"class_type": "KSampler"}
        reg.dynprompt.get_node = changed
        self.assertEqual(self.read(reg, queue)["jobs"], [])

    def test_registry_replaced_during_read(self):
        reg = registry()
        module = SimpleNamespace(global_progress_registry=reg)
        def replaced(_):
            module.global_progress_registry = registry()
            return {"class_type": "KSampler"}
        reg.dynprompt.get_node = replaced
        self.assertEqual(MODULE.snapshot(module, Queue(), "0.38.0", 1)["jobs"], [])

    def test_bounded_snapshot_includes_running_after_finished_nodes(self):
        reg = registry()
        reg.nodes = {str(i): {"state": "finished", "value": 1, "max": 1} for i in range(100)}
        reg.nodes.update({str(i): {"state": "running", "value": 3, "max": 20} for i in range(100, 2000)})
        result = self.read(reg)
        self.assertEqual(len(result["jobs"]), 16)
        self.assertEqual(result["jobs"][0]["nodeId"], "100")

    def test_malformed_registry_returns_no_reading(self):
        reg = registry()
        reg.nodes = None
        self.assertEqual(self.read(reg)["jobs"], [])


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.route = None
        def get(path):
            self.assertEqual(path, "/mlx-scope/v1/progress")
            def register(fn):
                self.route = fn
                return fn
            return register
        class Unauthorized(Exception):
            pass
        server = SimpleNamespace(PromptServer=SimpleNamespace(instance=SimpleNamespace(
            routes=SimpleNamespace(get=get), prompt_queue=Queue())))
        self.fakes = {"server": server, "aiohttp": SimpleNamespace(web=SimpleNamespace(
            HTTPUnauthorized=Unauthorized, json_response=lambda value, **kwargs: (value, kwargs))),
            "comfyui_version": SimpleNamespace(__version__="0.38.0"),
            "comfy_execution.progress": SimpleNamespace(global_progress_registry=registry())}
        self.patch = mock.patch.dict(sys.modules, self.fakes)
        self.patch.start()
        spec = importlib.util.spec_from_file_location("scope_route", Path(__file__).with_name("__init__.py"),
                                                     submodule_search_locations=[str(Path(__file__).parent)])
        self.module = importlib.util.module_from_spec(spec)
        sys.modules["scope_route"] = self.module
        spec.loader.exec_module(self.module)
        self.tmp = tempfile.TemporaryDirectory()
        self.token = Path(self.tmp.name) / "scope-token"
        self.token.write_text("a" * 64)
        self.token.chmod(0o600)
        self.module._TOKEN_PATH = self.token

    def tearDown(self):
        self.tmp.cleanup()
        self.patch.stop()
        sys.modules.pop("scope_route", None)
        sys.modules.pop("scope_route.snapshot", None)

    def request(self, remote="127.0.0.1", bearer=None):
        return SimpleNamespace(remote=remote, headers={"Authorization": bearer or "Bearer " + "a" * 64})

    def test_authenticated_loopback_route_and_no_cache(self):
        response, options = asyncio.run(self.route(self.request()))
        self.assertTrue(response["supported"])
        self.assertEqual(options["headers"], {"Cache-Control": "no-store"})

    def test_remote_and_missing_or_wrong_token_rejected(self):
        for req in [self.request(remote="192.0.2.1"), self.request(remote=None), self.request(bearer="Bearer bad"),
                    self.request(bearer="Bearer é"), self.request(bearer="x" * 300)]:
            with self.assertRaises(self.fakes["aiohttp"].web.HTTPUnauthorized):
                asyncio.run(self.route(req))

    def test_token_permissions_and_symlink_fail_closed(self):
        self.token.chmod(0o644)
        self.assertIsNone(self.module._token())
        self.token.chmod(0o600)
        link = Path(self.tmp.name) / "link"
        link.symlink_to(self.token)
        self.module._TOKEN_PATH = link
        self.assertIsNone(self.module._token())

    def test_import_installs_no_handlers_and_exports_no_nodes(self):
        self.assertEqual(self.module.NODE_CLASS_MAPPINGS, {})
        self.assertEqual(self.module.NODE_DISPLAY_NAME_MAPPINGS, {})
        self.assertIsNotNone(self.route)


if __name__ == "__main__":
    unittest.main()

"""MLX Scope optional ComfyUI helper: an authenticated read-only custom route."""
from __future__ import annotations

import hmac
import ipaddress
import os
import stat
import sys
import time
from pathlib import Path

from aiohttp import web
from server import PromptServer

from .snapshot import snapshot

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
_TOKEN_PATH = Path(__file__).with_name("scope-token")


def _token():
    """A missing, shared, oversized or symlinked token leaves the route disabled."""
    try:
        fd = os.open(_TOKEN_PATH, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0))
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or not 32 <= info.st_size <= 256):
                return None
            value = os.read(fd, 257).decode("ascii").strip()
            return value if 32 <= len(value) <= 128 and value.isalnum() else None
        finally:
            os.close(fd)
    except (OSError, UnicodeError):
        return None


def _authorized(request):
    try:
        if not ipaddress.ip_address(request.remote).is_loopback:
            return False
    except (ValueError, TypeError):
        return False
    token = _token()
    supplied = request.headers.get("Authorization", "")
    return bool(token and isinstance(supplied, str) and len(supplied) <= 256
                and hmac.compare_digest(supplied.encode("utf-8"), f"Bearer {token}".encode("ascii")))


@PromptServer.instance.routes.get("/mlx-scope/v1/progress")
async def scope_progress(request):
    if not _authorized(request):
        raise web.HTTPUnauthorized()
    # Both modules belong to the running host. No node imports, GPU calls,
    # progress callbacks, background tasks, sockets or telemetry writes.
    import comfyui_version
    progress = sys.modules.get("comfy_execution.progress")
    result = snapshot(progress, PromptServer.instance.prompt_queue,
                      comfyui_version.__version__, round(time.time() * 1000))
    return web.json_response(result, headers={"Cache-Control": "no-store"})

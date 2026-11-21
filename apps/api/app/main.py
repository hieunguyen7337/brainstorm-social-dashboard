"""App entry point. Routers are discovered by module name, so each unit only adds its own files."""

import asyncio
import contextlib
import importlib
import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse

from app.config import settings
from app.db import connect, init_db

log = logging.getLogger("pulse")

# (module, attribute). A missing module is skipped so units can land in any order.
ROUTERS = [
    ("app.routes.workspaces", "router"),
    ("app.routes.dashboard", "router"),
    ("app.routes.posts", "router"),
    ("app.routes.links", "router"),
    ("app.routes.generate", "router"),
    ("app.routes.autopilot", "router"),
    ("app.routes.trends", "router"),
    ("app.routes.insights", "router"),
    ("app.routes.metrics", "router"),
    ("app.routes.billing", "router"),
    ("app.routes.rooms", "router"),
    ("app.routes.share", "router"),
    ("app.routes.autoread_trace", "router"),
    ("app.routes.browser", "router"),
]


def _optional(module: str, attr: str):
    try:
        return getattr(importlib.import_module(module), attr)
    except ModuleNotFoundError as exc:
        if exc.name and module.startswith(exc.name):
            return None
        raise


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    conn = connect()
    init_db(conn)
    conn.close()
    tasks = []
    loop_fn = _optional("app.services.autopilot", "autopilot_loop")
    if loop_fn is not None and os.environ.get("PULSE_DISABLE_LOOPS") != "1":
        tasks.append(asyncio.create_task(loop_fn()))
    mcp_lifespan = getattr(app.state, "mcp_lifespan", None)
    if mcp_lifespan is not None:
        async with mcp_lifespan():
            yield
    else:
        yield
    for t in tasks:
        t.cancel()


def create_app() -> FastAPI:
    app = FastAPI(title=settings.app_name, version=settings.version, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
    )

    @app.get("/api/health")
    def health():
        return {"ok": True, "app": settings.app_name, "version": settings.version}

    @app.get("/download/android")
    def download_android():
        if not settings.android_apk_url:
            return JSONResponse({"detail": "APK not published yet"}, status_code=404)
        return RedirectResponse(settings.android_apk_url, status_code=302)

    for module, attr in ROUTERS:
        router = _optional(module, attr)
        if router is not None:
            app.include_router(router)

    mount_mcp = _optional("app.mcp_server", "mount_mcp")
    if mount_mcp is not None:
        mount_mcp(app)  # mounts /mcp; may set app.state.mcp_lifespan

    _mount_web(app)
    return app


def _mount_web(app: FastAPI) -> None:
    dist = os.path.abspath(settings.web_dist)

    @app.get("/{path:path}", include_in_schema=False)
    def web(path: str):
        if path.startswith(("api/", "mcp", "r/", "l/")):
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        candidate = os.path.normpath(os.path.join(dist, path))
        if candidate.startswith(dist) and os.path.isfile(candidate):
            return FileResponse(candidate)
        for html in (candidate + ".html", os.path.join(dist, "index.html")):
            if html.startswith(dist) and os.path.isfile(html):
                return FileResponse(html)
        return JSONResponse({"detail": "web app not built"}, status_code=404)


app = create_app()

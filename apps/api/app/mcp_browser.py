"""MCP tools that drive the signed-in browser inside the Pulse app on the user's Android phone.

Each tool queues one command with POST /api/browser/commands and waits for the phone's answer with
GET /api/browser/commands/{id} (see app/routes/browser.py). Registered by mount_mcp in app/mcp_server.py.
"""

from __future__ import annotations

import base64
import binascii
import json
import time
from collections.abc import Awaitable, Callable
from typing import Any

from mcp.server.fastmcp import Context, FastMCP, Image

CallFn = Callable[..., Awaitable[Any]]

TOTAL_WAIT_S = 50.0
STEP_WAIT_S = 20.0

BROWSER_RULES = (
    "Rules for the phone browser tools: they act in the user's own signed-in accounts on their phone, and the user "
    "sees every step. Only do what the user asked for. Never type a password or a one-time code (the phone refuses "
    "password fields): if a login page shows, ask the user to sign in on their phone themselves. Before you post, "
    "comment, like, follow or message anyone, show the user the exact text and get a clear yes in this chat."
)

STATUS_DOC = (
    "Is the user's phone browser connected? Pulse can only click and type on the phone while the user has Settings > "
    "\"Let Claude use your phone's browser\" open in the Pulse Android app. Returns connected, the page it is on and "
    "how many commands are waiting. Check it before the other browser_* tools."
)


def _compact(data: Any) -> str:
    return json.dumps(data, separators=(",", ":"), default=str)


def register_browser_tools(mcp: FastMCP, call: CallFn, error_cls: type[Exception]) -> None:
    async def run(ctx: Context, action: str, args: dict[str, Any] | None = None) -> dict[str, Any]:
        cmd = await call(ctx, "POST", "/api/browser/commands", body={"action": action, "args": args or {}})
        cid = cmd["id"]
        deadline = time.monotonic() + TOTAL_WAIT_S
        while True:
            left = deadline - time.monotonic()
            res = await call(
                ctx, "GET", f"/api/browser/commands/{cid}", params={"wait": max(0.0, min(STEP_WAIT_S, left))}
            )
            if res.get("status") == "done":
                result = res.get("result") or {}
                if not result.get("ok"):
                    raise error_cls(f"The phone could not {action}: {result.get('error') or 'unknown error'}")
                return result
            if left <= 0:
                raise error_cls(
                    f"The phone has not finished '{action}' after {int(TOTAL_WAIT_S)} s. Call browser_status, "
                    "then browser_screenshot to see where it is."
                )

    def summary(result: dict[str, Any], **extra: Any) -> str:
        out = {k: result[k] for k in ("url", "title") if result.get(k)}
        out.update({k: v for k, v in extra.items() if v is not None})
        return _compact(out)

    @mcp.tool(description=STATUS_DOC + " " + BROWSER_RULES)
    async def browser_status(ctx: Context) -> str:
        return _compact(await call(ctx, "GET", "/api/browser/status"))

    @mcp.tool()
    async def browser_open(ctx: Context, url: str) -> str:
        """Open an https:// page in the user's signed-in phone browser (for example
        https://www.instagram.com/ or https://www.linkedin.com/feed/). Use this when Pulse's automatic readers
        or posters failed. Waits for the page to load; then call browser_screenshot or browser_read_text."""
        return summary(await run(ctx, "open", {"url": url}))

    @mcp.tool()
    async def browser_back(ctx: Context) -> str:
        """Go back one page in the phone browser."""
        return summary(await run(ctx, "back"))

    @mcp.tool(structured_output=False)
    async def browser_screenshot(ctx: Context) -> list:
        """See the phone browser: returns a JPEG of the page as the user sees it, plus its url and title.
        x/y coordinates for browser_click are pixels in THIS image (0,0 is the top-left corner)."""
        result = await run(ctx, "screenshot")
        raw = result.get("image_jpeg_base64") or ""
        try:
            data = base64.b64decode(raw, validate=True)
        except (binascii.Error, ValueError):
            data = b""
        if not data:
            raise error_cls("The phone sent no screenshot.")
        info = summary(
            result,
            width=result.get("width"),
            height=result.get("height"),
            note="browser_click x/y are pixels in this image",
        )
        return [info, Image(data=data, format="jpeg")]

    @mcp.tool()
    async def browser_read_text(ctx: Context) -> str:
        """The visible text of the current phone page (document.body.innerText, at most 30,000 characters),
        with its url and title. Cheaper than a screenshot for reading numbers."""
        result = await run(ctx, "read_text")
        return _compact({k: result.get(k) for k in ("url", "title", "text") if result.get(k) is not None})

    @mcp.tool()
    async def browser_elements(ctx: Context) -> str:
        """List the clickable and typeable elements visible on the phone page (links, buttons, inputs, text
        boxes), each with its label and its centre x/y in screenshot pixels, ready for browser_click."""
        result = await run(ctx, "elements")
        return _compact({k: result.get(k) for k in ("url", "title", "data") if result.get(k) is not None})

    @mcp.tool()
    async def browser_click(
        ctx: Context,
        x: float | None = None,
        y: float | None = None,
        selector: str | None = None,
        text: str | None = None,
    ) -> str:
        """Tap something on the phone page. Give either x and y (pixels in the last browser_screenshot, or the
        x/y from browser_elements), or a CSS `selector`, or the element's visible `text` (for example
        text="Post" or text="Followers"). Returns what was clicked and the page url afterwards."""
        args: dict[str, Any] = {}
        if x is not None or y is not None:
            args.update(x=x, y=y)
        if selector:
            args["selector"] = selector
        if text:
            args["text"] = text
        result = await run(ctx, "click", args)
        return summary(result, clicked=result.get("text"))

    @mcp.tool()
    async def browser_type(ctx: Context, text: str, selector: str | None = None, clear: bool = False) -> str:
        """Type `text` into the focused field on the phone page, or into the one matching the CSS `selector`
        (click it first if nothing is focused). Works in post composers (contenteditable). `clear` empties the
        field first. Refuses password fields. Does not press Enter: use browser_press("Enter") for that."""
        args: dict[str, Any] = {"text": text, "clear": clear}
        if selector:
            args["selector"] = selector
        result = await run(ctx, "type", args)
        return summary(result, typed_into=result.get("text"))

    @mcp.tool()
    async def browser_press(ctx: Context, key: str) -> str:
        """Press a key on the phone page: Enter, Tab, Escape, Backspace, ArrowUp, ArrowDown, ArrowLeft,
        ArrowRight, PageUp, PageDown, Home or End."""
        return summary(await run(ctx, "press", {"key": key}))

    @mcp.tool()
    async def browser_scroll(ctx: Context, dy: float = 600, dx: float = 0) -> str:
        """Scroll the phone page by `dy` CSS pixels (positive is down, negative is up). Returns the new scroll
        position."""
        result = await run(ctx, "scroll", {"dy": dy, "dx": dx})
        return summary(result, position=result.get("text"))

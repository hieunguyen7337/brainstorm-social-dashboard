"""Pulse harvest: read YOUR OWN LinkedIn / Instagram numbers from YOUR OWN logged-in Chrome and send them
to your Pulse workspace.

    python harvest.py --api https://<host> --token <token> --platform all \
        --profile-url https://www.linkedin.com/in/<you>/ --profile-url https://www.instagram.com/<you>/

It attaches to a Chrome you started yourself with --remote-debugging-port (see README.md), reads a
handful of pages at human pace, and posts the numbers to /api/metrics/ingest. It never asks for or stores a
password and never writes to any social network. The workspace token only travels in the Authorization
header. Standard library only at import time; Playwright is imported lazily when a browser is needed, so
--help, --dry-run --from-json and the tests work without it.

Exit codes: 0 success, 2 a platform needs you to log in (rerun after logging in), 1 any other failure.
"""

from __future__ import annotations

import argparse
import contextlib
import importlib
import json
import os
import sys
import urllib.error
import urllib.request
from urllib.parse import urlparse

try:  # imported as part of the tools.harvest package
    from . import common
except ImportError:  # run as a script (python harvest.py) or with this folder on sys.path
    import common

DEFAULT_API = "http://localhost:8000"
DEFAULT_CDP = "http://127.0.0.1:9222"
PLATFORMS = ("linkedin", "instagram")
DOMAINS = {"linkedin": "linkedin.com", "instagram": "instagram.com"}
PLATFORM_MAX_POSTS = {"linkedin": 30, "instagram": 12}
MAX_BODY_POSTS = 500  # the API accepts at most this many posts per ingest call
HTTP_TIMEOUT = 30  # seconds
SOURCE = "script"

ACCOUNT_KEYS = ("followers", "views", "engagements", "clicks", "profile_views")
POST_TEXT_KEYS = ("external_id", "url", "content", "posted_at")
POST_COUNT_KEYS = ("views", "engagements", "clicks", "conversions")


class CliError(Exception):
    """A problem to show the user as one message (exit code 1)."""


class ChromeError(CliError):
    """Chrome cannot be reached or used. Every remaining browser step would fail the same way."""


class PayloadError(CliError):
    """The data to send is not valid."""


class ApiError(CliError):
    """The Pulse API answered with an HTTP error status."""

    def __init__(self, status: int, detail: str):
        super().__init__(f"{status}: {detail}")
        self.status = status
        self.detail = detail


class ApiUnreachable(CliError):
    """The Pulse API could not be reached at all. Every remaining call would fail the same way."""


# --------------------------------------------------------------------------------------- helpers


def _err(*parts: object) -> None:
    print(*parts, file=sys.stderr, flush=True)


def platform_for_url(url: str) -> str | None:
    """'linkedin' / 'instagram' from the URL's host (equals the domain or is a subdomain of it, the same rule
    the API uses), else None. `evil-linkedin.com` and `linkedin.com.evil.com` do not match."""
    try:
        parsed = urlparse(url.strip())
        host = (parsed.hostname or "").lower().rstrip(".")
    except ValueError:
        return None
    if parsed.scheme not in ("http", "https") or not host:
        return None
    for platform, domain in DOMAINS.items():
        if host == domain or host.endswith("." + domain):
            return platform
    return None


def chrome_start_help(cdp: str) -> str:
    try:
        port = urlparse(cdp).port or 9222
    except ValueError:
        port = 9222
    return (
        "Start it first (then log in to LinkedIn and Instagram in that window):\n"
        f'  Windows: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" '
        f'--remote-debugging-port={port} --user-data-dir="C:\\pulse-chrome"\n'
        f"  macOS:   /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome "
        f'--remote-debugging-port={port} --user-data-dir="$HOME/pulse-chrome"\n'
        f"  Linux:   google-chrome --remote-debugging-port={port} --user-data-dir=$HOME/pulse-chrome"
    )


def _first_line(exc: object, limit: int = 200) -> str:
    lines = str(exc).strip().splitlines()
    return (lines[0] if lines else type(exc).__name__)[:limit]


# ------------------------------------------------------------------------------------ validation


def _as_count(value: object, where: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise PayloadError(f"{where} must be a whole number of 0 or more, got {value!r}")
    if isinstance(value, float):
        if not value.is_integer():
            raise PayloadError(f"{where} must be a whole number of 0 or more, got {value!r}")
        value = int(value)
    if value < 0:
        raise PayloadError(f"{where} must be a whole number of 0 or more, got {value!r}")
    return value


def sanitize_payload(raw: object) -> dict:
    """Validate `{"account": {...}, "posts": [...]}` and return a copy holding only the keys the API knows.
    Counts must be ints >= 0 (negative or fractional numbers are rejected, never guessed at), at most 500
    posts, unknown keys are dropped, empty values are left out."""
    if not isinstance(raw, dict):
        raise PayloadError('the data must be a JSON object like {"account": {...}, "posts": [...]}')
    account_raw = raw.get("account")
    if account_raw is None:
        account_raw = {}
    if not isinstance(account_raw, dict):
        raise PayloadError('"account" must be an object')
    account = {}
    for key in ACCOUNT_KEYS:
        if account_raw.get(key) is not None:
            account[key] = _as_count(account_raw[key], f"account.{key}")

    posts_raw = raw.get("posts")
    if posts_raw is None:
        posts_raw = []
    if not isinstance(posts_raw, list):
        raise PayloadError('"posts" must be a list')
    if len(posts_raw) > MAX_BODY_POSTS:
        raise PayloadError(f"too many posts: {len(posts_raw)} (at most {MAX_BODY_POSTS} per run)")
    posts = []
    for i, post_raw in enumerate(posts_raw):
        if not isinstance(post_raw, dict):
            raise PayloadError(f"posts[{i}] must be an object")
        post: dict = {}
        for key in POST_TEXT_KEYS:
            value = post_raw.get(key)
            if value is None or value == "":
                continue
            if not isinstance(value, str):
                raise PayloadError(f"posts[{i}].{key} must be text, got {value!r}")
            post[key] = value
        for key in POST_COUNT_KEYS:
            if post_raw.get(key) is not None:
                post[key] = _as_count(post_raw[key], f"posts[{i}].{key}")
        posts.append(post)
    return {"account": account, "posts": posts}


# --------------------------------------------------------------------------------------- Pulse API


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow redirects: the Authorization header must only ever go to the address the user typed."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _urlopen(req: urllib.request.Request, timeout: float):
    return urllib.request.build_opener(_NoRedirect).open(req, timeout=timeout)


def _format_detail(detail: object) -> str:
    """FastAPI puts a string, or a list of {loc, msg} validation errors, in `detail`."""
    if isinstance(detail, str):
        return detail
    if isinstance(detail, list):
        parts = []
        for item in detail:
            if isinstance(item, dict) and "msg" in item:
                loc = ".".join(str(p) for p in item.get("loc", ()) if p != "body")
                parts.append(f"{loc}: {item['msg']}" if loc else str(item["msg"]))
            else:
                parts.append(json.dumps(item))
        return "; ".join(parts)
    return json.dumps(detail)


def _http_error_detail(exc: urllib.error.HTTPError) -> str:
    if 300 <= exc.code < 400:
        where = exc.headers.get("Location") if exc.headers else None
        return f"redirected to {where}; use that address for --api" if where else "unexpected redirect"
    try:
        text = exc.read(4000).decode("utf-8", "replace").strip()
    except Exception:  # noqa: BLE001 - the body is optional
        text = ""
    try:
        body = json.loads(text)
    except ValueError:
        return text[:300] or str(exc.reason or "error")
    if isinstance(body, dict) and "detail" in body:
        return _format_detail(body["detail"])
    return text[:300]


def _request(method: str, url: str, token: str, body: dict) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "pulse-harvest/1",
        },
    )
    try:
        with _urlopen(req, HTTP_TIMEOUT) as resp:
            raw = resp.read()
            status = getattr(resp, "status", 200)
    except urllib.error.HTTPError as exc:
        raise ApiError(exc.code, _http_error_detail(exc)) from None
    except OSError as exc:  # URLError, timeouts, connection refused
        parsed = urlparse(url)
        raise ApiUnreachable(
            f"Could not reach the Pulse API at {parsed.scheme}://{parsed.netloc}: "
            f"{_first_line(getattr(exc, 'reason', exc))}"
        ) from None
    try:
        data = json.loads(raw) if raw else {}
    except ValueError:
        raise ApiError(status, "the API did not answer with JSON (is --api the right address?)") from None
    return data if isinstance(data, dict) else {}


def _put(url: str, token: str, body: dict) -> dict:
    return _request("PUT", url, token, body)


def _post(url: str, token: str, body: dict) -> dict:
    return _request("POST", url, token, body)


# ------------------------------------------------------------------------------- browser / harvest


@contextlib.contextmanager
def _chrome_context(cdp_url: str):
    """Attach to the user's own Chrome and yield its default context (the one that holds their logins).
    Playwright is imported here, lazily. Leaving the block only disconnects: the browser and the context are
    never closed."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise ChromeError(
            "The 'playwright' package is not installed. Run: pip install -r tools/harvest/requirements.txt"
        ) from None
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(cdp_url, timeout=15_000)
        if not browser.contexts:
            raise ChromeError(
                f"Chrome at {cdp_url} has no browser window open. " + chrome_start_help(cdp_url)
            )
        yield browser.contexts[0]


def _load_platform(platform: str):
    """Import linkedin.py / instagram.py lazily so a missing one gives a clear message."""
    try:
        if __package__:
            return importlib.import_module(f".{platform}", __package__)
        return importlib.import_module(platform)
    except ImportError as exc:
        raise CliError(f"cannot load the {platform} reader ({platform}.py): {_first_line(exc)}") from None


def _default_harvest(platform: str, context, url: str, *, max_posts: int, log) -> dict:
    return _load_platform(platform).harvest(context, url, max_posts=max_posts, log=log)


def _harvester_for(platform: str, harvesters):
    if harvesters is None:
        # resolve the module now so a missing one fails before anything is sent
        module = _load_platform(platform)
        return lambda context, url, *, max_posts, log: module.harvest(
            context, url, max_posts=max_posts, log=log
        )
    fn = harvesters(platform) if callable(harvesters) else harvesters.get(platform)
    if fn is None:
        raise CliError(f"no reader available for {platform}")
    return fn


# ----------------------------------------------------------------------------------------- CLI


class _Parser(argparse.ArgumentParser):
    def error(self, message):  # bad arguments exit 1 (exit code 2 is reserved for "log in first")
        self.print_usage(sys.stderr)
        self.exit(1, f"{self.prog}: error: {message}\n")


def build_parser() -> argparse.ArgumentParser:
    p = _Parser(
        prog="harvest.py",
        allow_abbrev=False,
        description=(
            "Read your own LinkedIn / Instagram numbers from your own logged-in Chrome and send them to "
            "Pulse. Read-only, human pace, no passwords."
        ),
        epilog="Exit codes: 0 ok, 2 log in in that Chrome window then rerun, 1 any other error.",
    )
    p.add_argument("--api", help="Pulse API base URL (default: $PULSE_API, else http://localhost:8000)")
    p.add_argument("--token", help="workspace token (default: $PULSE_TOKEN)")
    p.add_argument(
        "--platform",
        choices=(*PLATFORMS, "all"),
        default="all",
        help="which platform to harvest (default: all of those you give a --profile-url for)",
    )
    p.add_argument(
        "--profile-url",
        action="append",
        default=[],
        metavar="URL",
        help="your own profile URL; repeat for LinkedIn and Instagram (the platform comes from the host)",
    )
    p.add_argument(
        "--cdp", default=DEFAULT_CDP, help="Chrome remote-debugging address (default: %(default)s)"
    )
    p.add_argument("--dry-run", action="store_true", help="print the body that would be sent; call no API")
    p.add_argument(
        "--from-json",
        metavar="FILE",
        help="use a saved payload instead of opening Chrome (one payload, or {linkedin: ..., instagram: ...})",
    )
    p.add_argument(
        "--max-posts",
        type=int,
        metavar="N",
        help="posts to read per platform (default and maximum: 30 LinkedIn, 12 Instagram)",
    )
    return p


def _plan(args) -> list[tuple[str, str]]:
    """[(platform, profile_url)] to run, from --platform and the --profile-url values."""
    by_platform: dict[str, str] = {}
    for raw in args.profile_url:
        url = raw.strip()
        platform = platform_for_url(url)
        if platform is None:
            raise CliError(
                f"Unrecognised profile URL: {url!r}. Use an https://www.linkedin.com/... or "
                "https://www.instagram.com/... address."
            )
        if platform in by_platform and by_platform[platform] != url:
            raise CliError(f"Give one {platform} --profile-url, not two.")
        by_platform[platform] = url
    if not by_platform:
        raise CliError("Give at least one --profile-url (your own LinkedIn and/or Instagram page).")

    if args.platform == "all":
        plan = [(pl, by_platform[pl]) for pl in PLATFORMS if pl in by_platform]
        for pl in PLATFORMS:
            if pl not in by_platform:
                _err(f"{pl}: no --profile-url given, skipped")
        return plan
    if args.platform not in by_platform:
        raise CliError(f"--platform {args.platform} needs a {DOMAINS[args.platform]} --profile-url.")
    for pl, url in by_platform.items():
        if pl != args.platform:
            _err(f"{pl}: not selected with --platform {args.platform}, ignoring {url}")
    return [(args.platform, by_platform[args.platform])]


def _load_json_file(path: str, plan: list[tuple[str, str]]) -> dict[str, object]:
    """Saved data per platform: {platform: raw payload}. A file holding one payload serves the single
    selected platform; {"linkedin": {...}, "instagram": {...}} serves each."""
    try:
        with open(path, encoding="utf-8-sig") as fh:
            data = json.load(fh)
    except OSError as exc:
        raise CliError(f"Cannot read {path}: {exc.strerror or exc}") from None
    except ValueError as exc:
        raise CliError(f"{path} is not valid JSON: {exc}") from None
    if not isinstance(data, dict):
        raise CliError(f"{path} must hold a JSON object")
    if any(pl in data for pl in PLATFORMS):
        return {pl: data[pl] for pl in PLATFORMS if pl in data}
    if "account" in data or "posts" in data:
        if len(plan) != 1:
            raise CliError(
                f"{path} holds one payload but {len(plan)} platforms are selected. "
                "Pick one with --platform linkedin or --platform instagram, or use "
                '{"linkedin": {...}, "instagram": {...}}.'
            )
        return {plan[0][0]: data}
    raise CliError(f'{path} needs "account"/"posts" keys (or "linkedin"/"instagram" sections)')


def _summary(platform: str, resp: dict) -> str:
    if any(k in resp for k in ("matched", "created", "snapshots")):
        return (
            f"{platform}: matched {resp.get('matched', 0)}, created {resp.get('created', 0)}, "
            f"snapshots {resp.get('snapshots', 0)}"
        )
    return f"{platform}: done"


def _run(args, harvesters, post, put, connect) -> int:
    api = (args.api or os.environ.get("PULSE_API") or DEFAULT_API).strip().rstrip("/")
    if urlparse(api).scheme not in ("http", "https") or not urlparse(api).netloc:
        raise CliError(f"--api must be an http(s) address like https://your-host, got {api!r}")
    token = (args.token or os.environ.get("PULSE_TOKEN") or "").strip()
    if not token and not args.dry_run:
        raise CliError(
            "A workspace token is needed: pass --token or set PULSE_TOKEN (not needed with --dry-run)."
        )
    if args.max_posts is not None and args.max_posts < 1:
        raise CliError("--max-posts must be 1 or more")

    plan = _plan(args)
    saved = _load_json_file(args.from_json, plan) if args.from_json else None

    put = put or _put
    post = post or _post
    if connect is None:
        # injected harvesters stand in for the whole browser stage
        connect = _chrome_context if harvesters is None else (lambda cdp: contextlib.nullcontext(None))

    login_needed: list[str] = []
    failed = False

    with contextlib.ExitStack() as stack:
        browser: dict[str, object] = {}

        def get_context():
            if "context" not in browser:
                try:
                    browser["context"] = stack.enter_context(connect(args.cdp))
                except ChromeError:
                    raise
                except Exception as exc:  # noqa: BLE001 - anything here means Chrome is not usable
                    raise ChromeError(
                        f"Could not reach Chrome at {args.cdp} ({_first_line(exc)}). "
                        + chrome_start_help(args.cdp)
                    ) from None
                _err(f"connected to Chrome at {args.cdp}")
            return browser["context"]

        for platform, url in plan:
            max_posts = PLATFORM_MAX_POSTS[platform]
            if args.max_posts is not None:
                max_posts = min(args.max_posts, max_posts)

            def log(*parts: object, _pl=platform) -> None:
                _err(f"[{_pl}]", *parts)

            try:
                if saved is None:
                    harvest = _harvester_for(platform, harvesters)
                if not args.dry_run:
                    put(f"{api}/api/connections/{platform}/profile", token, {"profile_url": url})
                if saved is not None:
                    if platform not in saved:
                        raise CliError(f"{args.from_json} has no data for {platform}")
                    raw = saved[platform]
                else:
                    raw = harvest(get_context(), url, max_posts=max_posts, log=log)
                body = {"platform": platform, "source": SOURCE, **sanitize_payload(raw)}
                if args.dry_run:
                    print(json.dumps(body, indent=2))
                    _err(f"{platform}: dry run, nothing was sent to the API")
                else:
                    resp = post(f"{api}/api/metrics/ingest", token, body)
                    print(_summary(platform, resp if isinstance(resp, dict) else {}))
            except common.LoginRequired as exc:
                login_needed.append(platform)
                detail = str(exc).strip()
                _err(
                    f"{platform}: not logged in"
                    + (f" ({detail})" if detail and detail != common.LOGIN_MESSAGE else "")
                )
                _err(common.LOGIN_MESSAGE)
            except (ChromeError, ApiUnreachable) as exc:
                failed = True
                _err(str(exc))
                break  # every remaining platform would fail the same way
            except (common.HarvestError, CliError) as exc:
                failed = True
                _err(f"{platform}: {exc}")
            except Exception as exc:  # noqa: BLE001 - never show a traceback to a founder mid-demo
                failed = True
                _err(f"{platform}: unexpected {type(exc).__name__}: {_first_line(exc)}")

    if login_needed:
        return 2
    return 1 if failed else 0


def main(argv=None, *, harvesters=None, post=None, put=None, connect=None) -> int:
    """Run the CLI and return the exit code.

    Test injection points (default: the real thing):
      harvesters  {"linkedin": fn, "instagram": fn} (or a callable platform -> fn); each is called like the
                  platform modules' harvest(): fn(context, profile_url, max_posts=N, log=print) -> payload.
                  Given without `connect`, no browser is touched at all.
      put, post   put(url, token, body) / post(url, token, body) -> response dict; raise ApiError on failure.
      connect     connect(cdp_url) -> context manager yielding the browser context; raising means Chrome
                  could not be reached.
    """
    try:
        args = build_parser().parse_args(argv)
    except SystemExit as exc:  # --help (0) or a usage error (1)
        return exc.code if isinstance(exc.code, int) else 1
    try:
        return _run(args, harvesters, post, put, connect)
    except CliError as exc:
        _err(str(exc))
        return 1
    except KeyboardInterrupt:
        _err("interrupted")
        return 1


if __name__ == "__main__":
    for _stream in (sys.stdout, sys.stderr):  # a Windows console must not crash on an emoji in a post
        with contextlib.suppress(Exception):
            _stream.reconfigure(errors="replace")
    sys.exit(main())

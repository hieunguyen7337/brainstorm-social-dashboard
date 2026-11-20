"""Tests for the harvest CLI. No network, no browser, no playwright: harvesters, put, post and connect are
injected (or urllib is faked)."""

import contextlib
import io
import json
import os
import subprocess
import sys
import types
import urllib.error

import pytest

sys.path.insert(0, os.path.dirname(__file__))
import harvest as cli

HERE = os.path.dirname(os.path.abspath(__file__))
LI = "https://www.linkedin.com/in/jane/"
IG = "https://www.instagram.com/jane/"
API = "https://pulse.example.com"
TOKEN = "tok-SECRET-123"
LOGIN_MESSAGE = "log in in that Chrome window, then rerun"


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.delenv("PULSE_API", raising=False)
    monkeypatch.delenv("PULSE_TOKEN", raising=False)


def payload(platform="linkedin"):
    return {
        "account": {"followers": 120, "views": 900},
        "posts": [{"external_id": f"{platform}-1", "views": 50, "engagements": 7}],
    }


class Rig:
    """Records every injected call, in order."""

    def __init__(self, **per_platform):
        self.events = []  # ("PUT"|"POST"|"HARVEST", ...)
        self.per_platform = per_platform  # platform -> payload dict or exception instance
        self.context = object()

    def harvesters(self):
        def make(platform):
            def fn(context, url, *, max_posts, log=print):
                self.events.append(("HARVEST", platform, url, max_posts, context))
                log("reading")
                result = self.per_platform.get(platform, payload(platform))
                if isinstance(result, Exception):
                    raise result
                return result

            return fn

        return {pl: make(pl) for pl in cli.PLATFORMS}

    def put(self, url, token, body):
        self.events.append(("PUT", url, token, body))
        return {}

    def post(self, url, token, body):
        self.events.append(("POST", url, token, body))
        return {"platform": body["platform"], "matched": 7, "created": 3, "snapshots": 11}

    def run(self, argv, **kw):
        return cli.main(argv, harvesters=self.harvesters(), put=self.put, post=self.post, **kw)

    def of(self, kind):
        return [e for e in self.events if e[0] == kind]


def base(*extra):
    return ["--api", API, "--token", TOKEN, *extra]


# ------------------------------------------------------------------------------------- arguments


def test_help_exits_zero_and_hides_env_values(monkeypatch, capsys):
    monkeypatch.setenv("PULSE_TOKEN", "tok-from-env-999")
    monkeypatch.setenv("PULSE_API", "https://from-env.example.com")
    assert cli.main(["--help"]) == 0
    out = capsys.readouterr().out
    assert "--profile-url" in out and "--dry-run" in out and "--from-json" in out
    assert "tok-from-env-999" not in out and "from-env.example.com" not in out


def test_platform_detection_requires_the_real_host():
    assert cli.platform_for_url("https://www.linkedin.com/in/x/") == "linkedin"
    assert cli.platform_for_url("https://linkedin.com/in/x") == "linkedin"
    assert cli.platform_for_url("https://uk.linkedin.com/in/x") == "linkedin"
    assert cli.platform_for_url("http://instagram.com/x") == "instagram"
    assert cli.platform_for_url("https://WWW.Instagram.com/x/") == "instagram"
    for bad in (
        "https://evil-linkedin.com/in/x",
        "https://linkedin.com.evil.com/in/x",
        "https://evil.com/linkedin.com/in/x",
        "https://linkedin.com@evil.com/in/x",
        "https://notinstagram.com/x",
        "www.linkedin.com/in/x",
        "ftp://www.linkedin.com/in/x",
        "",
    ):
        assert cli.platform_for_url(bad) is None, bad


def test_repeated_profile_urls_run_each_platform_in_order(capsys):
    rig = Rig()
    assert rig.run(base("--profile-url", IG, "--profile-url", LI)) == 0
    assert [(e[1], e[2]) for e in rig.of("HARVEST")] == [("linkedin", LI), ("instagram", IG)]
    assert [e[1] for e in rig.of("PUT")] == [
        f"{API}/api/connections/linkedin/profile",
        f"{API}/api/connections/instagram/profile",
    ]
    out = capsys.readouterr().out
    assert "linkedin: matched 7, created 3, snapshots 11" in out
    assert "instagram: matched 7, created 3, snapshots 11" in out


def test_evil_host_is_rejected_before_anything_runs(capsys):
    rig = Rig()
    assert rig.run(base("--profile-url", LI, "--profile-url", "https://evil-linkedin.com/in/x")) == 1
    assert "Unrecognised profile URL" in capsys.readouterr().err
    assert rig.events == []


def test_platform_linkedin_ignores_the_instagram_url(capsys):
    rig = Rig()
    assert rig.run(base("--platform", "linkedin", "--profile-url", LI, "--profile-url", IG)) == 0
    assert [e[1] for e in rig.of("HARVEST")] == ["linkedin"]
    assert [e[3]["platform"] for e in rig.of("POST")] == ["linkedin"]
    assert "ignoring" in capsys.readouterr().err


def test_platform_without_a_matching_url_is_an_error(capsys):
    rig = Rig()
    assert rig.run(base("--platform", "instagram", "--profile-url", LI)) == 1
    assert "instagram.com" in capsys.readouterr().err
    assert rig.events == []


def test_all_skips_a_platform_with_no_url_and_needs_at_least_one(capsys):
    rig = Rig()
    assert rig.run(base("--profile-url", IG)) == 0
    err = capsys.readouterr().err
    assert "linkedin: no --profile-url given, skipped" in err
    assert [e[1] for e in rig.of("HARVEST")] == ["instagram"]
    assert Rig().run(base()) == 1  # no URL at all
    assert "--profile-url" in capsys.readouterr().err


def test_two_urls_for_one_platform_is_an_error(capsys):
    rig = Rig()
    other = "https://www.linkedin.com/in/someone-else/"
    assert rig.run(base("--profile-url", LI, "--profile-url", other)) == 1
    assert rig.events == []


def test_max_posts_defaults_and_caps():
    rig = Rig()
    assert rig.run(base("--profile-url", LI, "--profile-url", IG)) == 0
    assert {e[1]: e[3] for e in rig.of("HARVEST")} == {"linkedin": 30, "instagram": 12}

    rig = Rig()
    assert rig.run(base("--profile-url", LI, "--profile-url", IG, "--max-posts", "100")) == 0
    assert {e[1]: e[3] for e in rig.of("HARVEST")} == {"linkedin": 30, "instagram": 12}

    rig = Rig()
    assert rig.run(base("--profile-url", LI, "--profile-url", IG, "--max-posts", "5")) == 0
    assert {e[1]: e[3] for e in rig.of("HARVEST")} == {"linkedin": 5, "instagram": 5}


def test_bad_max_posts_and_bad_platform_exit_1(capsys):
    assert Rig().run(base("--profile-url", LI, "--max-posts", "0")) == 1
    assert Rig().run(base("--profile-url", LI, "--max-posts", "many")) == 1
    assert Rig().run(base("--profile-url", LI, "--platform", "twitter")) == 1
    assert Rig().run(base("--profile-url", LI, "--bogus")) == 1


def test_env_defaults_for_api_and_token(monkeypatch):
    monkeypatch.setenv("PULSE_API", "https://env.example.com/")
    monkeypatch.setenv("PULSE_TOKEN", "tok-env")
    rig = Rig()
    assert rig.run(["--profile-url", LI]) == 0
    (put,) = rig.of("PUT")
    (post,) = rig.of("POST")
    assert put[1] == "https://env.example.com/api/connections/linkedin/profile"
    assert post[1] == "https://env.example.com/api/metrics/ingest"
    assert put[2] == post[2] == "tok-env"


def test_flags_beat_env_and_default_api_is_localhost(monkeypatch):
    monkeypatch.setenv("PULSE_API", "https://env.example.com")
    monkeypatch.setenv("PULSE_TOKEN", "tok-env")
    rig = Rig()
    assert rig.run(["--api", "http://flag.example.com", "--token", "tok-flag", "--profile-url", LI]) == 0
    assert rig.of("POST")[0][1] == "http://flag.example.com/api/metrics/ingest"
    assert rig.of("POST")[0][2] == "tok-flag"
    monkeypatch.delenv("PULSE_API")
    rig = Rig()
    assert rig.run(["--profile-url", LI]) == 0
    assert rig.of("POST")[0][1] == "http://localhost:8000/api/metrics/ingest"


def test_missing_token_is_an_error_unless_dry_run(capsys):
    rig = Rig()
    assert rig.run(["--api", API, "--profile-url", LI]) == 1
    assert "PULSE_TOKEN" in capsys.readouterr().err
    assert rig.events == []
    assert rig.run(["--api", API, "--profile-url", LI, "--dry-run"]) == 0


# --------------------------------------------------------------------------------- normal and dry runs


def test_dry_run_prints_the_body_and_calls_neither_put_nor_post(capsys):
    rig = Rig()
    assert rig.run(base("--platform", "linkedin", "--profile-url", LI, "--dry-run")) == 0
    out, err = capsys.readouterr()
    assert json.loads(out) == {
        "platform": "linkedin",
        "source": "script",
        "account": {"followers": 120, "views": 900},
        "posts": [{"external_id": "linkedin-1", "views": 50, "engagements": 7}],
    }
    assert "\n  " in out  # pretty printed
    assert rig.of("PUT") == [] and rig.of("POST") == []
    assert len(rig.of("HARVEST")) == 1
    assert TOKEN not in out and TOKEN not in err


def test_dry_run_with_two_platforms_prints_two_bodies(capsys):
    rig = Rig()
    assert rig.run(base("--profile-url", LI, "--profile-url", IG, "--dry-run")) == 0
    text = capsys.readouterr().out
    decoder, pos, bodies = json.JSONDecoder(), 0, []
    while pos < len(text):
        if text[pos].isspace():
            pos += 1
            continue
        body, pos = decoder.raw_decode(text, pos)
        bodies.append(body)
    assert [b["platform"] for b in bodies] == ["linkedin", "instagram"]


def test_normal_run_puts_the_profile_then_posts_the_body_and_never_prints_the_token(capsys):
    rig = Rig()
    assert rig.run(base("--platform", "linkedin", "--profile-url", LI)) == 0
    assert [e[0] for e in rig.events] == ["PUT", "HARVEST", "POST"]
    _, put_url, put_token, put_body = rig.of("PUT")[0]
    _, post_url, post_token, post_body = rig.of("POST")[0]
    assert put_url == f"{API}/api/connections/linkedin/profile"
    assert put_body == {"profile_url": LI}
    assert post_url == f"{API}/api/metrics/ingest"
    assert put_token == post_token == TOKEN
    assert post_body == {
        "platform": "linkedin",
        "source": "script",
        "account": {"followers": 120, "views": 900},
        "posts": [{"external_id": "linkedin-1", "views": 50, "engagements": 7}],
    }
    out, err = capsys.readouterr()
    assert out.strip() == "linkedin: matched 7, created 3, snapshots 11"
    assert TOKEN not in out and TOKEN not in err
    assert "[linkedin] reading" in err  # harvester logging goes to stderr


def test_harvester_gets_the_browser_context_from_connect_and_it_is_used_once():
    rig = Rig()
    opened = []

    @contextlib.contextmanager
    def connect(cdp):
        opened.append(cdp)
        yield rig.context

    assert (
        rig.run(
            base("--profile-url", LI, "--profile-url", IG, "--cdp", "http://127.0.0.1:9333"), connect=connect
        )
        == 0
    )
    assert opened == ["http://127.0.0.1:9333"]  # one connection for both platforms
    assert all(e[4] is rig.context for e in rig.of("HARVEST"))


# --------------------------------------------------------------------------------------- failures


def test_login_required_exits_2_with_the_message_and_still_processes_the_other_platform(capsys):
    rig = Rig(linkedin=cli.common.LoginRequired("redirected to the login page"))
    assert rig.run(base("--profile-url", LI, "--profile-url", IG)) == 2
    out, err = capsys.readouterr()
    assert LOGIN_MESSAGE in err.splitlines()
    assert "linkedin: not logged in" in err
    assert "instagram: matched 7, created 3, snapshots 11" in out
    assert [e[3]["platform"] for e in rig.of("POST")] == ["instagram"]
    assert TOKEN not in out and TOKEN not in err


def test_login_required_wins_over_another_failure(capsys):
    rig = Rig(linkedin=cli.common.HarvestError("page layout changed"), instagram=cli.common.LoginRequired(""))
    assert rig.run(base("--profile-url", LI, "--profile-url", IG)) == 2
    err = capsys.readouterr().err
    assert "linkedin: page layout changed" in err
    assert "instagram: not logged in" in err


def test_other_harvest_error_exits_1_and_the_other_platform_still_runs(capsys):
    rig = Rig(instagram=cli.common.HarvestError("could not find the follower count"))
    assert rig.run(base("--profile-url", LI, "--profile-url", IG)) == 1
    out, err = capsys.readouterr()
    assert "instagram: could not find the follower count" in err
    assert LOGIN_MESSAGE not in err
    assert "linkedin: matched 7" in out


def test_unexpected_exception_in_a_harvester_is_a_one_line_failure(capsys):
    rig = Rig(linkedin=RuntimeError("boom"))
    assert rig.run(base("--profile-url", LI)) == 1
    err = capsys.readouterr().err
    assert "linkedin: unexpected RuntimeError: boom" in err
    assert "Traceback" not in err


def test_api_error_is_shown_as_status_and_detail(capsys):
    rig = Rig()

    def post(url, token, body):
        raise cli.ApiError(422, "profile_url host must be linkedin.com")

    assert cli.main(base("--profile-url", LI), harvesters=rig.harvesters(), put=rig.put, post=post) == 1
    err = capsys.readouterr().err
    assert "422: profile_url host must be linkedin.com" in err
    assert TOKEN not in err


def test_put_failure_skips_the_harvest_for_that_platform(capsys):
    rig = Rig()

    def put(url, token, body):
        raise cli.ApiError(401, "Invalid token")

    assert cli.main(base("--profile-url", LI), harvesters=rig.harvesters(), put=put, post=rig.post) == 1
    assert "401: Invalid token" in capsys.readouterr().err
    assert rig.events == []


def test_api_unreachable_stops_the_run_with_exit_1(capsys):
    rig = Rig()

    def put(url, token, body):
        raise cli.ApiUnreachable("Could not reach the Pulse API at https://pulse.example.com: refused")

    assert cli.main(base("--profile-url", LI, "--profile-url", IG), harvesters=rig.harvesters(), put=put) == 1
    err = capsys.readouterr().err
    assert err.count("Could not reach the Pulse API") == 1


def test_cannot_reach_chrome_message_lists_the_start_commands(capsys):
    rig = Rig()

    def connect(cdp):
        raise ConnectionRefusedError("connect ECONNREFUSED 127.0.0.1:9222")

    assert rig.run(base("--profile-url", LI, "--profile-url", IG), connect=connect) == 1
    err = capsys.readouterr().err
    assert "Could not reach Chrome at http://127.0.0.1:9222" in err
    assert "Start it first" in err
    assert r'"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222' in err
    assert r'--user-data-dir="C:\pulse-chrome"' in err
    assert (
        r"/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222" in err
    )
    assert '--user-data-dir="$HOME/pulse-chrome"' in err
    assert err.count("Could not reach Chrome") == 1  # not repeated for the second platform
    assert rig.of("HARVEST") == []


def test_missing_platform_module_gives_a_clear_message(monkeypatch, capsys):
    def fail(name, package=None):
        raise ImportError("No module named 'linkedin'")

    monkeypatch.setattr(cli.importlib, "import_module", fail)
    assert cli.main(base("--profile-url", LI), put=Rig().put, post=Rig().post) == 1
    err = capsys.readouterr().err
    assert "cannot load the linkedin reader" in err


# ------------------------------------------------------------------------------------ --from-json


def write_json(tmp_path, data, name="saved.json"):
    path = tmp_path / name
    path.write_text(data if isinstance(data, str) else json.dumps(data), encoding="utf-8")
    return str(path)


def never(*_a, **_k):
    raise AssertionError("no browser or harvester expected")


def test_from_json_single_payload_opens_no_browser(tmp_path, capsys):
    rig = Rig()
    path = write_json(tmp_path, payload("linkedin"))
    code = cli.main(
        base("--platform", "linkedin", "--profile-url", LI, "--from-json", path),
        harvesters={"linkedin": never, "instagram": never},
        connect=never,
        put=rig.put,
        post=rig.post,
    )
    assert code == 0
    assert [e[0] for e in rig.events] == ["PUT", "POST"]
    body = rig.of("POST")[0][3]
    assert body["platform"] == "linkedin" and body["source"] == "script"
    assert body["posts"][0]["external_id"] == "linkedin-1"
    assert "linkedin: matched 7" in capsys.readouterr().out


def test_from_json_single_payload_with_two_platforms_selected_is_an_error(tmp_path, capsys):
    rig = Rig()
    path = write_json(tmp_path, payload())
    assert rig.run(base("--profile-url", LI, "--profile-url", IG, "--from-json", path)) == 1
    assert "one payload" in capsys.readouterr().err
    assert rig.events == []


def test_from_json_two_platform_form(tmp_path, capsys):
    rig = Rig()
    path = write_json(tmp_path, {"linkedin": payload("linkedin"), "instagram": payload("instagram")})
    code = cli.main(
        base("--profile-url", LI, "--profile-url", IG, "--from-json", path),
        harvesters={"linkedin": never, "instagram": never},
        put=rig.put,
        post=rig.post,
    )
    assert code == 0
    assert [e[3]["platform"] for e in rig.of("POST")] == ["linkedin", "instagram"]
    assert rig.of("POST")[1][3]["posts"][0]["external_id"] == "instagram-1"


def test_from_json_missing_platform_section_fails_that_platform_only(tmp_path, capsys):
    rig = Rig()
    path = write_json(tmp_path, {"linkedin": payload("linkedin")})
    assert rig.run(base("--profile-url", LI, "--profile-url", IG, "--from-json", path)) == 1
    assert "no data for instagram" in capsys.readouterr().err
    assert [e[3]["platform"] for e in rig.of("POST")] == ["linkedin"]


def test_from_json_dry_run_prints_the_body_and_sends_nothing(tmp_path, capsys):
    rig = Rig()
    path = write_json(tmp_path, payload())
    assert rig.run(["--profile-url", LI, "--from-json", path, "--dry-run"]) == 0
    assert json.loads(capsys.readouterr().out)["platform"] == "linkedin"
    assert rig.events == []


def test_from_json_invalid_or_missing_file_exits_1_before_any_call(tmp_path, capsys):
    rig = Rig()
    bad = write_json(tmp_path, "{not json")
    assert rig.run(base("--profile-url", LI, "--from-json", bad)) == 1
    assert "not valid JSON" in capsys.readouterr().err
    assert rig.run(base("--profile-url", LI, "--from-json", str(tmp_path / "nope.json"))) == 1
    assert "Cannot read" in capsys.readouterr().err
    assert rig.run(base("--profile-url", LI, "--from-json", write_json(tmp_path, [1, 2], "list.json"))) == 1
    assert (
        rig.run(base("--profile-url", LI, "--from-json", write_json(tmp_path, {"hello": 1}, "h.json"))) == 1
    )
    assert rig.events == []


# ------------------------------------------------------------------------------------ sanitising


def test_sanitize_drops_unknown_keys_and_empty_values():
    clean = cli.sanitize_payload(
        {
            "account": {"followers": 10, "profile_views": 3.0, "bogus": 1, "clicks": None},
            "posts": [
                {
                    "external_id": "1",
                    "url": "",
                    "content": "hi",
                    "views": 5,
                    "engagements": 2,
                    "conversions": 0,
                    "secret": "x",
                }
            ],
            "extra": True,
        }
    )
    assert clean == {
        "account": {"followers": 10, "profile_views": 3},
        "posts": [{"external_id": "1", "content": "hi", "views": 5, "engagements": 2, "conversions": 0}],
    }


@pytest.mark.parametrize(
    "bad",
    [
        {"account": {"followers": -1}},
        {"account": {"followers": "12"}},
        {"account": {"followers": True}},
        {"account": {"followers": 1.5}},
        {"account": {"followers": float("nan")}},
        {"account": []},
        {"posts": [{"views": -5, "engagements": 1}]},
        {"posts": [{"views": 1, "engagements": "lots"}]},
        {"posts": [{"views": 1, "engagements": 1, "content": 5}]},
        {"posts": ["not an object"]},
        {"posts": {"views": 1}},
        [],
        "x",
    ],
)
def test_sanitize_rejects_invalid_numbers_and_shapes(bad):
    with pytest.raises(cli.PayloadError):
        cli.sanitize_payload(bad)


def test_sanitize_allows_500_posts_but_not_501():
    post = {"views": 1, "engagements": 1}
    assert len(cli.sanitize_payload({"posts": [post] * 500})["posts"]) == 500
    with pytest.raises(cli.PayloadError, match="too many posts"):
        cli.sanitize_payload({"posts": [post] * 501})


def test_invalid_harvested_data_is_never_sent(capsys):
    rig = Rig(linkedin={"account": {"followers": -4}, "posts": []})
    assert rig.run(base("--profile-url", LI)) == 1
    assert "account.followers" in capsys.readouterr().err
    assert rig.of("POST") == []


# ------------------------------------------------------------------- real HTTP layer (urlopen faked)


class FakeResponse:
    def __init__(self, data, status=200):
        self._raw = data if isinstance(data, bytes) else json.dumps(data).encode()
        self.status = status

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def http_error(code, body, headers=None):
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    return urllib.error.HTTPError("http://x", code, "err", headers or {}, io.BytesIO(raw))


def test_request_sends_bearer_json_with_a_30_second_timeout(monkeypatch):
    seen = {}

    def fake_urlopen(req, timeout):
        seen.update(req=req, timeout=timeout)
        return FakeResponse({"matched": 1})

    monkeypatch.setattr(cli, "_urlopen", fake_urlopen)
    resp = cli._post(f"{API}/api/metrics/ingest", TOKEN, {"platform": "linkedin"})
    req = seen["req"]
    assert resp == {"matched": 1}
    assert seen["timeout"] == 30
    assert req.get_method() == "POST"
    assert req.full_url == f"{API}/api/metrics/ingest"
    assert req.get_header("Authorization") == f"Bearer {TOKEN}"
    assert req.get_header("Content-type") == "application/json"
    assert json.loads(req.data) == {"platform": "linkedin"}
    cli._put(f"{API}/api/connections/linkedin/profile", TOKEN, {"profile_url": LI})
    assert seen["req"].get_method() == "PUT"


def test_real_http_errors_show_as_status_and_detail(monkeypatch, capsys):
    cases = [
        (401, {"detail": "Invalid token"}, "401: Invalid token"),
        (
            422,
            {"detail": [{"loc": ["body", "posts", 0, "views"], "msg": "Input should be >= 0"}]},
            "422: posts.0.views: Input should be >= 0",
        ),
        (500, b"<html>oops</html>", "500: <html>oops</html>"),
    ]
    for code, body, expected in cases:

        def fake_urlopen(req, timeout, code=code, body=body):
            raise http_error(code, body)

        monkeypatch.setattr(cli, "_urlopen", fake_urlopen)
        assert cli.main(base("--profile-url", LI), harvesters=Rig().harvesters()) == 1
        err = capsys.readouterr().err
        assert expected in err
        assert TOKEN not in err


def test_redirects_are_not_followed_and_say_where_to_go(monkeypatch, capsys):
    assert cli._NoRedirect().redirect_request(None, None, 301, "moved", {}, "https://elsewhere") is None

    def fake_urlopen(req, timeout):
        raise http_error(301, b"", {"Location": "https://pulse.example.com/api/metrics/ingest"})

    monkeypatch.setattr(cli, "_urlopen", fake_urlopen)
    assert cli.main(base("--profile-url", LI), harvesters=Rig().harvesters()) == 1
    assert "redirected to https://pulse.example.com/api/metrics/ingest" in capsys.readouterr().err


def test_unreachable_api_exits_1_with_a_message(monkeypatch, capsys):
    def fake_urlopen(req, timeout):
        raise urllib.error.URLError(ConnectionRefusedError(111, "Connection refused"))

    monkeypatch.setattr(cli, "_urlopen", fake_urlopen)
    assert cli.main(base("--profile-url", LI), harvesters=Rig().harvesters()) == 1
    err = capsys.readouterr().err
    assert "Could not reach the Pulse API at https://pulse.example.com" in err
    assert TOKEN not in err


def test_non_json_success_response_is_an_error(monkeypatch, capsys):
    monkeypatch.setattr(cli, "_urlopen", lambda req, timeout: FakeResponse(b"<html>hello</html>"))
    assert cli.main(base("--profile-url", LI), harvesters=Rig().harvesters()) == 1
    assert "did not answer with JSON" in capsys.readouterr().err


# ---------------------------------------------------------------- the real Chrome connector (faked)


def fake_playwright(monkeypatch, contexts):
    """Install a fake `playwright.sync_api` and return the list of calls made on it."""
    calls = []

    class Browser:
        def __init__(self):
            self.contexts = contexts

        def close(self):
            raise AssertionError("the user's browser must never be closed")

    class Chromium:
        def connect_over_cdp(self, url, **kw):
            calls.append(("connect_over_cdp", url))
            return Browser()

    class Playwright:
        chromium = Chromium()

    @contextlib.contextmanager
    def sync_playwright():
        calls.append("start")
        yield Playwright()
        calls.append("stop")

    sync_api = types.ModuleType("playwright.sync_api")
    sync_api.sync_playwright = sync_playwright
    package = types.ModuleType("playwright")
    package.sync_api = sync_api
    monkeypatch.setitem(sys.modules, "playwright", package)
    monkeypatch.setitem(sys.modules, "playwright.sync_api", sync_api)
    return calls


def test_chrome_context_uses_the_default_context_and_only_disconnects(monkeypatch):
    default_context = object()
    calls = fake_playwright(monkeypatch, [default_context, object()])
    with cli._chrome_context("http://127.0.0.1:9222") as ctx:
        assert ctx is default_context
    assert calls == ["start", ("connect_over_cdp", "http://127.0.0.1:9222"), "stop"]  # close() never called


def test_chrome_context_without_a_default_context_explains_how_to_start_chrome(monkeypatch):
    fake_playwright(monkeypatch, [])
    with (
        pytest.raises(cli.ChromeError, match="--remote-debugging-port=9222"),
        cli._chrome_context("http://127.0.0.1:9222"),
    ):
        pass


def test_missing_playwright_is_a_clear_error(monkeypatch, capsys):
    monkeypatch.setitem(sys.modules, "playwright", None)
    monkeypatch.setitem(sys.modules, "playwright.sync_api", None)
    with (
        pytest.raises(cli.ChromeError, match="pip install -r tools/harvest/requirements.txt"),
        cli._chrome_context("http://127.0.0.1:9222"),
    ):
        pass


def test_real_connector_is_used_when_nothing_is_injected(monkeypatch, capsys):
    context = object()
    fake_playwright(monkeypatch, [context])
    seen = {}

    class FakeModule:
        @staticmethod
        def harvest(ctx, url, *, max_posts, log):
            seen.update(ctx=ctx, url=url, max_posts=max_posts)
            return payload()

    monkeypatch.setattr(cli, "_load_platform", lambda platform: FakeModule)
    rig = Rig()
    assert cli.main(base("--profile-url", LI), put=rig.put, post=rig.post) == 0
    assert seen == {"ctx": context, "url": LI, "max_posts": 30}


# --------------------------------------------------------------------------------- script start-up


def test_script_runs_help_without_playwright_and_does_not_import_it():
    result = subprocess.run(
        [sys.executable, os.path.join(HERE, "harvest.py"), "--help"],
        capture_output=True,
        check=False,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0
    assert "--profile-url" in result.stdout

    probe = f"import sys; sys.path.insert(0, {HERE!r}); import harvest; sys.exit('playwright' in sys.modules)"
    assert subprocess.run([sys.executable, "-c", probe], check=False, timeout=60).returncode == 0


def test_script_dry_run_from_json_needs_no_browser_or_token(tmp_path):
    path = write_json(tmp_path, payload())
    env = {k: v for k, v in os.environ.items() if k not in ("PULSE_API", "PULSE_TOKEN")}
    result = subprocess.run(
        [
            sys.executable,
            os.path.join(HERE, "harvest.py"),
            "--profile-url",
            LI,
            "--from-json",
            path,
            "--dry-run",
        ],
        capture_output=True,
        check=False,
        text=True,
        timeout=60,
        env=env,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["posts"][0]["external_id"] == "linkedin-1"

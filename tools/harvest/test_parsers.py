"""Cross-module checks: shared helpers, and fixtures -> parser payloads -> the CLI sanitiser -> the real API.

The per-platform parser tests live in test_linkedin_parsers.py and test_instagram_parsers.py; this file
proves the pieces fit together: whatever the parsers emit is accepted by `harvest.sanitize_payload` and by
the real `POST /api/metrics/ingest` (run in-process, no network, no browser).
"""

import json
import os
import sys
from datetime import UTC, datetime

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
API_DIR = os.path.abspath(os.path.join(HERE, "..", "..", "apps", "api"))
sys.path.insert(0, HERE)

import common
import harvest as cli
import instagram
import linkedin

NOW = datetime(2026, 11, 20, 3, 0, tzinfo=UTC)


def fx(name: str) -> str:
    with open(os.path.join(HERE, "fixtures", name), encoding="utf-8") as f:
        return f.read()


def linkedin_payload() -> dict:
    return linkedin.build_payload(
        linkedin.parse_recent_activity(fx("linkedin_recent_activity.html"), now=NOW),
        linkedin.parse_creator_content(fx("linkedin_creator_content.html")),
        linkedin.parse_followers(fx("linkedin_profile.html")),
    )


def instagram_payload() -> dict:
    post_page = instagram.parse_post_page(
        fx("instagram_post_page.html"), url="https://www.instagram.com/p/C9xYzAbCdEf/"
    )
    return instagram.build_payload(
        instagram.parse_profile(fx("instagram_profile.html")),
        [post_page] if post_page else [],
        instagram.parse_insights(fx("instagram_insights.html")),
    )


# ------------------------------------------------------------------------------------- common.py


@pytest.mark.parametrize(
    "text, expected",
    [
        ("1,234", 1234),
        ("1.2K", 1200),
        ("2.5k followers", 2500),
        ("3.4M views", 3_400_000),
        ("12 comments", 12),
        ("1 234", 1234),
        ("12,345 followers", 12345),
        ("0", 0),
        (7, 7),
        ("no digits here", None),
        ("", None),
        (None, None),
    ],
)
def test_parse_count(text, expected):
    assert common.parse_count(text) == expected


def test_html_to_text_drops_scripts_and_keeps_block_lines():
    html = "<div><span>1,204</span><span>impressions</span></div><script>x = 1</script><p>Hi <b>there</b></p>"
    assert common.html_to_text(html) == "1,204 impressions\nHi there"


def test_human_pause_uses_injected_sleep_and_stays_in_range():
    waited: list[float] = []
    d = common.human_pause(sleep=waited.append)
    assert waited == [d] and 1.0 <= d <= 2.0


def test_login_required_is_a_harvest_error():
    assert issubclass(common.LoginRequired, common.HarvestError)
    assert common.LOGIN_MESSAGE == "log in in that Chrome window, then rerun"


# --------------------------------------------------------------------- fixtures -> payload shape


@pytest.mark.parametrize("make", [linkedin_payload, instagram_payload])
def test_payloads_are_json_with_integer_counts(make):
    payload = make()
    json.dumps(payload)  # round trips
    assert payload["posts"], "fixture should yield posts"
    assert all(isinstance(v, int) and v >= 0 for v in payload["account"].values())
    for post in payload["posts"]:
        assert type(post["views"]) is int and type(post["engagements"]) is int
        assert post.get("external_id") or post.get("url")


@pytest.mark.parametrize("make", [linkedin_payload, instagram_payload])
def test_payloads_survive_the_cli_sanitiser_unchanged_in_substance(make):
    payload = make()
    clean = cli.sanitize_payload(payload)
    assert len(clean["posts"]) == len(payload["posts"])
    assert clean["account"] == payload["account"]
    for before, after in zip(payload["posts"], clean["posts"], strict=True):
        assert after["views"] == before["views"] and after["engagements"] == before["engagements"]


def test_limits_match_the_brief():
    assert len(linkedin_payload()["posts"]) <= 30
    assert len(instagram_payload()["posts"]) <= 12
    assert instagram.MAX_POSTS == 12


# --------------------------------------------------------------- fixtures -> the real ingest API


@pytest.fixture()
def api(tmp_path, monkeypatch):
    pytest.importorskip("fastapi")
    pytest.importorskip("pydantic_settings")
    monkeypatch.setenv("PULSE_DISABLE_LOOPS", "1")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    monkeypatch.syspath_prepend(API_DIR)
    from app.config import settings
    from fastapi.testclient import TestClient

    monkeypatch.setattr(settings, "database_path", str(tmp_path / "pulse.db"))
    settings.anthropic_api_key = ""
    from app.main import create_app

    with TestClient(create_app()) as client:
        ws = client.post("/api/workspaces", json={}).json()
        yield client, {"Authorization": f"Bearer {ws['token']}"}


@pytest.mark.parametrize(
    "platform, make, profile_url",
    [
        ("linkedin", linkedin_payload, "https://www.linkedin.com/in/jane-founder/"),
        ("instagram", instagram_payload, "https://www.instagram.com/brewandbloom/"),
    ],
)
def test_real_parser_output_is_ingested_then_matched_on_rerun(api, platform, make, profile_url):
    client, headers = api
    payload = make()
    n = len(payload["posts"])

    r = client.put(f"/api/connections/{platform}/profile", json={"profile_url": profile_url}, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["profile_url"] == profile_url

    body = {"platform": platform, "source": "script", **payload}
    r = client.post("/api/metrics/ingest", json=body, headers=headers)
    assert r.status_code == 200, r.text
    first = r.json()
    assert first["matched"] + first["created"] == n
    assert first["snapshots"] == n + 1  # every post plus the account block

    # Same harvest again: everything is recognised by external_id, nothing new is created.
    r = client.post("/api/metrics/ingest", json=body, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["matched"] == n and r.json()["created"] == 0

    status = {s["platform"]: s for s in client.get("/api/connections/harvest-status", headers=headers).json()}
    assert status[platform]["profile_url"] == profile_url
    assert status[platform]["last_source"] == "script"
    assert status[platform]["real_posts"] >= n - first["matched"]
    assert status[platform]["followers"] == payload["account"]["followers"]

    snaps = client.get(f"/api/metrics/snapshots?platform={platform}&limit=500", headers=headers).json()
    assert len(snaps) == 2 * (n + 1)

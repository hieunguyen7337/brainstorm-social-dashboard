"""Public "Install Pulse" QR: /download/android/qr.svg and the big-screen /get page."""

from app import qr
from app.config import settings


def test_qr_svg_is_public_svg_of_the_absolute_download_url(client, monkeypatch):
    monkeypatch.setattr(settings, "public_base_url", "https://pulse-hackathon.fly.dev/")
    r = client.get("/download/android/qr.svg")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("image/svg+xml")
    assert "max-age=3600" in r.headers["cache-control"]
    url = "https://pulse-hackathon.fly.dev/download/android"
    assert qr.android_download_url() == url
    assert r.text == qr.standalone_qr_svg(url)
    assert r.text.lstrip().startswith("<svg") and "xmlns" in r.text


def test_get_page_is_public_with_the_qr_and_no_token(client, monkeypatch):
    monkeypatch.setattr(settings, "public_base_url", "https://pulse-hackathon.fly.dev")
    r = client.get("/get")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/html")
    assert qr.qr_svg("https://pulse-hackathon.fly.dev/download/android") in r.text
    assert "Scan to install Pulse on Android" in r.text
    assert "token" not in r.text.lower()

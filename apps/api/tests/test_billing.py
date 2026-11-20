"""Billing: demo flow, Stripe test-mode checkout (SDK mocked), webhook signatures, live-key refusal."""

import hashlib
import hmac
import json
import re
import time

import pytest
import stripe

from app.config import settings
from app.db import connect
from app.services import billing as svc

WEBHOOK_SECRET = "whsec_test_fixture"


@pytest.fixture()
def cfg(monkeypatch):
    """Clean billing config: demo mode by default, public URL fixed."""
    monkeypatch.setattr(settings, "stripe_secret_key", "")
    monkeypatch.setattr(settings, "stripe_webhook_secret", "")
    monkeypatch.setattr(settings, "stripe_price_id", "")
    monkeypatch.setattr(settings, "public_base_url", "https://pulse.test")
    return settings


def _signed(payload: dict, secret: str = WEBHOOK_SECRET) -> tuple[bytes, str]:
    body = json.dumps(payload).encode()
    ts = int(time.time())
    sig = hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    return body, f"t={ts},v1={sig}"


def _event(etype: str, obj: dict) -> dict:
    return {"id": "evt_test", "object": "event", "type": etype, "data": {"object": obj}}


def _plan(auth_ws_id: str) -> str:
    conn = connect(settings.database_path)
    try:
        return conn.execute("SELECT plan FROM workspaces WHERE id = ?", (auth_ws_id,)).fetchone()["plan"]
    finally:
        conn.close()


def test_get_billing_demo_mode_and_features(auth, cfg):
    client, headers, _ws = auth
    r = client.get("/api/billing", headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["plan"] == "free"
    assert body["mode"] == "demo"
    assert body["price_label"] == "A$29/mo"
    assert set(body["features"]) == {"free", "pro"}
    assert body["features"]["pro"]


def test_billing_requires_workspace_token(client, cfg):
    assert client.get("/api/billing").status_code == 401


def test_demo_checkout_url_is_signed_and_upgrades(auth, cfg):
    client, headers, ws = auth
    r = client.post("/api/billing/checkout", json={}, headers=headers)
    assert r.status_code == 200, r.text
    url = r.json()["url"]
    assert url.startswith(f"https://pulse.test/api/billing/demo-checkout?ws={ws['id']}&sig=")
    path = url.removeprefix("https://pulse.test")

    page = client.get(path)
    assert page.status_code == 200
    assert "text/html" in page.headers["content-type"]
    assert "Pay A$29 (demo)" in page.text
    assert "viewport" in page.text

    sig = re.search(r"sig=([0-9a-f]+)", path).group(1)
    done = client.post(f"/api/billing/demo-checkout?ws={ws['id']}&sig={sig}", follow_redirects=False)
    assert done.status_code == 303
    assert done.headers["location"] == "https://pulse.test/settings?billing=success"
    assert client.get("/api/billing", headers=headers).json()["plan"] == "pro"


def test_demo_checkout_rejects_bad_signature(auth, cfg):
    client, _headers, ws = auth
    assert client.get(f"/api/billing/demo-checkout?ws={ws['id']}&sig=deadbeef").status_code == 403
    assert client.post(f"/api/billing/demo-checkout?ws={ws['id']}&sig=deadbeef").status_code == 403
    assert _plan(ws["id"]) == "free"


def test_live_key_is_refused(auth, cfg, monkeypatch):
    client, headers, _ws = auth
    monkeypatch.setattr(settings, "stripe_secret_key", "sk_live_" + "x" * 24)
    called = []
    monkeypatch.setattr(stripe.checkout.Session, "create", lambda **kw: called.append(kw) or {"url": "x"})
    r = client.post("/api/billing/checkout", json={}, headers=headers)
    assert r.status_code == 503
    assert "test-mode" in r.json()["detail"]
    assert called == []
    # GET never reports a live key as usable
    assert client.get("/api/billing", headers=headers).json()["mode"] == "demo"


def test_test_key_checkout_uses_inline_price(auth, cfg, monkeypatch):
    client, headers, ws = auth
    monkeypatch.setattr(settings, "stripe_secret_key", "sk_test_abc")
    calls = []

    def fake_create(**kw):
        calls.append(kw)
        return {"url": "https://checkout.stripe.test/c/pay/cs_test_1"}

    monkeypatch.setattr(stripe.checkout.Session, "create", fake_create)
    r = client.post(
        "/api/billing/checkout",
        json={
            "success_url": "https://pulse.test/settings?billing=success",
            "cancel_url": "https://pulse.test/settings?billing=cancel",
        },
        headers=headers,
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"url": "https://checkout.stripe.test/c/pay/cs_test_1"}
    (kw,) = calls
    assert kw["mode"] == "subscription"
    assert kw["client_reference_id"] == ws["id"]
    assert kw["success_url"] == "https://pulse.test/settings?billing=success"
    assert kw["cancel_url"] == "https://pulse.test/settings?billing=cancel"
    (line,) = kw["line_items"]
    assert line["price_data"]["currency"] == "aud"
    assert line["price_data"]["unit_amount"] == 2900
    assert line["price_data"]["recurring"] == {"interval": "month"}
    assert line["price_data"]["product_data"]["name"] == "Pulse Pro: MCP + autopilot"
    assert stripe.api_key == "sk_test_abc"


def test_test_key_checkout_uses_configured_price_and_default_urls(auth, cfg, monkeypatch):
    client, headers, _ws = auth
    monkeypatch.setattr(settings, "stripe_secret_key", "sk_test_abc")
    monkeypatch.setattr(settings, "stripe_price_id", "price_test_123")
    calls = []
    monkeypatch.setattr(
        stripe.checkout.Session, "create", lambda **kw: calls.append(kw) or {"url": "https://c"}
    )
    assert client.post("/api/billing/checkout", headers=headers).status_code == 200
    (kw,) = calls
    assert kw["line_items"] == [{"price": "price_test_123", "quantity": 1}]
    assert kw["success_url"] == "https://pulse.test/settings?billing=success"
    assert kw["cancel_url"] == "https://pulse.test/settings?billing=cancel"


def test_webhook_completed_upgrades_and_is_idempotent(auth, cfg, monkeypatch):
    client, headers, ws = auth
    monkeypatch.setattr(settings, "stripe_webhook_secret", WEBHOOK_SECRET)
    evt = _event(
        "checkout.session.completed",
        {"client_reference_id": ws["id"], "customer": "cus_test_1", "mode": "subscription"},
    )
    body, sig = _signed(evt)
    for _ in range(2):  # replay: same end state
        r = client.post("/api/billing/webhook", content=body, headers={"stripe-signature": sig})
        assert r.status_code == 200, r.text
    assert _plan(ws["id"]) == "pro"
    assert client.get("/api/billing", headers=headers).json()["plan"] == "pro"


def test_webhook_subscription_deleted_downgrades(auth, cfg, monkeypatch):
    client, _headers, ws = auth
    monkeypatch.setattr(settings, "stripe_webhook_secret", WEBHOOK_SECRET)
    body, sig = _signed(
        _event("checkout.session.completed", {"client_reference_id": ws["id"], "customer": "cus_test_2"})
    )
    client.post("/api/billing/webhook", content=body, headers={"stripe-signature": sig})
    assert _plan(ws["id"]) == "pro"
    body, sig = _signed(_event("customer.subscription.deleted", {"customer": "cus_test_2"}))
    r = client.post("/api/billing/webhook", content=body, headers={"stripe-signature": sig})
    assert r.status_code == 200
    assert _plan(ws["id"]) == "free"


def test_webhook_bad_signature_rejected(auth, cfg, monkeypatch):
    client, _headers, ws = auth
    monkeypatch.setattr(settings, "stripe_webhook_secret", WEBHOOK_SECRET)
    evt = _event("checkout.session.completed", {"client_reference_id": ws["id"], "customer": "cus_x"})
    body, _ = _signed(evt, secret="whsec_wrong")
    r = client.post(
        "/api/billing/webhook", content=body, headers={"stripe-signature": _signed(evt, "whsec_wrong")[1]}
    )
    assert r.status_code == 400
    missing = client.post("/api/billing/webhook", content=body)
    assert missing.status_code == 400
    assert _plan(ws["id"]) == "free"


def test_webhook_without_secret_is_unavailable(auth, cfg):
    client, _headers, ws = auth
    body, sig = _signed(_event("checkout.session.completed", {"client_reference_id": ws["id"]}))
    r = client.post("/api/billing/webhook", content=body, headers={"stripe-signature": sig})
    assert r.status_code == 503


def test_portal_is_404_in_demo_and_url_in_test_mode(auth, cfg, monkeypatch):
    client, headers, ws = auth
    assert client.post("/api/billing/portal", headers=headers).status_code == 404
    monkeypatch.setattr(settings, "stripe_secret_key", "sk_test_abc")
    # no customer yet
    assert client.post("/api/billing/portal", headers=headers).status_code == 400
    monkeypatch.setattr(
        stripe.billing_portal.Session,
        "create",
        lambda **kw: {"url": f"https://billing.stripe.test/{kw['customer']}"},
    )
    conn = connect(settings.database_path)
    conn.execute("UPDATE workspaces SET stripe_customer_id = 'cus_p' WHERE id = ?", (ws["id"],))
    conn.commit()
    conn.close()
    r = client.post("/api/billing/portal", headers=headers)
    assert r.status_code == 200
    assert r.json() == {"url": "https://billing.stripe.test/cus_p"}


def test_require_plan_helper(auth, cfg):
    from fastapi import HTTPException

    _client, _headers, ws = auth
    conn = connect(settings.database_path)
    try:
        with pytest.raises(HTTPException) as exc:
            svc.require_plan(conn, ws["id"], "pro")
        assert exc.value.status_code == 402
        assert svc.require_plan(conn, ws["id"], "free") == "free"
        svc.set_plan(conn, ws["id"], "pro")
        assert svc.require_plan(conn, ws["id"], "pro") == "pro"
        with pytest.raises(HTTPException) as missing:
            svc.require_plan(conn, "w_nope", "pro")
        assert missing.value.status_code == 404
    finally:
        conn.close()

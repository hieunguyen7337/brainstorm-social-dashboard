"""Stripe billing: plan checks, Checkout, webhooks and the demo (no-key) flow.

Only Stripe *test* keys (`sk_test_...`) are ever used. Any other key is refused. With no key set the
app runs in demo mode: checkout returns a local, signed demo page that upgrades the workspace.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import sqlite3
from typing import Any

import stripe
from fastapi import HTTPException

from app.config import settings

log = logging.getLogger("pulse.billing")

PLANS = ("free", "pro")
PRICE_LABEL = "A$29/mo"
PRICE_CENTS = 2900
PRICE_CURRENCY = "aud"
PRODUCT_NAME = "Pulse Pro: MCP + autopilot"
FEATURES: dict[str, list[str]] = {
    "free": [
        "Dashboard, outside trends and themes",
        "Manual posts with tracked links",
        "Limited AI generations",
    ],
    "pro": [
        "Everything in free",
        "MCP server access for Claude (Desktop, Code, claude.ai)",
        "Autopilot: background drafting and publishing",
        "Higher AI generation limits",
    ],
}

# Used to sign demo-checkout links when no webhook secret is configured. Per-process: a demo link
# only needs to survive until the judge taps it.
_PROCESS_DEMO_KEY = secrets.token_bytes(32)


class BillingRefused(Exception):
    """Stripe is configured in a way we refuse to use (live key, missing webhook secret)."""


class InvalidWebhook(Exception):
    """Webhook signature or payload failed verification."""


def _rank(plan: str) -> int:
    return PLANS.index(plan) if plan in PLANS else 0


def stripe_key() -> str:
    """The test-mode secret key, or '' when none is set (demo mode). Refuses anything but sk_test_."""
    key = settings.stripe_secret_key.strip()
    if not key:
        return ""
    if not key.startswith("sk_test_"):
        raise BillingRefused("only Stripe test-mode keys (sk_test_...) are accepted; live keys are refused")
    return key


def billing_mode() -> str:
    """'stripe_test' with a test key, 'demo' without a key. Raises BillingRefused for live keys."""
    return "stripe_test" if stripe_key() else "demo"


def public_base() -> str:
    return settings.public_base_url.rstrip("/")


def default_success_url() -> str:
    return f"{public_base()}/settings?billing=success"


def default_cancel_url() -> str:
    return f"{public_base()}/settings?billing=cancel"


def require_plan(conn: sqlite3.Connection, ws_id: str, plan: str) -> str:
    """Return the workspace's plan if it is at least `plan`, else raise 402 (404 for unknown workspace).

    Not wired into any route yet; intended for pro-only features such as the MCP tools and autopilot.
    """
    if plan not in PLANS:
        raise ValueError(f"unknown plan {plan!r}")
    row = conn.execute("SELECT plan FROM workspaces WHERE id = ?", (ws_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="unknown workspace")
    current = row["plan"]
    if _rank(current) < _rank(plan):
        raise HTTPException(status_code=402, detail=f"plan '{plan}' required")
    return current


def set_plan(conn: sqlite3.Connection, ws_id: str, plan: str, customer_id: str | None = None) -> bool:
    """Set a workspace's plan (and Stripe customer id when given). Returns False if no such workspace."""
    if plan not in PLANS:
        raise ValueError(f"unknown plan {plan!r}")
    cur = conn.execute(
        "UPDATE workspaces SET plan = ?, stripe_customer_id = COALESCE(?, stripe_customer_id) WHERE id = ?",
        (plan, customer_id, ws_id),
    )
    conn.commit()
    return cur.rowcount > 0


def checkout_line_items() -> list[dict[str, Any]]:
    if settings.stripe_price_id.strip():
        return [{"price": settings.stripe_price_id.strip(), "quantity": 1}]
    return [
        {
            "quantity": 1,
            "price_data": {
                "currency": PRICE_CURRENCY,
                "unit_amount": PRICE_CENTS,
                "recurring": {"interval": "month"},
                "product_data": {"name": PRODUCT_NAME},
            },
        }
    ]


def create_checkout_url(ws: sqlite3.Row, success_url: str | None, cancel_url: str | None) -> str:
    """A Stripe test-mode Checkout URL, or the demo checkout URL when no key is set."""
    if billing_mode() == "demo":
        return demo_checkout_url(ws["id"])
    stripe.api_key = stripe_key()
    params: dict[str, Any] = {
        "mode": "subscription",
        "line_items": checkout_line_items(),
        "client_reference_id": ws["id"],
        "success_url": success_url or default_success_url(),
        "cancel_url": cancel_url or default_cancel_url(),
    }
    if ws["stripe_customer_id"]:
        params["customer"] = ws["stripe_customer_id"]
    session = stripe.checkout.Session.create(**params)
    return session["url"]


def create_portal_url(customer_id: str) -> str:
    stripe.api_key = stripe_key()
    session = stripe.billing_portal.Session.create(customer=customer_id, return_url=default_success_url())
    return session["url"]


def _demo_sig(ws_id: str) -> str:
    key = (settings.stripe_webhook_secret or "").encode() or _PROCESS_DEMO_KEY
    return hmac.new(key, f"demo-checkout:{ws_id}".encode(), hashlib.sha256).hexdigest()


def demo_sig_ok(ws_id: str, sig: str | None) -> bool:
    return hmac.compare_digest(_demo_sig(ws_id), sig or "")


def demo_checkout_url(ws_id: str) -> str:
    return f"{public_base()}/api/billing/demo-checkout?ws={ws_id}&sig={_demo_sig(ws_id)}"


def _field(obj: Any, key: str) -> Any:
    # StripeObject is not a dict in SDK v17 (no .get), but supports `in` and [].
    try:
        return obj[key]
    except KeyError:
        return None


def handle_webhook(conn: sqlite3.Connection, payload: bytes, signature: str | None) -> str:
    """Verify and apply a Stripe webhook. Returns the event type. Idempotent (state is set, not toggled)."""
    secret = settings.stripe_webhook_secret.strip()
    if not secret:
        raise BillingRefused("STRIPE_WEBHOOK_SECRET is not set")
    if not signature:
        raise InvalidWebhook("missing Stripe-Signature header")
    try:
        event = stripe.Webhook.construct_event(payload, signature, secret)
    except (stripe.SignatureVerificationError, ValueError) as exc:
        raise InvalidWebhook(str(exc)) from exc

    etype = event["type"]
    obj = event["data"]["object"]
    if etype == "checkout.session.completed":
        ws_id = _field(obj, "client_reference_id")
        if ws_id:
            set_plan(conn, ws_id, "pro", _field(obj, "customer"))
    elif etype == "customer.subscription.deleted":
        customer = _field(obj, "customer")
        if customer:
            conn.execute("UPDATE workspaces SET plan = 'free' WHERE stripe_customer_id = ?", (customer,))
            conn.commit()
    else:
        log.info("stripe event ignored: %s", etype)
    return etype

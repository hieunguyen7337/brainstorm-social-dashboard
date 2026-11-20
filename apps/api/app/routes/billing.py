"""Billing endpoints: plan info, Checkout, webhook, customer portal, and the demo checkout page."""

import html
import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel, HttpUrl

from app.auth import get_workspace
from app.db import get_db
from app.services import billing as svc

router = APIRouter(prefix="/api/billing", tags=["billing"])


class BillingOut(BaseModel):
    plan: str
    mode: str
    price_label: str
    features: dict[str, list[str]]


class CheckoutIn(BaseModel):
    success_url: HttpUrl | None = None
    cancel_url: HttpUrl | None = None


class UrlOut(BaseModel):
    url: str


def _mode_or_503() -> str:
    try:
        return svc.billing_mode()
    except svc.BillingRefused as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("", response_model=BillingOut)
def get_billing(ws: sqlite3.Row = Depends(get_workspace)):
    try:
        mode = svc.billing_mode()
    except svc.BillingRefused:
        # Never report a live key as usable; checkout and portal refuse with 503 instead.
        mode = "demo"
    return BillingOut(
        plan=ws["plan"],
        mode=mode,
        price_label=svc.PRICE_LABEL,
        features=svc.FEATURES,
    )


@router.post("/checkout", response_model=UrlOut)
def checkout(
    body: CheckoutIn | None = None,
    ws: sqlite3.Row = Depends(get_workspace),
):
    _mode_or_503()
    body = body or CheckoutIn()
    url = svc.create_checkout_url(
        ws,
        str(body.success_url) if body.success_url else None,
        str(body.cancel_url) if body.cancel_url else None,
    )
    return UrlOut(url=url)


@router.post("/webhook")
async def webhook(request: Request, conn: sqlite3.Connection = Depends(get_db)):
    payload = await request.body()
    try:
        event_type = svc.handle_webhook(conn, payload, request.headers.get("stripe-signature"))
    except svc.BillingRefused as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except svc.InvalidWebhook as exc:
        raise HTTPException(status_code=400, detail="invalid webhook") from exc
    return {"received": True, "type": event_type}


@router.post("/portal", response_model=UrlOut)
def portal(ws: sqlite3.Row = Depends(get_workspace)):
    if _mode_or_503() == "demo":
        raise HTTPException(status_code=404, detail="customer portal is not available in demo mode")
    if not ws["stripe_customer_id"]:
        raise HTTPException(status_code=400, detail="no Stripe customer yet; upgrade first")
    return UrlOut(url=svc.create_portal_url(ws["stripe_customer_id"]))


def _demo_workspace(conn: sqlite3.Connection, ws_id: str | None, sig: str | None) -> sqlite3.Row:
    if not ws_id or not svc.demo_sig_ok(ws_id, sig):
        raise HTTPException(status_code=403, detail="invalid demo checkout link")
    row = conn.execute("SELECT * FROM workspaces WHERE id = ?", (ws_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="unknown workspace")
    return row


_DEMO_PAGE = """<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Upgrade to Pro (demo)</title>
<style>
  :root {{ color-scheme: light dark; --bg:#f5f6fa; --card:#ffffff; --ink:#15171c; --muted:#6b7280;
          --brand:#635bff; --line:#e5e7eb; }}
  @media (prefers-color-scheme: dark) {{
    :root:not([data-theme="light"]) {{ --bg:#0f1115; --card:#181b22; --ink:#f3f4f6; --muted:#9ca3af;
            --brand:#8b84ff; --line:#2a2e38; }}
  }}
  :root[data-theme="dark"] {{ --bg:#0f1115; --card:#181b22; --ink:#f3f4f6; --muted:#9ca3af;
          --brand:#8b84ff; --line:#2a2e38; }}
  body {{ margin:0; background:var(--bg); color:var(--ink);
         font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }}
  main {{ max-width:420px; margin:0 auto; padding:24px 16px; }}
  .card {{ background:var(--card); border:1px solid var(--line); border-radius:14px; padding:20px; }}
  .tag {{ display:inline-block; font-size:12px; color:var(--muted); letter-spacing:.04em; }}
  h1 {{ font-size:22px; margin:6px 0 2px; }}
  .price {{ font-size:28px; font-weight:700; margin:12px 0 4px; }}
  .muted {{ color:var(--muted); font-size:14px; }}
  ul {{ padding-left:18px; margin:12px 0; }}
  button {{ width:100%; padding:14px; border:0; border-radius:10px; background:var(--brand);
           color:#fff; font-size:16px; font-weight:600; cursor:pointer; margin-top:8px; }}
  a.cancel {{ display:block; text-align:center; margin-top:14px; color:var(--muted); font-size:14px; }}
</style></head>
<body><main><div class="card">
  <span class="tag">DEMO CHECKOUT · NO CARD NEEDED</span>
  <h1>{product}</h1>
  <div class="muted">For {brand}</div>
  <div class="price">{price}</div>
  <ul>{features}</ul>
  <form method="post" action="{action}">
    <button type="submit">Pay A$5 (demo)</button>
  </form>
  <a class="cancel" href="{cancel}">Cancel</a>
</div></main></body></html>"""


@router.get("/demo-checkout", response_class=HTMLResponse)
def demo_checkout_page(
    ws: str | None = None,
    sig: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
):
    row = _demo_workspace(conn, ws, sig)
    action = f"/api/billing/demo-checkout?ws={html.escape(row['id'])}&amp;sig={html.escape(sig or '')}"
    features = "".join(f"<li>{html.escape(f)}</li>" for f in svc.FEATURES["pro"])
    page = _DEMO_PAGE.format(
        product=html.escape(svc.PRODUCT_NAME),
        brand=html.escape(row["brand_name"]),
        price=html.escape(svc.PRICE_LABEL),
        features=features,
        action=action,
        cancel=html.escape(svc.default_cancel_url()),
    )
    return HTMLResponse(page)


@router.post("/demo-checkout")
def demo_checkout_confirm(
    ws: str | None = None,
    sig: str | None = None,
    conn: sqlite3.Connection = Depends(get_db),
):
    row = _demo_workspace(conn, ws, sig)
    svc.set_plan(conn, row["id"], "pro")
    return RedirectResponse(svc.default_success_url(), status_code=303)

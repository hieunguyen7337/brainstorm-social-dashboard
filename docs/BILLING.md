# Pulse billing (MCP subscription, Stripe test mode)

Pulse Pro is A$5/month and unlocks the MCP server and autopilot. Billing is wired for Stripe **test mode only**.
Any key that does not start with `sk_test_` is refused (checkout and portal return 503; `GET /api/billing` reports
`mode: "demo"`). With no key at all, the app runs in **demo mode**: checkout returns a local page that looks like a
checkout and upgrades the workspace with one tap. No real money moves in either mode.

## Endpoints (all JSON unless noted; `/api/*` except webhook needs `Authorization: Bearer <token>`)

| Method | Path | Result |
|---|---|---|
| GET | /api/billing | `{plan, mode: "stripe_test"\|"demo", price_label: "A$5/mo", features: {free, pro}}` |
| POST | /api/billing/checkout | body `{"success_url"?, "cancel_url"?}` -> `{"url"}` (Stripe Checkout, or demo page) |
| POST | /api/billing/webhook | Stripe webhook; verifies `Stripe-Signature`; 400 if invalid |
| POST | /api/billing/portal | `{"url"}` to the Stripe customer portal; 404 in demo mode |
| GET/POST | /api/billing/demo-checkout?ws=&sig= | demo checkout page; POST upgrades to pro and redirects |

Events handled: `checkout.session.completed` (plan `pro`, stores the customer id) and
`customer.subscription.deleted` (plan `free`). Both set state rather than toggling it, so replays are harmless.

Gating: `app.services.billing.require_plan(conn, workspace_id, "pro")` raises 402 for free workspaces. It is not
wired into any route yet.

## Test mode setup (Fly secrets)

Create a Stripe account, stay in **Test mode** (toggle in the dashboard), then:

```sh
fly secrets set \
  STRIPE_SECRET_KEY=sk_test_... \
  STRIPE_WEBHOOK_SECRET=whsec_... \
  STRIPE_PRICE_ID=price_...        # optional: omit to use an inline A$5/month price
```

- `STRIPE_SECRET_KEY`: test secret key (`sk_test_...`). Never put a live key here.
- `STRIPE_WEBHOOK_SECRET`: the signing secret (`whsec_...`) for the webhook endpoint. Without it, the webhook returns 503.
- `STRIPE_PRICE_ID`: an optional recurring AUD 5/month test price. Empty means inline `price_data`.

Set `PUBLIC_BASE_URL` to the public Fly URL so success, cancel and portal redirects land on the app.

Register the webhook in the Stripe test dashboard (Developers > Webhooks) at
`https://<your-app>.fly.dev/api/billing/webhook`, listening for `checkout.session.completed` and
`customer.subscription.deleted`.

## Local testing with the Stripe CLI

```sh
stripe login
stripe listen --forward-to localhost:8000/api/billing/webhook
# copy the printed whsec_... into STRIPE_WEBHOOK_SECRET for the local API
```

Pay with the test card **4242 4242 4242 4242** (any future expiry, any CVC, any postcode).

## Demo checkout

With no `STRIPE_SECRET_KEY`, `POST /api/billing/checkout` returns
`<PUBLIC_BASE_URL>/api/billing/demo-checkout?ws=<id>&sig=<hmac>`. The link is HMAC-signed; a tampered or foreign
link gets 403. Tapping "Pay A$5 (demo)" upgrades the workspace and redirects to `/settings?billing=success`.

## Curl examples

```sh
API=http://localhost:8000
TOKEN=<workspace token from POST /api/workspaces>

curl -s $API/api/billing -H "Authorization: Bearer $TOKEN"
curl -s -X POST $API/api/billing/checkout -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{}'
curl -s -X POST $API/api/billing/portal -H "Authorization: Bearer $TOKEN"

# Webhook (Stripe sends this; for manual tests use `stripe trigger checkout.session.completed` instead)
curl -s -X POST $API/api/billing/webhook -H 'Stripe-Signature: t=...,v1=...' -d @event.json
```

## Renaming

The name on Stripe Checkout (its header, through `branding_settings.display_name`, and the "<Name> Pro" product line) is the `APP_NAME` setting, default `Pulse`. To rename without a code change: `flyctl secrets set APP_NAME="New Name" -a pulse-hackathon` (the app restarts in about 30 s; `flyctl secrets unset APP_NAME` goes back to Pulse). The Stripe account's own public name is not used, so a sandbox needs no activation for this.

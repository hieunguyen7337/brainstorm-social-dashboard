# Real numbers for everyone (owner, 21 Nov 08:30)

Owner's words: "I want everyone to use the app will have their real social media numbers, not fake".

So every workspace the app creates is a **real workspace**: no seeded audience, posts, daily metrics or activity.
Numbers appear only when the person connects an account, and every number on screen comes from that person.

Why not fetch automatically: on 21 Nov the platforms refused anonymous requests both from Fly and from a home
connection (Instagram 429, TikTok bot wall, Reddit 403, LinkedIn 999, Facebook 400, X 429). Real numbers
therefore come from the person, in one of two ways:
1. **Screenshot** (main path, every device): the person uploads a screenshot of their profile or insights page;
   Claude reads the numbers; the person checks them and saves.
2. **Type them** (fallback, and when AI is off or capped).

## Workspace

- `POST /api/workspaces` body `WorkspaceCreate` gains `real: bool = False`. The app always sends `real: true`.
  `false` keeps today's sample seed for tests and the MCP demo; no screen in the app creates one.
- `workspaces.data_mode TEXT NOT NULL DEFAULT 'sample'` ('sample' | 'real'), added through `db.py`'s existing
  ALTER-column migration so the live SQLite file upgrades in place. `Workspace` gains `data_mode`.
- A real workspace gets: the workspace row, the 4 default themes (content pillars, no numbers), the default
  autopilot config (off), and 6 connections with `status 'disconnected'`, `mode 'live'`, `followers 0`,
  `handle ''`. No posts, no daily_metrics, no events.

## Reading a screenshot

`POST /api/connections/{platform}/screenshot` (Bearer), JSON `{ "image_base64": "<no data: prefix>",
"media_type": "image/png" | "image/jpeg" | "image/webp" }`, decoded size at most 5 MB (413 above),
unknown platform 404, other media types 415.

Response `ScreenshotRead`:
```
{ "platform": "instagram",            // the path's platform
  "detected_platform": "instagram"|null, // what the image looks like; the app warns when it differs
  "handle": "hieu73372025"|null,
  "followers": 46|null, "following": 48|null, "posts_count": 0|null,
  "views": 1234|null, "engagements": 56|null, "profile_views": 215|null,
  "likes": 40|null, "comments": 12|null, "shares": 4|null,  // the account's own split, only when shown apart
  "period_days": 7|30|90|null,          // the window views/engagements/likes/comments/shares/profile_views cover
  "posts": [ { "content": "first 200 chars"|null, "views": 0|null, "likes": 0|null,
               "comments": 0|null, "shares": 0|null, "posted_at": "YYYY-MM-DD"|null } ],  // max 20
  "confidence": "high"|"medium"|"low",
  "notes": "one short line for the person"|null,
  "ai_used": true }
```
- Claude reads the image with structured output (model `settings.ai_model`, the same SDK pattern as
  `services/ai.py`). Only numbers visible in the image; null when not shown; never estimate. "1.2K" -> 1200.
- It counts against the same AI caps (`purpose 'vision'`). Cap reached, no key or API error -> 503
  `{"detail": "Couldn't read the screenshot right now. Try again in a moment."}`.
- Nothing is saved by this call. The image is not stored or logged.

## Saving

The app saves with the existing `POST /api/metrics/ingest`, with these changes:
- `source` also accepts `"screenshot"` and `"device"`.
- New optional `handle` (max 100 chars, leading `@` stripped) and `period_days`.
- Ingest marks the connection `status 'connected'`, `mode 'live'`, sets `handle` when given and `followers` when
  given, records a `connected` event the first time ("Connected Instagram (real)"), and keeps everything else it
  does today (snapshots, posts matched or created with `metrics_source 'real'`, daily_metrics deltas).
- Account `likes`, `comments`, `shares` are optional too (see "Engagement split" in CONTRACT.md); with none of them
  the Engagements tile shows one number as before.
- Post-level numbers: `views` and `engagements` (likes + comments + shares when only those are known) are
  required on `IngestPost` today; the app sends 0 for a missing one only when the other is known, else skips the
  post.

## Dashboard in a real workspace

- `DashboardSummary` gains `data_mode`, `followers_total`, and `by_platform[i].followers` (connected only).
- For each connected platform, views and engagements in the window are the larger of (a) its daily_metrics sum
  and (b) the latest account snapshot's value whose `period_days` fits inside the window. Totals and shares use
  those. Clicks and conversions stay the real tracked-link events.
- `change_pct` is computed from real history only; with fewer than two snapshots per platform it is 0, and the
  app shows "new" instead of 0%.
- No simulated growth: `metrics.tick` already skips `mode 'live'` connections; publishing a post in a real
  workspace marks it published and opens the platform's share sheet in the app; its numbers come from its tracked
  link and later screenshots.

## App

- Every new workspace is created with `real: true` (onboarding, room "Open your own Pulse", web `/?room=`).
- Onboarding: after the brand step, "Connect your real accounts": the 6 platforms, each with "Upload a
  screenshot" and "Type numbers". Skippable ("Later"). The same component lives in Settings > Accounts.
- Each platform card says where to take the screenshot:
  - Instagram: your profile (followers), or Professional dashboard > Insights (accounts reached, last 30 days);
  - LinkedIn: linkedin.com/dashboard (post impressions, followers, profile viewers);
  - TikTok: your profile (followers, likes), or Creator tools > Analytics;
  - X: your profile (followers), or Analytics;
  - Reddit: your profile (karma, followers);
  - Facebook: your Page, or Professional dashboard.
- After a screenshot: an editable form prefilled with what Claude read, a "Read by Claude, check before saving"
  line, then Save -> ingest with `source "screenshot"`. "Type numbers" saves with `source "manual"`.
- Dashboard with nothing connected: one large call to action, "Connect an account to see your real numbers",
  and no sample charts. Connected platforms show a "Real" badge and "Updated <relative time>".
- Image picking: web uses a file input (works on iPhone Safari and desktop). Native uses `expo-image-picker`
  when its native module is present; an APK without it opens the web app at `/#ws=<token>&connect=<platform>`
  in the browser (the `#ws=` link already opens the same workspace), so OTA updates never crash an older APK.
- No fake numbers anywhere in the app's normal paths: no sample seed, no offline mock data on screen. The one
  exception is the clearly labelled **demo workspace** below, which only the "Try the demo" link creates.

## Demo workspaces (owner, 21 Nov): synthetic sign-ins and numbers, for tests and demos

Signing in to a real platform needs real credentials, so the pathway (onboarding, Connect, Dashboard, Trends, Create,
Queue, Settings) cannot be demonstrated or tested end to end. A **demo workspace** gives it synthetic sign-ins and
numbers that are labelled as synthetic everywhere they appear. Real workspaces and the real sign-in, auto-read,
screenshot and vault flows are untouched.

- **Creation.** `POST /api/workspaces` body gains `demo: bool = False` (`real` and `demo` together is a 422).
  `workspaces.data_mode` gains the value `'demo'`. The only thing in the app that creates one is the **Try the demo**
  link under "Start my workspace" on onboarding. A demo workspace starts like a real one: disconnected connections
  (`mode 'sandbox'`), the 4 default themes, autopilot off, no posts, daily metrics, snapshots or events. It offers
  exactly the platforms the real app does (`app/platforms.py`): a "coming soon" platform answers 422 in the demo too.
- **Synthetic sign-in.** `POST /api/connections/{platform}/demo` (no body, `data_mode 'demo'` only; 409 in a real or
  sample workspace) connects the platform as `sandbox` with a handle from the brand slug and backfills 60 days of
  deterministic daily metrics (same brand and platform, same numbers), three published posts
  (`source 'seed'`, `metrics_source 'sim'`, one published minutes ago so the simulated audience visibly grows it),
  a `Connected X (demo)` event with `real 0` and one account snapshot with `source 'demo'`. It is idempotent: signing
  in again adds nothing twice. `POST /api/connections/{platform}` in a demo workspace does the same thing.
- **No real numbers in, no synthetic numbers out.** In a demo workspace `POST /api/metrics/ingest`, the screenshot
  reader (no AI is used) and `PUT .../profile` answer 409. The generator never writes `real = 1` and never calls the
  tracked-link routes, so "real people" counts stay real. `metrics_source 'sim'` makes Insights call every demo post
  simulated.
- **App.** "Connect with <Platform>" opens a platform-coloured, DEMO-labelled fake sign-in page (pure React Native, so it
  works on web, iOS, Android and Expo Go; no WebView, no vault, nothing sent to the platform), then a "Reading your
  numbers" checklist while the server call runs. The Dashboard carries a permanent "Demo workspace: every number is
  synthetic" bar with "Start my real workspace"; cards say "Demo" instead of "Real"; there is no screenshot upload and
  the background auto-read skips demo connections (they are `sandbox`, real ones are `live`). An app talking to a server
  that predates this answers the demo request with a sample workspace: the app refuses it with "The demo isn't
  available on this server yet." instead of keeping a workspace it would forget at the next start.

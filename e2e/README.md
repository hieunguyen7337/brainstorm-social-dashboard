# Pulse e2e (Playwright, phone viewports)

```
cd e2e
npm install
npx playwright install chromium webkit
BASE_URL=https://<live-url> npx playwright test      # default http://localhost:8000
npx playwright test --project=iphone                 # or android
```

Projects: `iphone` (iPhone 15, WebKit), `android` (Pixel 7, Chromium). Retries 1, trace on failure.
Screenshots of every test end go to `e2e/screenshots/` (gitignored); traces/results to `e2e/test-results/`.

Specs: onboarding, trends, create/publish/queue, tracked link, API smoke (health + `/mcp` tools/list = 10), console errors.

Notes: the auth token is found by scanning localStorage for a value `/api/workspace` accepts, so the storage key
does not matter. Tab/button lookup uses role/text labels from the brief.

## Layout check (every tab at desktop 1440x900 and phone 390x844)

`tests/layout.spec.ts` + `playwright.layout.config.ts` (separate from the phone functional suite above; Chromium only,
projects `desktop` and `phone`). For each project it onboards ("Try the demo", then the synthetic Instagram sign-in), opens Dashboard, Trends, Create, Queue,
Settings in turn, writes a full-content screenshot to `e2e/screenshots/layout-<project>-<tab>.png` and fails on:

- horizontal overflow: `scrollWidth` of `html`/`body` beyond the viewport, `window.innerWidth` growing past it, or any visible
  element whose right edge is past the viewport (skipping elements inside an `overflow-x: auto|scroll` box, parked
  off-screen `fixed`/`absolute` elements and the inactive tab scenes react-navigation keeps mounted); the failure names
  the first offender's tag/text/testID;
- any console `error` or `pageerror` (only favicon/manifest/apple-touch-icon load failures and `net::ERR_*` failures of
  `/api/` requests are ignored);
- `wide arrangement` (separate describe, so the checks above stay independent): the tab buttons are a vertical left
  sidebar at 1440 and one bottom row at 390; on the desktop Dashboard "Outside trends" sits right of "Views by platform",
  "Generate", "Social media connectors" and "Themes (Jev AI)" are visible and the page is at most 4 viewport heights
  tall; Queue shows Drafts/Scheduled/Published as three side-by-side columns; Trends has at least two cards in one row.

```
# 1. build the mock export (bakes in the in-memory fake API; apps/mobile/dist-mock is gitignored)
cd apps/mobile && EXPO_PUBLIC_MOCK=1 npx expo export --platform web --output-dir dist-mock

# 2. run both projects (starts `node e2e/scripts/serve-dist.mjs` on :4173, SPA fallback, serving apps/mobile/dist-mock)
cd e2e && npm ci && npx playwright test -c playwright.layout.config.ts
npx playwright test -c playwright.layout.config.ts --project=phone                 # one project
npx playwright test -c playwright.layout.config.ts -g "overflow"                   # skip the arrangement checks

# other build dir / port (e.g. to avoid colliding with someone else's server)
DIST_DIR=/tmp/pulse-dist PORT=4191 npx playwright test -c playwright.layout.config.ts

# against a running app instead (no server is started): the live deploy with the real API, or any dev server
BASE_URL=https://<live-url> npx playwright test -c playwright.layout.config.ts
```

`DIST_DIR` is relative to the repo root or absolute. The webServer refuses to reuse a server already on the port (a stale
one would serve another build): pick a free `PORT`. Chromium: the one `playwright install` fetched for the installed
`@playwright/test`; when that build is missing the config falls back to `/opt/pw-browsers/chromium` with `--no-sandbox`
(override with `CHROMIUM_PATH=/path/to/chrome`). Traces of failed tests go to `e2e/test-results/layout/`.
The Dashboard/Queue/Trends board checks assume the 1440 layout and skip themselves on the phone project; the navigation
check runs on both (sidebar at 1440, bottom bar at 390).

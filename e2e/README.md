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

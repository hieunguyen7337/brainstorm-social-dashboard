# Q1 live QA: pulse-hackathon.fly.dev (phone viewports)

**Status: BLOCKED. The live URL does not serve the Pulse app.** Only the API-level checks ran against the live site. 10 of the 11 requested screenshots could not be taken.

Branch: pushed to `claude/qa-live-phone-screenshots-271nag`, the session's designated branch. The brief asked for `qa/live-1`, which I did not create or push to.

## 1. Blocker: the live site serves a landing page, not the app

- `GET /`, `/onboarding` and `/dashboard` all return 200 with the same 11,978-byte HTML (byte-identical). Title: `Install Pulse on Android`. It has 0 `<script>` tags and no "Start my demo" button. Both Pixel 7 and iPhone user agents get this page.
- The string "Install Pulse on Android" appears nowhere in this checkout's `apps/`.
- In this checkout the anonymous entry route sends users to `/onboarding` (`apps/mobile/app/index.tsx:6-9`). The "Start my demo" button is at `apps/mobile/app/onboarding.tsx:90`. Neither runs on the live site, so the deployed build does not match this checkout.
- The live `/mcp` `tools/list` returns 24 tools. `apps/api/app/mcp_server.py:103-206` defines 10, and the spec (and the contract) assert 10. This is a second sign that the deployed build differs from this checkout.
- `/download/android` returns 302 to expo.dev (`apps/api/app/main.py:71-75`), not an APK page.
- Fix is owner-side: redeploy the web export of this checkout to Fly. I did not deploy anything.

## 2. Spec results (live, both projects, `--retries=0 --timeout=20000 --trace off`)

Command: `BASE_URL=https://pulse-hackathon.fly.dev QA_USE_PROXY=1 QA_IPHONE_CHROMIUM=1 PLAYWRIGHT_BROWSERS_PATH=<scratch>/pw-browsers npx playwright test --reporter=list --retries=0 --timeout=20000 --trace off`

Result: **2 passed, 12 failed** (1.9 min). The 20 s timeout and no retry differ from the config (60 s, 1 retry).

| Spec | iphone | android | First error line |
|---|---|---|---|
| api-smoke: health endpoint | PASS | PASS | (none) |
| api-smoke: `/mcp` tools/list returns 10 tools | FAIL | FAIL | `expect(received).toHaveLength(expected)`: expected 10, received 24 (`e2e/tests/api-smoke.spec.ts:40`) |
| onboarding: creates workspace, KPIs and funnel | FAIL | FAIL | `locator.click: Test timeout of 20000ms exceeded`, on `getByRole('button', { name: /start my demo/i })` (`e2e/tests/fixtures.ts:53`) |
| console: no console errors on each tab | FAIL | FAIL | same as above |
| create: two variants, publish, Queue | FAIL | FAIL | same as above |
| tracked-link: click and conversion | FAIL | FAIL | same as above |
| trends: list has at least 5 items | FAIL | FAIL | same as above |

The 10 UI-spec failures are all the same missing button. None of them reached the app, so none of their assertions were tested.

Earlier run without `QA_USE_PROXY=1` (kept for the record): every API call failed with `getaddrinfo ENOTFOUND pulse-hackathon.fly.dev`, including `/api/health`. Playwright's API client does not use `HTTPS_PROXY` in this sandbox. Curl does, and it returned 200 for `/api/health`.

## 3. Screenshots and console errors per screen

Only one of 11 screens was captured.

- **01-onboarding.png** (1179×7443 px, DPR 3, so 393 px wide). This is the root landing page, not the app's onboarding. It shows: the "Your socials, on autopilot." hero, "Download for Android" and "Download for Desktop" buttons, and a static phone mockup of a dashboard with Followers 2,481, Views 18.2k, Engagements 1,036, Link clicks 342 and a "Next post, drafted by AI" card. These are fixed marketing numbers, not live data. No horizontal overflow is visible. Console errors: none (`console.json` = `{"01-onboarding": []}`).

Not captured (all need the app): 02 Dashboard, 03/04 Create before and after Generate, 05 Queue, 06 Trends, 07/08 Settings (Connectors, Connect Claude MCP), 09 tracked link `/l/<code>`, 10 `/download/android` (302 to expo.dev, not followed), 11 Dashboard at 1280×800.

## 4. Guest workspace and Generate budget

- Guest workspaces created: **2**. Both came from the api-smoke MCP test, one per project. The UI onboarding never found its button, so it created none.
- Generate presses: **0**. Publishes: **0**.

## 5. Ranked issues

1. **Deploy mismatch (blocks all UI QA).** The live site serves a static landing page, not this checkout's Expo web app. Owner action: redeploy the web export.
2. **Live `/mcp` exposes 24 tools; this checkout and the contract say 10** (`apps/api/app/mcp_server.py:103-206`). Same build mismatch as #1.
3. **Judge-facing risk.** The landing page's dashboard mockup shows fixed numbers (2,481 followers, 18.2k views) that a judge could read as live. The source is not in this checkout, so I have no file:line.
4. **`/download/android` redirects to expo.dev** (`apps/api/app/main.py:71-75`). If judges expect an APK, the target needs confirming.

## 6. Harness changes in `e2e/` (no assertion changed)

- `QA_WORKSPACE_TOKEN`: reuse one guest workspace for all onboarding, token and MCP-smoke tests. Off by default.
- `onboarding.spec.ts` uses real onboarding: `onboard(page, { real: true })`.
- `api-smoke` MCP test reuses the shared token when it is set.
- `QA_IPHONE_CHROMIUM=1`: runs the iPhone 15 device on Chromium, because WebKit is not installed. This is a fidelity gap: the viewport, user agent and touch are iPhone's, but the engine is not WebKit.
- `QA_USE_PROXY=1`: passes `HTTPS_PROXY` to Playwright, so the API client and the browser go through the sandbox proxy.

## 7. Environment notes

- Playwright 1.65.1 expects Chromium 1255. `/opt/pw-browsers` has 1243. I used scratch symlinks (`chromium-1255` and `chromium_headless_shell-1255` pointing at the 1243 installs) via `PLAYWRIGHT_BROWSERS_PATH`. Only `npm ci` ran (e2e dependencies). No browser was installed and `playwright install` was not run.
- WebKit is not installed.
- The live host was refused by the agent proxy (403) until `pulse-hackathon.fly.dev` was added to this repo's personal environment allowlist. That change went through the approval prompt and was accepted.

## 8. Re-run plan once the app is served

1. `node qa/live-1/shoot.mjs` from the repo root: one workspace, one Generate, saves the token to the scratch token file (mode 600), 11 screens, about 3–4 min.
2. Suite: `QA_WORKSPACE_TOKEN="$(cat <scratch>/qa-live-1/workspace-token.txt)" QA_USE_PROXY=1 QA_IPHONE_CHROMIUM=1 BASE_URL=https://pulse-hackathon.fly.dev npx playwright test --retries=0 --trace off`.
3. Expected budget: workspaces 1 + 2 (real onboarding, once per project) = 3. Generate 1 + 2 (create, once per project) = 3.

## 9. Files

- `qa/live-1/REPORT.md` (this file)
- `qa/live-1/shoot.mjs`: the screenshot script (re-runnable; reuses the saved token; Generate and Publish run at most once)
- `qa/live-1/01-onboarding.png`, `qa/live-1/console.json`
- `qa/live-1/suite-run.log`: full output of the second suite run

## 10. Last 30 lines of real suite output (run 2)

```


       at fixtures.ts:53

      51 |   }
      52 |   await page.goto('/');
    > 53 |   await page.getByRole('button', { name: /start my demo/i }).click();
         |                                                              ^
      54 |   await expect(page.getByText('Views by platform')).toBeVisible({ timeout: 30_000 });
      55 | }
      56 |
        at onboard (/home/user/brainstorm-social-dashboard/e2e/tests/fixtures.ts:53:62)
        at /home/user/brainstorm-social-dashboard/e2e/tests/trends.spec.ts:4:3

    Error Context: test-results/trends-trends-list-loads-with-at-least-5-items-android/error-context.md

  12 failed
    [iphone] › tests/api-smoke.spec.ts:9:1 › /mcp tools/list returns 10 tools ──────────────────────
    [iphone] › tests/console.spec.ts:3:1 › no console errors on load of each tab ───────────────────
    [iphone] › tests/create.spec.ts:3:1 › create two variants, publish one, see it in Queue with growing views 
    [iphone] › tests/onboarding.spec.ts:3:1 › onboarding creates a workspace and shows dashboard with KPIs and funnel 
    [iphone] › tests/tracked-link.spec.ts:3:1 › real click and conversion on a tracked link show up on the dashboard 
    [iphone] › tests/trends.spec.ts:3:1 › trends list loads with at least 5 items ──────────────────
    [android] › tests/api-smoke.spec.ts:9:1 › /mcp tools/list returns 10 tools ─────────────────────
    [android] › tests/console.spec.ts:3:1 › no console errors on load of each tab ──────────────────
    [android] › tests/create.spec.ts:3:1 › create two variants, publish one, see it in Queue with growing views 
    [android] › tests/onboarding.spec.ts:3:1 › onboarding creates a workspace and shows dashboard with KPIs and funnel 
    [android] › tests/tracked-link.spec.ts:3:1 › real click and conversion on a tracked link show up on the dashboard 
    [android] › tests/trends.spec.ts:3:1 › trends list loads with at least 5 items ─────────────────
  2 passed (1.9m)
```

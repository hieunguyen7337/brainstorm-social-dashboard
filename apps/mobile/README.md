# Pulse app (Expo: web + Android + iOS from one codebase)

Phone-first Expo SDK 57 app (expo-router, TypeScript strict, `react-native-svg` charts). The web export is a PWA that
the API serves at `/`; the same code ships as an Android APK (EAS) and runs on iOS through Expo Go / EAS Update.
Source of truth for the API: `docs/CONTRACT.md` and `apps/api/app/models.py` (mirrored in `src/types.ts`).

## Run

```bash
cd apps/mobile
npm install
EXPO_PUBLIC_MOCK=1 npx expo start --web     # offline development against the in-memory fake API
EXPO_PUBLIC_API_URL=http://localhost:8000 npx expo start --web   # against a local API (dev only)
```

| Command | What it does |
|---|---|
| `npx tsc --noEmit` | type check (strict) |
| `npx expo export --platform web` | production web build into `dist/` (the API serves it: `WEB_DIST=../mobile/dist`) |
| `EXPO_PUBLIC_MOCK=1 npx expo export --platform web --clear` | same, but bakes in the fake API (screenshots, demos without a server) |
| `npm run gen:assets` | regenerates app icons and the PWA manifest from `scripts/gen-assets.mjs` |

## Configuration

| Variable | Where | Meaning |
|---|---|---|
| `EXPO_PUBLIC_API_URL` | native builds (set per profile in `eas.json`) | API origin. On web the app always uses the same origin (`''`); in `expo start --web` dev it may override. |
| `EXPO_PUBLIC_MOCK=1` | any build | use the in-memory fake API (`src/mock.ts`) |
| `EXPO_PUBLIC_MOCK_AI=1` | mock only | fake reports `ai_used: true` instead of template mode |
| `APP_NAME` / `EXPO_PUBLIC_APP_NAME` | build | display name (default "Pulse") |
| `EAS_PROJECT_ID` | EAS | enables `expo-updates` (`updates.url`, `extra.eas.projectId`); omitted when unset |

**Gotcha:** Metro's transform cache does not include `EXPO_PUBLIC_*` values, so after switching `EXPO_PUBLIC_MOCK` on or
off (or changing `EXPO_PUBLIC_API_URL`) export with `--clear`, otherwise you may get the previous build's setting.

The offline-demo fallback: if "Start my demo" cannot reach the server, onboarding offers **Use the offline demo**,
which switches the client to the same in-memory fake at runtime.

## Team workspace links (web)

`https://<host>/?token=<workspace token>` opens that existing workspace instead of a fresh guest one: the token replaces
any stored session token, is persisted, and is removed from the address bar. An unknown token lands on onboarding with an
explanation. The workspace name is shown above every screen title.

## Optional server features

Insights ("What's working" on the dashboard), real-stats harvest (profile links in Settings > Connectors, "Real data"
badges) and billing (Pulse Pro card in Settings) are optional: the client asks `/openapi.json` whether the server has the
endpoint and hides the UI when it does not (no 404s in the console). `src/normalize.ts` adapts the insights and harvest
JSON (shapes provisional until their models land in `apps/api/app/models.py`). The mock implements all of them.

## Channels and labels

Channel order everywhere: LinkedIn, Instagram, TikTok, X, Reddit, Facebook (`PLATFORMS`); LinkedIn and Instagram are
preselected on Create. The last funnel stage ("conversions" in the API) is labelled **Onboard** (`STAGE_LABEL`).

## Test ids

`tab-<dashboard|trends|create|queue|settings>`, `platform-<id>` (Create chips), `filter-platform-<id>` (dashboard filter),
`post-card`, `trend-item`, `kpi-real-clicks`, `workspace-name`.

## Layout

```
app/                expo-router routes: onboarding, (tabs)/{dashboard,trends,create,queue,settings}, +html (PWA shell)
src/api.ts          the one import for data: `api`, types, session helpers; routes to realApi or mock
src/types.ts        API types mirroring models.py, `PulseApi` (one method per REST route)
src/http.ts         base URL, bearer token persistence (AsyncStorage), 401 handling, fetch wrapper
src/realApi.ts      HTTP client            src/mock.ts   in-memory fake with simulated audience growth
src/session.tsx     guest workspace session (boot, start, offline demo, reset)
src/hooks.ts        useAsync: loading + 5 s focus-aware polling
src/ui/             design-system primitives (Screen, Card, Button, Chip, TextField, Toast, ...)
src/charts/         Donut, Funnel, AreaChart, Sparkline (react-native-svg)
src/components/     screen building blocks (dashboard, create, queue, settings, previews, ...)
public/             PWA manifest + icons (copied into dist/)
```

## Builds

`eas build -p android --profile preview` produces an installable APK (`eas.json`: `preview` is `buildType: apk`,
internal distribution). Other profiles: `ios-sim` (iOS simulator build), `production`. Android package and iOS bundle id are
`com.pulsehackathon.app`. `EXPO_PUBLIC_API_URL` is set per profile to `https://pulse-hackathon.fly.dev` (native builds
also default to it when unset). Only Expo SDK 57 modules are used, so the app runs in Expo Go.
Note: SDK 57.0.33 recommends `react-native@0.86.3`; the repo pins `0.86.2` per docs/CONTRACT.md.

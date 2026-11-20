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
| `EXPO_PUBLIC_MOCK=1 npx expo export --platform web` | same, but bakes in the fake API (screenshots, demos without a server) |
| `npm run gen:assets` | regenerates app icons and the PWA manifest from `scripts/gen-assets.mjs` |

## Configuration

| Variable | Where | Meaning |
|---|---|---|
| `EXPO_PUBLIC_API_URL` | native builds (set per profile in `eas.json`) | API origin. On web the app always uses the same origin (`''`); in `expo start --web` dev it may override. |
| `EXPO_PUBLIC_MOCK=1` | any build | use the in-memory fake API (`src/mock.ts`) |
| `EXPO_PUBLIC_MOCK_AI=1` | mock only | fake reports `ai_used: true` instead of template mode |
| `APP_NAME` / `EXPO_PUBLIC_APP_NAME` | build | display name (default "Pulse") |
| `EAS_PROJECT_ID` | EAS | enables `expo-updates` (`updates.url`, `extra.eas.projectId`); omitted when unset |

The offline-demo fallback: if "Start my demo" cannot reach the server, onboarding offers **Use the offline demo**,
which switches the client to the same in-memory fake at runtime.

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

`eas.json` profiles: `preview` (Android APK, internal), `ios-sim` (iOS simulator build), `production`.
`EXPO_PUBLIC_API_URL` is set per profile to the placeholder `https://pulse-hackathon.fly.dev`.

## Desktop layout, rooms, share (wide >= 1024 px)

- **Wide board.** `src/layout` (`useWide()`, `Grid`, `Col`) switches every tab to a desktop board at >= 1024 px and a
  left sidebar replaces the bottom tab bar (tab testIDs `tab-dashboard|trends|create|queue|settings` on both). Below
  1024 px the phone layout is untouched. Dashboard = whiteboard (header + KPIs + Real people | Outside trends; donut +
  funnel + 30-day chart | Generate column; connectors; Themes (Jev AI); top posts + live activity), Create = form left
  and preview cards right, Queue = three status columns, Trends = 3-column grid, Settings = 2-column grid.
- **Post it for real.** `src/components/share`: `share-<platform>` buttons on every Create and Queue card call
  `GET /api/posts/{id}/share` (falls back to `src/shareLinks.ts` when that answers 404) and open the composer in a new
  tab; Instagram/TikTok copy the caption. The post is marked published afterwards.
- **Rooms.** `start-room` (`POST /api/rooms`) opens `screen_url?token=<session token>` and shows the join link.
  `/?room=<code>` (web) and `pulse://?room=<code>` create a guest workspace ("My brand") with no form and show the
  `room-welcome` banner; `install-banner` offers the Android APK or the iPhone "Add to Home Screen" hint (web only).
- **Insights.** The Themes (Jev AI) card reads `GET /api/insights` (`docs/LEARNING.md`).
- **Web budget.** See `docs/PERF.md`: first screen JS ~1.29 MB (new visitor) / ~1.45 MB (dashboard), raw.
- **Layout check.** `EXPO_PUBLIC_MOCK=1 npx expo export --platform web --clear --output-dir dist-mock`, then
  `cd e2e && npx playwright test -c playwright.layout.config.ts` (1440x900 and 390x844, every tab: screenshots, no
  horizontal overflow, no console errors). Use `--clear` whenever you switch between mock and real exports (Metro's
  cache ignores `EXPO_PUBLIC_*` changes).

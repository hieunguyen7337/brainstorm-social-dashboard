# Web first-load performance (owner: unit p)

Goal: slow-network first load with no waterfalls, skeletons, and under 1.5 MB of JS for the first screen. The API
serves the export without compression, so the budget is judged on **raw bytes**.

## Where we are (real, non-mock export, `apps/mobile`)

| | before | after |
|---|---|---|
| JS for the onboarding screen (new visitor) | 1.96 MB (one entry, 537 KB gz) | **1.35 MB** (365 KB gz) |
| JS for the dashboard (returning visitor) | 1.96 MB | **1.50 MB** (408 KB gz) |
| Icon fonts fetched on first load | Ionicons 390 KB (after JS ran) | Ionicons subset 34 KB (21 KB gz), started by the shell |
| Brand font (FA6) when a platform badge renders | 209 KB | 8 KB |
| Reddit preview font (MaterialCommunityIcons) | 1.3 MB | 11 KB |
| Bytes in `dist/` (without maps) | 4.4 MB | 1.8 MB |

Chromium, cold cache, 1.6 Mbps / 150 ms RTT, new visitor: first contentful paint 10.2 s -> 7.4 s raw (3.1 s -> 2.5 s if
the API gzips), icons visible 12.3 s -> 7.7 s. With the splash in `public/index.html` (below) first paint is **0.18 s**.
The floor of the first screen is the entry chunk (1.09 MB: react-dom 179 KB, react-native-web 307 KB, expo-router +
react-navigation 436 KB). Only compression gets that below ~5 s on this link.

## What was changed

- `app.config.ts`: `asyncRoutes` for web production builds, so each route is its own chunk (`expo start` and native
  builds are unchanged). `PULSE_WEB_OUTPUT=static` switches the web output (see "Options").
- `metro.config.js`: in production **web** builds the three icon families (Ionicons, FontAwesome6, MaterialCommunity)
  are replaced by copies holding only the icons the source mentions: glyph maps pruned (-290 KB JS) and the .ttf files
  subset (the same outlines, pixel-identical in Chromium, valid per fontTools). The subsetter is a small built-in
  TrueType writer; any failure keeps the full files. Generated into `node_modules/pulse-icon-subsets/`.
- `app/_layout.tsx`: starts the icon font as soon as the shell mounts (never awaited, nothing waits for it), starts the
  dashboard chunk straight away for returning visitors (saved token), ships `index` and `onboarding` with the shell
  (layout -> index -> onboarding was three sequential requests after the entry, now one), and after the first screen
  is up prefetches the next route chunks one at a time
  when the browser is idle (skipped on Save-Data/2G), so a first tab tap never shows an empty page.
- `src/ui/Logo.tsx`: plain `<svg>` on web, so the first screen no longer pulls react-native-svg (50 KB) into the shared
  chunk. Native still uses react-native-svg.

## Rules that keep it small

- Icon names must be string literals (`name="sparkles"`, tables like `icon: 'logo-x'`). A name built at runtime
  (template literal, `as IconName` cast, `glyphMap`) makes the build print `icon names may be built at runtime` and
  fall back to the full fonts: +290 KB JS, +2 MB of fonts. Use only Ionicons, FontAwesome6 (brand/solid/regular) and
  MaterialCommunityIcons; other families are not optimised. Opt out for a build: `PULSE_ICON_SUBSET=0`.
- Anything imported by two or more routes lands in the shared chunk that every first load downloads: keep heavy shared
  modules (the mock, previews, charts) out of it.
- Build `EXPO_PUBLIC_MOCK=1` and real exports with different `TMPDIR`s (or `--clear`): Metro's shared cache in
  `/tmp/metro-cache` can leave the mock flag inlined in a real build. Docker builds are clean.

## Recommendations for files not owned by this unit

1. `apps/api/app/main.py` (lead): compress and cache. Tested against this export: the entry is served `gzip` and the
   first-screen JS drops from 1.35 MB to 365 KB (first paint 7.4 s -> 2.5 s on the slow link).
   ```python
   from fastapi.middleware.gzip import GZipMiddleware
   app.add_middleware(GZipMiddleware, minimum_size=1024)           # in create_app(), before _mount_web(app)

   @app.middleware("http")                                          # hashed files never change
   async def cache_headers(request, call_next):
       resp = await call_next(request)
       p = request.url.path
       if p.startswith(("/_expo/static/", "/assets/")):
           resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
       elif not p.startswith(("/api/", "/mcp", "/r/", "/l/")):
           resp.headers.setdefault("Cache-Control", "no-cache")
       return resp
   ```
2. `apps/mobile/public/index.html` (not in unit p's files; `app/+html.tsx` is ignored while `web.output` is `single`):
   paint a splash before any JS. Same geometry as `SplashView` (measured: logo, name and spinner at identical pixels,
   no layout shift). Add inside `<head>` and replace `<div id="root"></div>`:
   ```html
   <style id="boot-css">
     html, body { margin: 0; }
     #boot { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; background: #0b1020; }
     #boot .logo { width: 64px; height: 64px; border-radius: 17.92px; display: flex; align-items: center; justify-content: center;
       background-image: linear-gradient(135deg, #7c5cff, #ff5c8a); }
     #boot .name { margin-top: 12px; font-size: 20px; font-weight: 700; letter-spacing: -0.3px; color: #f4f6ff; }
     #boot .spin { margin-top: 16px; width: 20px; height: 20px; box-sizing: border-box; border-radius: 50%;
       border: 2.5px solid rgba(124, 92, 255, 0.2); border-top-color: #7c5cff; animation: boot-spin 0.9s linear infinite; }
     @keyframes boot-spin { to { transform: rotate(360deg); } }
   </style>
   ...
   <div id="root"><div id="boot" aria-hidden="true"><div class="logo"><svg width="43.52" height="43.52" viewBox="0 0 24 24"><path d="M2 12.5h4.2l2.3-5.2 3.6 11 2.7-8 1.5 2.2H22" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></div><div class="name">Pulse</div><div class="spin"></div></div></div>
   ```
   React replaces `#root`'s children on first render. Keep `APP_NAME` in sync if it is ever changed.
3. `apps/mobile/src/api.ts` (data layer): the in-memory mock (53 KB) is in the shared chunk although real builds only
   need it for the offline demo. Load it lazily (tested: mock build walks onboarding, every tab, Create and Queue with
   no errors); first-screen JS becomes 1.29 MB (onboarding) and 1.45 MB (dashboard):
   ```ts
   const loadMock = () => import('./mock');
   const lazyMockApi: PulseApi = new Proxy({} as PulseApi, {
     get: (_t, prop: string) => (...args: unknown[]) =>
       loadMock().then((m) => (m.mockApi as unknown as Record<string, (...a: unknown[]) => unknown>)[prop](...args)),
   });
   const current = (): PulseApi => (isMock() ? lazyMockApi : realApi);
   // openTrackedLink: void loadMock().then((m) => m.mockClickLink(post.link_code as string));
   ```
4. Dashboard unit: `src/charts/*` plus react-native-svg are 75 KB of the 155 KB dashboard chunk. `React.lazy` the chart
   leaves (AreaChart, Donut, Funnel, Sparkline) with a same-size placeholder to take the dashboard path to ~1.37 MB.
5. Create/Queue: `src/components/previews/*` (45 KB) are shared by two routes, so they sit in the first-load chunk.
   Lazy-load them where they render, or only from Create.

## Options

- `PULSE_WEB_OUTPUT=static npx expo export --platform web`: pre-renders every route to its own HTML (the API already
  serves `/x` from `x.html`) and uses `app/+html.tsx`. First paint without JS (0.3 s measured), route chunks listed in
  each page's HTML (no JS waterfall), CLS 0. Walked end to end in a mock build with no console errors. Needs
  `e2e/scripts/serve-dist.mjs` to try `` `${abs}.html` `` before the SPA fallback; without that, loading `/onboarding`
  directly logs React error 418 (hydration) and recovers. Tapping is dead until the entry chunk is parsed.
- Tried and not worth it: `terser passes: 2` (-0.2%), `EXPO_UNSTABLE_TREE_SHAKING` (-11 KB), `sitemap: false` (0).

## Measure

```bash
cd apps/mobile && TMPDIR=$(mktemp -d) npx expo export --platform web --source-maps --output-dir /tmp/pulse-dist
```
First-screen JS = `__expo-metro-runtime` + `__common` + `entry` + the two `_layout` chunks (+ `dashboard` for a returning
visitor); `ls -l` the files, or sum bytes per package from the `.map` files. Throttle in Chromium with
`Network.emulateNetworkConditions` (latency 150, down 200000 B/s) and serve `dist/` with an index.html fallback.

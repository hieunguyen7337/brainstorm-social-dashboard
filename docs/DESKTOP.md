# Pulse Desktop: Electron app plan (branch `electron-desktop`)

Status: **approved by the owner on 21 Nov 2026 (decisions in section 12).** Nothing is built yet. The lead folds
the "Contract changes" section into `docs/CONTRACT.md` before units start.

## 1. Goal

Ship Pulse as a desktop app (macOS first, Windows second) that adds two things the web build cannot do:

1. **Real sign-in to each social platform inside the app.** "Connect with Instagram" opens the real
   instagram.com login in an app window. The person logs in themselves. From then on Pulse can read their numbers
   and, with their confirmation, act on their account (post, edit) from that signed-in session.
2. **The person's own Claude subscription, on their machine.** Pulse embeds LocalBridge: it drives the locally
   installed, already logged-in Claude Code CLI, gives it Pulse's MCP tools plus new "social browser" tools, and
   streams the result into a chat panel. Drafting and editing posts then runs on the person's subscription, not on
   Pulse's API key.

Everything that already works (web, Android APK, screenshot fallback, MCP at `/mcp`) keeps working unchanged.

## 2. What we already have (and will reuse)

| Existing piece | Where | Reuse in desktop |
|---|---|---|
| Sign-in-and-read flow: per-platform login URLs, stats pages, injected reader scripts, parsers, a state machine with every side effect injected | `apps/mobile/src/autoRead/{platforms,readers,parse,runner,types,config}.ts` | **Directly.** The runner only needs `loadUrl`, `inject`, `capture`, `readScreenshot` and a message channel. Electron provides all four. These files have no `react-native` import and already run under plain Node. |
| Page -> app protocol | `PageMessage` via `window.ReactNativeWebView.postMessage(JSON.stringify(msg))` | A preload in the social window defines the same `window.ReactNativeWebView.postMessage` shim, so reader scripts run unmodified. |
| Instagram posting from a signed-in session (upload + configure, the same two requests instagram.com's own "Create" page makes) | `apps/mobile/src/igPost/logic.ts` (`buildIgPostScript`, behind `IG_AUTOPOST`) | Same script, injected into the Instagram partition. |
| Screenshot fallback (Claude reads an image) | `POST /api/connections/{platform}/screenshot` | Same, with `webContents.capturePage()` as `capture()`. |
| Ingest of real numbers | `POST /api/metrics/ingest`, `source: "device"` | Same. |
| Remote MCP server with the workspace token | `/mcp`, `docs/MCP.md` | Handed to the local Claude via `--mcp-config`. |
| LocalBridge: spawns `claude -p --output-format stream-json --verbose --include-partial-messages`, `--resume <session>`, streams lines, kills the child on disconnect, Host/Origin checks | `~/Workspace/GitHub/LocalBridge/server.js` (~150 lines, zero deps) | Ported into the Electron main process as a module; IPC replaces HTTP+SSE. Its fake-`claude` test approach is kept. |

Why the desktop app helps: the web build cannot read another site (`autoRead/index.web.tsx` is a stub) and,
since 21 Nov, the platforms refuse anonymous server-side requests (`docs/REAL.md`). An Electron window is a real
Chromium browser on the person's own IP with the person's own login, which is exactly the situation the Android
WebView reader was built for.

## 3. Key decision: how we "use the login"

| Option | How | Verdict |
|---|---|---|
| **A. Act inside the signed-in browser session** (recommended) | Each platform gets its own persistent Electron session partition. We inject the existing reader/poster scripts into that page; they make the same same-origin requests the site's own web app makes. Cookies never leave Chromium. | **Use this.** Reuses `autoRead`/`igPost`, same IP and fingerprint as the login, nothing secret ever crosses IPC, the network, or Claude's context. |
| B. Export cookies and call the platforms from Node or the Pulse server | `session.cookies.get()` then replay `sessionid`, `li_at`, `auth_token`... from another client | **Reject.** httpOnly session cookies are full account credentials. Replaying them from another client or IP triggers checkpoints and bans, and sending them to our server makes Pulse a credential store. We read cookie **names** only, to answer "is this person signed in?" without loading a page. |
| C. Official OAuth APIs (Meta Graph, LinkedIn, X, TikTok) | Proper OAuth apps | **Long-term right answer**, but each needs app review, a business account and days to weeks. Out of scope today. Section 11 lists it as a follow-up. |

Rules for option A:

- One partition per platform: `persist:pulse-<platform>` (e.g. `persist:pulse-instagram`). Separate from the main
  Pulse window and from each other.
- **Sign in once, then invisible.** The partition is stored on disk, so the login survives app restarts until the
  platform expires it or the person signs out. The person sees a platform window only (a) the first time, to log
  in, (b) when the platform asks for something only a human can do (checkpoint, 2FA, captcha), and (c) when they
  click "Show Instagram". All other reads and posts run in a hidden window (`show: false`) that is created for the
  task and destroyed when it ends: at most one hidden social window exists at a time, and none when idle. There
  is never a pile of open windows on the person's desktop.
- When a hidden task finds the person signed out (`signed_out` from the reader), it does not pop a window by
  itself: the connect card switches to "Sign in again" and the Claude tool returns "Instagram needs you to sign in
  again in Pulse".
- Cookie values are never read, logged, sent over IPC, sent to the Pulse API, or given to Claude. The only data
  that leaves a social window is the `PageMessage` (parsed numbers or post results) defined in `autoRead/types.ts`.
- "Sign out of Instagram in Pulse" = `session.fromPartition('persist:pulse-instagram').clearStorageData()`.
- User agent: Electron's default UA contains `Electron/<v>` and the app name, which some sites treat as an
  embedded browser. Each social session uses the default Chrome UA with those tokens stripped.
- Known risk: "Sign in with Google/Apple" on some platforms may refuse embedded browsers. The person can use the
  platform's own email/password login instead. Screenshot upload stays as the fallback.

## 4. Architecture

```
┌──────────────────────────── Pulse Desktop (Electron) ────────────────────────────┐
│                                                                                  │
│  Main window (renderer)                Social windows (one partition each)       │
│  Pulse web app (Expo export)           instagram.com / linkedin.com / x.com ...  │
│  + Assistant chat panel                preload: ReactNativeWebView.postMessage   │
│        │  window.pulseDesktop (preload,          shim only                       │
│        │  contextBridge, narrow API)               ▲  inject reader/poster       │
│        ▼                                           │  scripts                    │
│  ┌──────────────────────── Main process ───────────┴─────────────────────────┐   │
│  │ ipc.ts          validated IPC handlers (origin-checked)                   │   │
│  │ social/         sessions, window manager, runner adapter (autoRead)       │   │
│  │ claude/         LocalBridge port: spawn `claude -p ...`, stream, resume   │   │
│  │ mcp/            local MCP server (127.0.0.1, random port + token):        │   │
│  │                 social_* tools that drive the social windows              │   │
│  └───────────────────────────────┬───────────────────────────────────────────┘   │
└──────────────────────────────────┼───────────────────────────────────────────────┘
                                   │ spawn (stdio)
                                   ▼
                    Local `claude` CLI (the person's subscription)
                      --mcp-config: pulse (remote /mcp, Bearer token)
                                    pulse_desktop (local MCP, Bearer token)
                                   │
                                   ▼ HTTPS
                    Pulse API on Fly (/api/*, /mcp), unchanged
```

### 4.1 Main window: what it loads

**Owner decision: bundle the web export inside the app.** `npx expo export --platform web` output is copied into
the app and served from a privileged custom protocol `app://pulse/` (`protocol.handle`, SPA fallback to
`index.html`). The app starts without the network and the UI version is pinned to the app build.

- API base: on web `apiBase()` (`src/http.ts`) returns `''` (same origin), which would point at `app://pulse`. It
  gains one branch: when `window.pulseDesktop` exists, use `window.pulseDesktop.apiUrl` (the Fly URL, from the
  desktop's `PULSE_API_URL` config). `publicBaseUrl()` follows it, so the MCP URL shown in Settings stays right.
- CORS: the API already sends `allow_origins=["*"]` (`app/main.py`), and Pulse auth is a Bearer header, not a
  cookie, so `app://pulse` needs no API change.
- The preload only exposes `window.pulseDesktop` to the main frame, and every IPC handler checks that
  `event.senderFrame.url` starts with `app://pulse/`. Any other navigation in the main window opens the system
  browser (`shell.openExternal`) instead.
- Tracked links (`/r/<code>`), room pages and the MCP URL stay on the Fly host, unchanged.

### 4.2 Renderer integration (the Pulse app itself)

Detect the desktop at runtime: `typeof window !== 'undefined' && window.pulseDesktop?.version`. On web without it,
behaviour is unchanged.

- `src/autoRead/index.web.tsx`: `autoReadAvailable()` returns `true` when `window.pulseDesktop` exists, and
  `AutoReadSheet` calls `pulseDesktop.social.connect(platform)` and resolves to the same `onResult` / `onClose`
  contract. `forgetSignIns()` calls `pulseDesktop.social.signOut()`.
- Connect cards (`components/connect/PlatformCard.tsx`, `ConnectAccounts.tsx`), owner decision: on desktop the
  card's action is a **"Connect with <Platform>" button that opens the platform's login window**, not a screenshot
  upload. The screenshot upload is shown only after a connect has failed (as the fallback link in the failure note).
  A connected card's "Update" re-reads in the hidden window; a "Show <Platform>" link opens the signed-in site.
- New `src/desktop/` (types for `window.pulseDesktop`, a hook `useDesktop()`).
- New Assistant panel (desktop only): a chat screen/drawer that streams Claude's output (text deltas, tool calls,
  sub-agents, results), modelled on LocalBridge's `public/index.html` renderer. Shows a "Claude not found / not
  signed in" state with the one command to fix it.
- Create / Queue screens get an "Edit with Claude" action that opens the panel prefilled with the post id.

### 4.3 `window.pulseDesktop` API (preload, contextBridge)

```ts
interface PulseDesktop {
  version: string;
  apiUrl: string;                                           // Fly API base for the bundled renderer
  social: {
    status(): Promise<Record<Platform, { signedIn: boolean; lastReadAt: string | null }>>;
    connect(platform: Platform): Promise<{ ok: true; read: DeviceRead } | { ok: false; reason?: string }>;
                                                            // first time: visible login window; later: hidden read
    openWindow(platform: Platform): Promise<void>;          // "Show Instagram": the signed-in site, visible
    signOut(platform?: Platform): Promise<void>;
  };
  claude: {
    status(): Promise<{ installed: boolean; version?: string; loggedIn: boolean; account?: string }>;
    run(req: { prompt: string; sessionId?: string; postId?: string }): Promise<{ runId: string }>;
    onEvent(runId: string, cb: (e: ClaudeEvent) => void): () => void;  // stream-json lines, stderr, done
    stop(runId: string): Promise<void>;
  };
}
```

No method takes a URL, a script, a file path or a shell argument from the renderer. The renderer picks a platform
and a prompt; the main process decides everything else.

### 4.4 Social module (`apps/desktop/src/main/social/`)

- `sessions.ts`: partition per platform, UA fix, `signedIn(platform)` by cookie **name** presence
  (`sessionid` on instagram.com, `li_at` on linkedin.com, `auth_token` on x.com, `sessionid` on tiktok.com,
  `c_user` on facebook.com, `reddit_session` on reddit.com), `signOut()`.
- `window.ts`: a task queue that runs one social task at a time in one `BrowserWindow` (`contextIsolation: true`,
  `sandbox: true`, `nodeIntegration: false`, preload = postMessage shim only). Visible for login, checkpoints and
  "Show Instagram"; hidden (`show: false`) for everything else, and destroyed when its task ends.
  `setWindowOpenHandler` keeps popups (OAuth) inside the same partition. Background refresh (hourly, like
  `REFRESH_STALE_MS` on Android) runs through the same queue.
- `runner.ts`: builds `RunnerDeps` for the existing `autoRead/runner.ts`:
  `loadUrl` -> `webContents.loadURL`, `inject` -> `webContents.executeJavaScript`, `capture` ->
  `webContents.capturePage()` resized to `CAPTURE_MAX_WIDTH` JPEG, `readScreenshot` -> renderer-free HTTPS call to
  `/api/connections/{platform}/screenshot` with the workspace token, page messages from the shim via IPC (accepted
  only from that platform's window, `pulse === 'autoRead'`). The runner's results go back to the renderer, and the
  renderer saves with `POST /api/metrics/ingest` exactly as today.
- `post.ts`: v1 is **Instagram only**, via `buildIgPostScript` (photo upload + configure with caption) in a
  hidden window. The confirmation happens once, in Pulse (4.6); the poster then publishes directly, with no second
  confirmation on instagram.com. Other platforms in v1: Pulse's existing share links / composer (`src/shareLinks.ts`).
  LinkedIn and X posters are phase 2.
- Pace and limits: reuse `autoRead/config.ts` timeouts; at most one read per platform per `REFRESH_STALE_MS`; at
  most N posts per platform per day (config, default 5).

Sharing `autoRead` code: `apps/desktop` imports the pure files from `apps/mobile/src/autoRead` through a
TypeScript path alias and bundles them with esbuild. No copy, so the Android and desktop readers stay in sync. The
desktop must not import any file that imports `react-native`.

### 4.5 Claude module: LocalBridge inside the app (`apps/desktop/src/main/claude/`)

Port of LocalBridge `server.js` `handleRun`, with HTTP/SSE swapped for IPC:

```
claude -p <prompt>
  --output-format stream-json --verbose --include-partial-messages
  [--resume <sessionId>]
  --mcp-config <app-data>/mcp.json --strict-mcp-config
  --tools ""                                   # no built-in Bash/Edit/Write/Read/WebFetch
  --allowedTools "mcp__pulse__*" "mcp__pulse_desktop__*"
  --setting-sources ""                         # ignore the person's project/user CLAUDE.md and hooks (verify)
  --append-system-prompt <Pulse brand/voice + rules for using the tools>
cwd: <app-data>/claude-workdir   (an empty folder, never the person's projects)
```

- Binary: `CLAUDE_BIN` env, else `claude` on `PATH`, else common install paths (`~/.claude/local/claude`,
  `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`). Electron apps launched from Finder do not inherit the
  shell `PATH`, so resolve it once from the login shell (`$SHELL -ilc 'command -v claude'`).
- Status (owner decision: rely on the person's own Claude Code login, with clear prompts when it is missing):
  checked at launch and before each run with `claude --version` and `claude auth status --json`. The Assistant
  panel shows one of three states, each with a copy button and a "Check again" button:
  - not found: "Install Claude Code" + the install command, and "Already installed? Choose the claude binary"
    (saved as `CLAUDE_BIN`);
  - found but signed out: "Sign in to Claude" + `claude auth login` (or a button that opens Terminal with it);
  - version too old: "Update Claude Code" + the update command.
  The rest of Pulse (dashboard, Instagram read and post from the app's own buttons) works without Claude.
- Streaming: same line splitter as LocalBridge; each stdout line is forwarded as a parsed JSON event, stderr as
  `stderr` events, then `done {code}`. Stop = `SIGTERM` the child (and on window close / app quit).
- One run at a time per window; session id kept per conversation for `--resume`.
- `mcp.json` is written per launch with mode `0600` and deleted on quit:
  ```json
  { "mcpServers": {
      "pulse":         { "type": "http", "url": "https://<host>/mcp",
                         "headers": { "Authorization": "Bearer <workspace token>" } },
      "pulse_desktop": { "type": "http", "url": "http://127.0.0.1:<port>/mcp",
                         "headers": { "Authorization": "Bearer <per-launch random token>" } } } }
  ```
  The token is the workspace token the person already holds; it never appears in argv (argv is visible to other
  processes), only in this file.
- Permission prompts cannot be answered in `-p` mode, so safety is enforced in our tools (4.6), not by Claude's
  permission prompts.

### 4.6 Local MCP server `pulse_desktop` (`apps/desktop/src/main/mcp/`)

Streamable HTTP on `127.0.0.1`, random port, per-launch bearer token, LocalBridge's Host/Origin checks. Built with
`@modelcontextprotocol/sdk` + `zod`. Tools:

| Tool | Effect | Guard |
|---|---|---|
| `social_status` | Which platforms are signed in, last read time | read-only |
| `social_read_metrics(platform)` | Runs the reader in that platform's window; returns parsed numbers; the app saves them via ingest | read-only, rate-limited |
| `social_list_recent_posts(platform)` | The person's recent posts as parsed by the reader (text, counts, url) | read-only |
| `social_open_composer(platform, text)` | Shows the platform window on its composer, text on the clipboard | person finishes by hand |
| `social_publish(platform, text, image, pulse_post_id?)` | v1: `instagram` only. Publishes through the poster | **One confirmation, in Pulse**: an in-app dialog (renderer, so it carries Pulse's look) showing account, photo and exact caption. Clicking Post publishes straight to Instagram with no further step there. Nothing is sent without that click. Then marks the Pulse post published |
| `social_edit_post(platform, url, text)` | Phase 2, only where the site supports editing (LinkedIn, X Premium) | same confirm dialog |

Pulse's existing remote tools (`generate_posts`, `create_post`, `list_posts`, `list_trends`, ...) cover drafting,
so the typical run is: Claude reads trends and themes from `pulse`, drafts, the person edits in the panel, and
Claude calls `social_publish`, which asks the person.

## 5. Security and privacy rules (non-negotiable)

1. All windows: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`.
   Main-window navigation is limited to the Pulse origin; social windows can navigate anywhere (login flows) but
   scripts are injected only when the URL matches that platform's `FlowStep.matches`.
2. Cookie values, tokens and page HTML never leave the social partition. Only `PageMessage` payloads (already
   pruned, see `autoRead/types.ts`) do.
3. Claude never sees credentials: it gets parsed numbers and post text through MCP tools.
4. Every write to a social platform needs one explicit click in Pulse's confirm dialog (and only there: no second
   confirmation on the platform). No auto-publish from Claude or autopilot in desktop v1, even if autopilot is on.
5. Local MCP: loopback only, random port, random token, Host/Origin check. `mcp.json` 0600, deleted on quit.
6. Claude runs with no built-in tools, strict MCP config and an empty cwd, so a prompt-injected trend headline
   cannot read files or run commands.
7. Respect the platforms: own account only, human pace, read limits from `docs/HARVEST.md`, never like, follow,
   comment or message.
8. No secrets in the repo; packaging never embeds a token or API key.

## 6. Project layout

```
apps/desktop/
  package.json            electron, electron-builder, esbuild, typescript, @modelcontextprotocol/sdk, zod
  tsconfig.json           strict; path alias @autoRead/* -> ../mobile/src/autoRead/*
  electron-builder.yml    mac dmg (arm64 + x64), win nsis; appId com.pulse.desktop
  scripts/build.mjs       esbuild main + preloads -> dist/
  src/main/index.ts       app lifecycle, main window, single-instance lock
  src/main/config.ts      PULSE_URL, CLAUDE_BIN, limits
  src/main/ipc.ts         handlers + sender-origin checks + input validation
  src/main/social/{sessions,window,runner,post}.ts
  src/main/claude/{bridge,locate,status}.ts
  src/main/mcp/{server,tools}.ts
  src/preload/app.ts      window.pulseDesktop
  src/preload/social.ts   ReactNativeWebView.postMessage shim
  test/                   node:test (fake claude binary, fake webContents)
apps/mobile/src/desktop/  types + useDesktop()
apps/mobile/src/autoRead/index.web.tsx      desktop-aware (bridges to window.pulseDesktop)
apps/mobile/src/components/assistant/       chat panel (desktop only)
```

## 7. Contract changes (lead only, before units start)

- `docs/CONTRACT.md`: new "Desktop" part: the `window.pulseDesktop` interface (4.3), the `pulse_desktop` MCP tools
  (4.6), and the rules in section 5.
- Ingest `source`: keep `"device"` for desktop reads (no API change). Optional later: `"desktop"` for analytics.
- API: none. CORS is already `*` and auth is a Bearer header. Mobile: `apiBase()` reads
  `window.pulseDesktop.apiUrl` when present (4.1).
- `POST /api/posts/{id}/publish` already exists; `social_publish` calls it after a successful real post so
  the Queue shows it published. If we want to store the real post URL, that is a new `Post.external_url` field
  (lead decision).

## 8. Units

Each is one implementer, no shared files. D1 blocks the rest; D2, D3 and D5 can then run in parallel; D4 needs
D2 and D3.

| Unit | Scope | Files | Done when |
|---|---|---|---|
| **D0** (lead) | Contract + `window.pulseDesktop` types | `docs/CONTRACT.md`, `apps/mobile/src/desktop/types.ts` | Approved |
| **D1** | Electron shell: bundled export on `app://pulse/`, preload stub (`version`, `apiUrl`), security flags, navigation rules, build, `npm run dev` | `apps/desktop/**` except `social/`, `claude/`, `mcp/` | App opens the bundled Pulse and talks to Fly; `tsc`, `node --test`, build pass |
| **D2** | Social sessions + one-at-a-time hidden task window + reader adapter + `social.connect/status/signOut/openWindow` IPC, Instagram | `apps/desktop/src/main/social/{sessions,window,runner}.ts`, `src/preload/social.ts`, tests | First connect shows the login once; after an app restart a read runs with no visible window (owner check on a real account); runner/queue tests with a fake webContents |
| **D3** | LocalBridge port + `claude.*` IPC + locate/status | `apps/desktop/src/main/claude/**`, tests ported from LocalBridge's `server.test.js` | Fake-`claude` tests pass; real run streams into devtools (owner check) |
| **D4** | Local MCP server + `social_*` tools + in-app confirm dialog + Instagram poster (hidden window) | `apps/desktop/src/main/mcp/**`, `src/main/social/post.ts`, tests | Claude lists `pulse_desktop` tools; publish shows the dialog; nothing posts without a click |
| **D5** | Renderer: desktop-aware `autoRead/index.web.tsx`, `apiBase()` desktop branch in `src/http.ts`, `src/desktop/useDesktop.ts`, Assistant panel with the three Claude-missing states, publish confirm dialog | those files + `components/assistant/**` | Web build unchanged without the bridge; `tsc` + `expo export` pass |
| **D6** | Packaging + README (unsigned dmg for the demo) | `electron-builder.yml`, `apps/desktop/README.md` | dmg installs and runs on a second Mac (owner check) |

Verification adds: `cd apps/desktop && npx tsc --noEmit && node --test && npm run build`, plus the existing mobile
and API checks for any shared file touched.

Hackathon cut (deadline 16:30 AEST today): D1 + D2 (Instagram read, hidden after first login) + D3 + a minimal D5
panel is the demo. D4 Instagram publish with the in-app confirm if time allows.

## 9. Testing

- Pure logic (runner, parsers, posters) keeps its existing jest tests in `apps/mobile`.
- Desktop: `node:test` with a fake `claude` script (LocalBridge's pattern) for args, streaming, resume, stop and
  spawn failure; a fake `webContents` for the runner adapter; MCP tool tests with a mocked social layer that assert
  `social_publish` never posts without confirmation.
- Smoke: Playwright `_electron.launch` opens the app and finds the dashboard (optional, `e2e/`).
- Manual, owner only (never reported as done by an agent): real logins per platform, a real publish, a real
  Claude subscription run, the dmg on another Mac, Gatekeeper behaviour.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Platforms change pages or block embedded logins (Google SSO) | Readers already fall back to screenshot + Claude; email/password login works; OAuth later |
| Account checkpoints from automated actions | Same session/IP as the login, human pace, read caps, every write confirmed by the person |
| Platform terms of service on automation | Own account only, read-mostly, person-confirmed writes; owner reviews ToS per platform |
| Claude subscription use from a third-party app | We never handle Claude credentials: the person runs their own installed CLI, logged in by them. The owner should confirm this fits Anthropic's consumer terms before distributing beyond the demo; fallback is the person's own `ANTHROPIC_API_KEY` in the CLI's env |
| Claude CLI flags change between versions | Pin a minimum version in `status()`; flags in one place (`bridge.ts`); fake-binary tests |
| Unsigned app on macOS | Demo: right-click > Open. Distribution: Apple Developer ID + notarization (owner account) |
| Prompt injection via trends or post text | No built-in tools, strict MCP, write tools gated by a human dialog |

## 11. Out of scope / later

- Official OAuth integrations (Meta Graph, LinkedIn Marketing, X API, TikTok) to replace session automation.
- Bundled offline renderer (`app://`), auto-update (electron-updater), Windows signing.
- Background autopilot that publishes for real (only after OAuth and an explicit owner decision).
- Linux build.

## 12. Owner decisions (21 Nov 2026)

1. **Windows:** sign in once; afterwards social windows stay hidden and exist only while a task runs, one at a
   time. A window appears only for the first login, a platform checkpoint, or "Show Instagram" (section 3, 4.4).
2. **Main window:** the web export is bundled in the app (`app://pulse/`), API on Fly (4.1).
3. **v1 platform:** Instagram first: it is the platform we test end to end and the only one `social_publish`
   posts to. The login button and hidden read use the same generic `autoRead` flows, so the other five platforms get
   them too (best effort, screenshot fallback after a failure); publishing for them is phase 2.
6. **Connect cards:** the connect position is a button that opens a login window; screenshot only after a failure.
4. **Confirmation:** one click in Pulse's confirm dialog publishes; no second confirmation on Instagram.
5. **Claude:** rely on the person's own Claude Code CLI login. When detection fails, the Assistant panel says
   exactly what to do (install, sign in, update) (4.5).

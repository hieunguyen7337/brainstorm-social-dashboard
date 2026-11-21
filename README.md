# Pulse

Pulse is an automated social media manager: real numbers from your own accounts, trends, AI-drafted posts, a queue
and autopilot. **The main app is Pulse Desktop** (macOS and Windows). The browser and phone apps are deprecated, see
[the end of this file](#deprecated-web-app-and-phone-apps).

## Pulse Desktop

What the desktop app adds:

- **Sign in to your social accounts inside Pulse.** "Connect with Instagram" opens the real Instagram login in its
  own window. You log in once. After that Pulse reads your numbers in the background, in a hidden window, with no
  windows left open on your screen.
- **Your own Claude subscription.** The Assistant tab runs the Claude Code that is installed and signed in on your
  computer, with Pulse's tools attached. Ask it to draft, edit or post, and it works on your Pulse workspace and your
  signed-in accounts.
- **One-click posting to Instagram.** When you or Claude want to post, Pulse shows a confirm dialog with the caption
  and a photo picker. Nothing is posted until you click Post there, and Instagram asks nothing more.

### Install

No public download page exists yet. Get an installer from the latest
[Desktop workflow run](.github/workflows/desktop.yml) (Actions tab, artifacts `pulse-desktop-mac` / `pulse-desktop-win`), or
build one yourself (below).

**macOS** (Apple Silicon: `Pulse-<version>-mac-arm64.dmg`, Intel: `Pulse-<version>-mac-x64.dmg`)

1. Open the `.dmg` and drag Pulse to Applications.
2. The app is not notarized yet, so macOS blocks the first launch. Right-click Pulse in Applications, choose
   **Open**, then **Open** again. If macOS says the app "is damaged", run this once in Terminal:
   ```sh
   xattr -cr /Applications/Pulse.app
   ```

**Windows** (`Pulse-<version>-win-x64.exe`, or `-win-arm64.exe` for ARM PCs)

1. Run the installer. It installs for your user only, and you can pick the folder.
2. The installer is not signed yet, so SmartScreen may warn. Click **More info**, then **Run anyway**.

### First run

1. **Start a workspace.** Pulse opens on onboarding. Name your brand and continue.
2. **Connect your accounts.** On each platform card press **Connect with <Platform>**. The platform's own login page
   opens in a separate window. Log in yourself (Pulse never sees your password). The window closes by itself once
   your numbers are read. Later updates (**Update** on a connected card) run hidden. If a platform has logged you
   out, the login window opens again so you can sign back in. **Show <Platform>** opens the signed-in site.
   Only if connecting fails does the card offer a screenshot upload instead. Instagram and LinkedIn are live; the
   other platforms show as "Coming soon" (see [below](#live-vs-coming-soon-platforms)).
3. **Set up Claude (optional, for the Assistant).** Pulse uses your own Claude Code, so you need:
   ```sh
   npm install -g @anthropic-ai/claude-code   # or the native installer from claude.com/claude-code
   claude auth login                          # sign in with your Claude account
   ```
   The Assistant tab checks this for you. It says exactly what is missing (not installed, not signed in, too old),
   with a **Check again** button and **Choose the claude program** if Pulse can't find it. Everything else in Pulse
   works without Claude.
4. **Ask the Assistant**, for example "Read my Instagram numbers" or "Draft an Instagram post about today's top
   trend". To post, Claude asks Pulse, and Pulse shows you the confirm dialog: check the caption, pick a photo, then
   **Post to Instagram** or **Cancel**.

### Privacy and safety

- Each platform's login is stored in its own browser profile on your computer. Cookies and passwords never leave
  it: not to Pulse's server, not to Claude. Only the numbers Pulse reads are saved to your workspace.
- Claude runs with no file, shell or web tools, in an empty folder, with only Pulse's tools. It can't read your files.
- Every real post needs your click in Pulse's confirm dialog. At most 5 posts a day, one at a time.
- Signing out of your Pulse workspace (Settings) also clears every stored platform login on this computer.

### Build from source

Needs Node 24 or newer and npm. On Windows use PowerShell or Command Prompt, with the same commands.

```sh
cd apps/mobile && npm install          # the app UI (bundled into the desktop app)
cd ../desktop && npm install
npm run renderer                       # exports the UI into apps/desktop/renderer (takes a few minutes)
npm run dev                            # build and start Pulse Desktop
```

Installers (written to `apps/desktop/release/`):

```sh
npm run dist:mac    # .dmg + .zip, Apple Silicon and Intel
npm run dist:win    # NSIS installers, x64 and arm64 (builds on macOS too, no Wine needed)
npm run dist        # both
```

Checks: `npm run typecheck && npm test && npm run build` in `apps/desktop`, and
`npx tsc --noEmit && npx jest --ci` in `apps/mobile`.

Settings (environment variables):

| Variable | Default | Meaning |
|---|---|---|
| `PULSE_API_URL` | `https://pulse-hackathon.fly.dev` | The Pulse API the desktop app talks to |
| `CLAUDE_BIN` | found automatically | Full path of the `claude` program, if Pulse can't find it |

More detail: [apps/desktop/README.md](apps/desktop/README.md) (packaging, signing, internals) and
[docs/DESKTOP.md](docs/DESKTOP.md) (design and rules).

## Live vs "coming soon" platforms

Only Instagram and LinkedIn are live (2026-11-21). X, TikTok, Facebook and Reddit show as "Coming soon" in the app and
the API refuses them (`422 "X is coming soon to Pulse"`). To flip a platform live, move its name from
`UPCOMING_PLATFORMS` to `LIVE_PLATFORMS` in `apps/api/app/platforms.py` and in `apps/mobile/src/platforms.ts` (one line
each). `GET /api/connections` rows gain `availability: "live" | "upcoming"` (additive; old clients ignore it).

## Repository layout

| Path | What it is |
|---|---|
| `apps/desktop` | Pulse Desktop (Electron): windows, social sign-in, Claude bridge, local MCP tools, packaging |
| `apps/mobile` | The Pulse UI (Expo, TypeScript). Bundled into the desktop app; also the deprecated web and phone builds |
| `apps/api` | The Pulse API (FastAPI, SQLite) on Fly.io, used by every client, plus the remote MCP server at `/mcp` |
| `docs/` | `CONTRACT.md` (source of truth), `DESKTOP.md`, `REAL.md`, `MCP.md`, `HARVEST.md`, `DEPLOY.md`, ... |
| `e2e/`, `tools/harvest` | Playwright checks; the stand-alone harvest script |

The API is not deprecated: the desktop app uses it. Deploying it is owner-only, see [docs/DEPLOY.md](docs/DEPLOY.md).
Running it locally:

```sh
cd apps/api
pip install -r requirements.txt -r requirements-dev.txt
uvicorn app.main:app --reload                       # http://localhost:8000
ANTHROPIC_API_KEY= python -m pytest -q && ruff check app tests
```

Point the desktop app at it with `PULSE_API_URL=http://localhost:8000 npm run dev`.

---

## Deprecated: web app and phone apps

> **Deprecated.** The browser version and the Android/iOS builds still work and stay online for existing users,
> but new features go into Pulse Desktop only. In the browser, Pulse can't sign in to your social accounts for you,
> so you upload screenshots instead; the desktop app reads your numbers directly.

- **Web:** https://pulse-hackathon.fly.dev (the API serves the web export at `/`).
- **Android:** an APK built with EAS (`apps/mobile/eas.json`, profile `preview`), downloadable from `/download/android`
  on the API.
- **iOS:** Expo Go / EAS Update.
- **Claude on the web:** add Pulse's remote MCP server to Claude Code, Claude Desktop or claude.ai with your workspace
  token, see [docs/MCP.md](docs/MCP.md). Real numbers in the browser come from screenshots
  ([docs/REAL.md](docs/REAL.md)) or the harvest script / Claude in Chrome ([docs/HARVEST.md](docs/HARVEST.md)).

Run the web app locally:

```sh
cd apps/mobile
npm install
EXPO_PUBLIC_MOCK=1 npx expo start --web                         # offline, against the in-memory fake API
EXPO_PUBLIC_API_URL=http://localhost:8000 npx expo start --web  # against a local API (dev only)
npx expo export --platform web                                  # production build into dist/ (served by the API)
```

Details: [apps/mobile/README.md](apps/mobile/README.md).

Project history: raw inputs from the 2026-11-20 brainstorm are in `audio/brainstorm.m4a` and `audio/whiteboard.jpg`.

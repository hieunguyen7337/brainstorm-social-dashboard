# Pulse Desktop

Electron shell for Pulse (plan: `docs/DESKTOP.md`). Serves the bundled web export from `app://pulse/` and exposes
`window.pulseDesktop` (contract: `apps/mobile/src/desktop/types.ts`).

## Prerequisites

Node 24+ (tests rely on native TypeScript stripping), npm, and `npm install` done in `apps/mobile` (the renderer
step runs its Expo export).

## Run

```sh
npm install
npm run renderer   # exports the Pulse web app into apps/desktop/renderer
npm run dev        # bundles main + preloads into dist/, then starts Electron
```

Other scripts: `npm run build`, `npm run typecheck`, `npm test`.

## Environment

- `PULSE_API_URL`: API base for the app (default `https://pulse-hackathon.fly.dev`).
- `CLAUDE_BIN`: path of the `claude` binary (used by the Claude module).

## Claude

The Assistant runs the person's own Claude Code (`claude -p`, streamed over IPC; `src/main/claude/`). The binary is
found from `CLAUDE_BIN`, then the choice saved in `userData/settings.json`, then the login shell
(`$SHELL -ilc 'command -v claude'`), then `~/.claude/local/claude`, `/opt/homebrew/bin/claude` and
`/usr/local/bin/claude`. Each run uses an empty cwd (`userData/claude-workdir`), no built-in tools, a strict MCP config
(`userData/mcp.json`, mode 0600, deleted on quit; the workspace token lives only there, never in argv) and one run at
a time. `setDesktopMcp({ url, token })` (exported from `src/main/claude`) registers the local `pulse_desktop` server.
Minimum Claude Code version: `MIN_VERSION` in `src/main/claude/status.ts`.

## Social sign-in

`src/main/social/` signs the person in to each platform inside the app and reads their numbers with the shared
`apps/mobile/src/autoRead` flow (imported through the `@/` alias, so Android and desktop stay in sync).

- Each platform has a persistent session partition `persist:pulse-<platform>`, so the login survives restarts. The UA
  has the `Electron/x` and app-name tokens removed. Signed in = a session cookie exists, checked by cookie name only
  (`sessions.ts`); values are never read. Sign-out clears that partition's storage (`socialSignOut`).
- At most one social window exists at a time (`window.ts` queue); it is created for the task and destroyed when the
  task ends. It is visible only for a first login or signed-out session during an interactive connect, a
  checkpoint/2FA, or "Show <Platform>". A background `read()` that finds the person signed out shows nothing and
  returns `{ ok: false, reason: 'signed_out' }`.
- Only the reader's `PageMessage` crosses IPC (`pulse:social:pageMessage`), accepted only from the running task's own
  window (`messages.ts`). The screenshot fallback calls the Pulse API from the main process with the workspace token.
- Hidden windows use `show: false` and `backgroundThrottling: false`; `capturePage()` renders a hidden page by
  default, and an empty capture is retried once with the window shown off-screen (`electron.ts`).
- For other modules (the Instagram poster): `getSocial()` from `src/main/social/service.ts` gives `status`, `connect`,
  `read`, `openWindow`, `signOut`, `runTask(platform, { url, visible? }, task)` and `onPageMessage(wc, cb)`; the
  result reasons are documented at the top of that file.
- Not built: the hourly background refresh (the app re-reads on "Update"; `read()` is ready for it).

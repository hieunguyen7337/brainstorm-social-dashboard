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

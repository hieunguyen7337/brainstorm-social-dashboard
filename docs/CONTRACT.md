# Pulse: contract (the single source of truth for every unit)

Pulse is an automated social media manager for the Tanda Hackathon 2026 (demo Sat 21 Nov, 5pm AEST).
Judges open a public link on their own phone and use it themselves, so every visitor gets their own guest
workspace, seeded with realistic data, with no sign-up.

Display name comes from `APP_NAME` (default "Pulse"); never hard-code it in UI copy beyond the config.

## Parts (from the whiteboard)
1. **Social media connectors**: LinkedIn, Instagram, X, TikTok, Reddit, Facebook. Connections are `sandbox`
   mode (simulated audience: published posts accrue views/engagement over time). `live` mode is a later stretch.
2. **Dashboard**: views share by platform (pie), sales funnel views -> engagements -> clicks -> conversions,
   daily time series, top posts, live activity feed.
3. **Outside trends**: real, public trend feeds (Hacker News, Reddit r/popular, Google Trends daily AU RSS),
   cached, ranked for the workspace's brand.
4. **Generate**: Claude writes one variant per platform from a theme and/or a trend, respecting each platform's
   format. Each variant carries a tracked link `/r/<code>`; real clicks and conversions on that link feed the funnel.
5. **Themes**: content pillars (name, description, colour) that steer generation.
6. **Autopilot**: a background loop that every N minutes picks a trend + theme, drafts posts and either queues
   them for approval or publishes them (sandbox).
7. **MCP server** at `/mcp`: lets Claude (Desktop/Code/claude.ai) manage the workspace with tools.

## Stack (mirrors Sleep Sage)
- `apps/api`: Python 3.13, FastAPI, uvicorn, pydantic v2, stdlib `sqlite3` (file at `DATABASE_PATH`,
  default `./data/pulse.db`), `anthropic` SDK, `mcp` SDK, `httpx`. Tests: pytest + FastAPI `TestClient`.
  Lint: ruff.
- `apps/mobile`: Expo SDK 57 (`expo ~57.0.16`, `react-native 0.86.2`, `react 19.2.3`), expo-router, TypeScript,
  `react-native-svg` for charts. One codebase -> web export (served by the API at `/`), Android APK (EAS),
  iOS via Expo Go / EAS Update.
- Hosting: one Fly.io machine (Sydney) with a volume for SQLite; the API serves the web export.

## Platforms
`Platform = "linkedin" | "instagram" | "x" | "tiktok" | "reddit" | "facebook"`

## Auth
`POST /api/workspaces` creates a guest workspace and returns its `token`. Every other `/api/*` call sends
`Authorization: Bearer <token>`; `app.auth.get_workspace` is the FastAPI dependency (401 if missing/unknown).
The MCP server accepts the same token as `Authorization: Bearer` or `?token=`.

## REST API (all JSON; schemas are the pydantic models in `apps/api/app/models.py`)
| Method | Path | Body -> Response | Owner |
|---|---|---|---|
| GET | /api/health | -> `{ok, app, version}` | core (main.py) |
| POST | /api/workspaces | `WorkspaceCreate?` -> `WorkspaceWithToken` (default: the sample seed of 30 days of data, 6 connections, 4 themes, ~24 posts; `real: true` seeds no numbers; `demo: true` makes an empty demo workspace, see `docs/REAL.md`; `real` and `demo` together is 422). `data_mode` is `sample`, `real` or `demo` | U1 |
| GET | /api/workspace | -> `Workspace` | U1 |
| PATCH | /api/workspace | `WorkspacePatch` -> `Workspace` | U1 |
| POST | /api/workspace/style | `StyleLearnRequest` `{files: [{name, media_type, data_base64}] (at most 10), text}` -> `StyleLearnResult` `{style: WritingStyle, skipped: [{name, reason}]}`. One batch of the person's own writing (.txt, .md, .pdf, .docx, PNG/JPEG/WebP screenshots, pasted text; 5 MB a file, 15 MB a batch) refines the stored style with one Claude call (purpose `style`); the app sends up to 100 files as batches in turn. 409 busy, 413/415/422 bad upload, 503 AI unavailable. See "Writing style" | S1 |
| DELETE | /api/workspace/style | -> `{ok: true}` (forget the learned style) | S1 |
| GET | /api/connections | -> `list[Connection]` | U1 |
| POST | /api/connections/{platform} | `ConnectionCreate` -> `Connection` | U1 |
| POST | /api/connections/{platform}/demo | -> `DemoSignInResult` (the synthetic sign-in of a demo workspace: connects the platform and backfills synthetic numbers; 409 in any other workspace; see `docs/REAL.md`) | U1 |
| DELETE | /api/connections/{platform} | -> `Connection` (status disconnected) | U1 |
| GET | /api/dashboard?days=30&platform= | -> `DashboardSummary` | U1 |
| GET | /api/activity?limit=30 | -> `list[ActivityItem]` | U1 |
| GET | /api/posts?status=&platform=&limit= | -> `list[Post]` | U1 |
| POST | /api/posts | `PostCreate` -> `Post` | U1 |
| PATCH | /api/posts/{id} | `PostPatch` -> `Post` | U1 |
| DELETE | /api/posts/{id} | -> `{ok: true}` | U1 |
| POST | /api/posts/{id}/publish | -> `Post` (status published, sandbox) | U1 |
| GET | /r/{code} | records a click, 302 -> `/l/{code}` | U1 |
| GET | /l/{code} | HTML landing page (brand name, offer, "Get started" button) | U1 |
| POST | /api/links/{code}/convert | -> `{ok: true}` records a conversion (no auth: public) | U1 |
| GET | /api/themes | -> `list[Theme]` | U2 |
| POST | /api/themes | `ThemeCreate` -> `Theme` | U2 |
| PATCH | /api/themes/{id} | `ThemePatch` -> `Theme` | U2 |
| DELETE | /api/themes/{id} | -> `{ok: true}` | U2 |
| POST | /api/generate | `GenerateRequest` -> `GenerateResponse` (variants saved as draft posts) | U2 |
| GET | /api/ai/usage | -> `AiUsage` | U2 |
| GET | /api/autopilot | -> `AutopilotConfig` | U2 |
| PUT | /api/autopilot | `AutopilotConfig` -> `AutopilotConfig` | U2 |
| POST | /api/autopilot/run | -> `AutopilotRun` (runs one cycle now) | U2 |
| GET | /api/trends?refresh=false&limit=20 | -> `list[Trend]` (ranked for this workspace) | U3 |
| * | /mcp | MCP Streamable HTTP | U4 |
| GET | / and /* | the Expo web export from `WEB_DIST` (SPA fallback to index.html) | core |
| GET | /download/android | 302 to `ANDROID_APK_URL` | core |
| POST | /api/rooms | create a crowd room (Bearer) -> code, join and screen URLs | W4 |
| GET | /api/rooms/{code} | public room (title, posts A/B, status) | W4 |
| POST | /api/rooms/{code}/vote | `{choice: "a"\|"b"}`, one per visitor cookie | W4 |
| POST | /api/rooms/{code}/onboard | visitor tapped "Get started" | W4 |
| GET | /api/rooms/{code}/stats | scans, votes, onboarded, funnel, winner | W4 |
| POST | /api/rooms/{code}/close | owner closes; winner stored as insight | W4 |
| GET | /v/{code}, /room/{code} | phone join page, big-screen page (HTML) | W4 |
| PUT | /api/connections/{platform}/profile | set the profile URL to harvest | W2 |
| POST | /api/metrics/ingest | real stats from the harvest script or Claude in Chrome | W2 |
| GET | /api/metrics/snapshots, /api/connections/harvest-status | harvest history and status | W2 |
| POST | /api/connections/{platform}/screenshot | `{image_base64, media_type}` -> `ScreenshotRead` (Claude reads a profile or insights screenshot into numbers; saves nothing; 404/413/415/503, see `docs/REAL.md`) | R1 |

Room details, share links and a curl walkthrough: `docs/ROOM.md`. Harvesting: `docs/HARVEST.md`.

Errors: `{"detail": "..."}` with a fitting status. Timestamps are ISO-8601 UTC strings. Ids are strings.

## Database
`apps/api/app/db.py` holds the whole schema (`SCHEMA`) and `connect()`. Units add no tables; if a unit needs a
column, it says so in its report instead of editing `db.py`.

## Metrics model (U1)
- Seed: 30 days of `daily_metrics` per connected platform with platform-typical shapes (TikTok and Instagram high
  views; LinkedIn high click rate; Reddit spiky), and published posts with counters.
- Simulated audience: `app.services.metrics.tick(conn, workspace_id)` advances every sandbox-published post's
  counters by the time since its last tick (fast-decaying curve; a fresh post visibly grows within a minute, so the
  demo feels live) and adds the same increments to today's `daily_metrics` row. Called at the start of
  `/api/dashboard`, `/api/posts`, `/api/activity`.
- Real events: `/r/{code}` click and `/api/links/{code}/convert` add +1 to the post, today's `daily_metrics`
  and an `events` row (shown in the activity feed as real).

## AI (U2)
- `claude-sonnet-5-5` through the official `anthropic` SDK, structured output via
  `client.messages.parse(..., output_format=<pydantic model>)` -> `response.parsed_output`, `max_tokens` 4000,
  `output_config={"effort": "low"}`. Key from `ANTHROPIC_API_KEY` (never logged, never committed).
- Caps: `AI_WORKSPACE_LIMIT` generations per workspace (default 30), `AI_GLOBAL_CAP_USD` total (default 60),
  cost = input $2/MTok + output $10/MTok from `response.usage`, recorded in `ai_usage`.
- No key, cap reached or API error -> deterministic template fallback (`ai_used: false` in the response), so
  the demo never breaks.

## Writing style (S1)
- `Workspace.writing_style` is `WritingStyle | null`: `{summary, traits (<= 8), examples (<= 3), sources (<= 100 names),
  file_count, sample_chars, updated_at}`, stored as JSON in `workspaces.writing_style` ('' until the person uploads).
- `POST /api/workspace/style` reads one batch (<= 10 files and/or pasted text, <= 5 MB a file, <= 15 MB a batch). Text
  is pulled out on the server (.txt/.md decoded, .docx via the standard library, .pdf via pypdf, first 30 pages) and
  capped at 6,000 characters a file; screenshots go to Claude as images. One `messages.parse` call (purpose `style`,
  its own `AI_WORKSPACE_LIMIT` budget) *refines* the stored profile, so many batches build on each other. A file that
  is accepted but unreadable (a scanned PDF) is listed in `skipped`; nothing readable at all is a 422.
- Every generation prompt (`ai.build_prompt`: Generate, Autopilot, Room mode, MCP `generate_posts`) adds the profile as
  "Writing style: ... match the voice, not the topics". Files are never stored or logged.

## Engagement split (E1)
- `IngestAccount` (`POST /api/metrics/ingest`, MCP `record_metrics`) and `ScreenshotRead` gain `likes`, `comments`,
  `shares` (all optional, whole numbers, the account's totals for the same `period_days` as `engagements`). They are
  stored on the account snapshot (`metric_snapshots.likes/comments/shares`, NULL = not captured, never 0).
  `engagements` is `max(engagements given, likes + comments + shares)`, so the total never falls below its parts and
  the three alone are enough.
- `DashboardSummary.engagement_split` is `{likes, comments, shares, other, unsplit, platforms}` or null (sample
  workspace, or no platform saved a split). It comes from the same newest in-window account snapshot as that
  platform's engagements. `other` = a split platform's engagements beyond the three (saves); `unsplit` = engagements
  from platforms that only report a total (and any daily numbers above the snapshot). The five numbers always add up to
  `totals.engagements`. The Engagements tile shows the split in place of its trend line.
- Only the screenshot reader, the manual numbers form and MCP `record_metrics` fill the split today. The Instagram,
  LinkedIn, TikTok and Reddit auto-readers still save one engagements total, so those platforms count as `unsplit`.

## MCP tools (U4)
`get_dashboard`, `list_posts`, `create_post`, `publish_post`, `generate_posts`, `list_trends`, `list_themes`,
`get_ai_usage`, `set_autopilot`, `run_autopilot`. Each tool calls the REST API in-process (httpx `ASGITransport`
against the FastAPI app, forwarding the caller's token), so MCP stays decoupled from service internals.

## Config (env, `app.config.settings`)
`APP_NAME`, `DATABASE_PATH`, `WEB_DIST`, `PUBLIC_BASE_URL`, `ANTHROPIC_API_KEY`, `AI_MODEL`,
`AI_WORKSPACE_LIMIT`, `AI_GLOBAL_CAP_USD`, `ANDROID_APK_URL`, `AUTOPILOT_LOOP_SECONDS`, `TRENDS_TTL_SECONDS`.

## Desktop (Electron, `apps/desktop`; plan and rules: `docs/DESKTOP.md`)
- The app bundles the web export and serves it from `app://pulse/`; the API stays on Fly (CORS is already `*`,
  auth is Bearer). `apiBase()` uses `window.pulseDesktop.apiUrl` when the bridge exists.
- Bridge `window.pulseDesktop`, IPC channel names and the publish-confirm shapes: `apps/mobile/src/desktop/types.ts`
  (lead-owned, shared by both sides).
- Social sign-in: one persistent session partition per platform (`persist:pulse-<platform>`). The connect card's
  primary action on desktop is "Connect with <Platform>", which opens a login window the first time; later reads run
  in a hidden window, one task at a time, destroyed when done. Screenshot upload is only the fallback after a failed
  connect. Reads reuse `src/autoRead` (readers, parsers, runner) unchanged and save with ingest `source "device"`.
- Cookie values, tokens and page HTML never leave a social window; only `PageMessage` payloads do.
- Claude: the person's own Claude Code CLI (`claude -p --output-format stream-json`), with `--strict-mcp-config`,
  no built-in tools, an empty cwd, and two MCP servers: `pulse` (this API's `/mcp`) and `pulse_desktop` (loopback,
  per-launch port + token) with `social_status`, `social_read_metrics`, `social_publish` (v1 Instagram only).
- Every real post needs one click in Pulse's confirm dialog (which also picks the photo); no second confirmation on
  the platform, no auto-publish in desktop v1.

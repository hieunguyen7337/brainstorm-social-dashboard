# Brainstorm: social media dashboard

Raw inputs from the 2026-11-20 brainstorm: `audio/brainstorm.m4a` and `audio/whiteboard.jpg`.

## Live vs "coming soon" platforms

Only Instagram and LinkedIn are live (2026-11-21). X, TikTok, Facebook and Reddit show as "Coming soon" in the app and
the API refuses them (`422 "X is coming soon to Pulse"`). To flip a platform live, move its name from
`UPCOMING_PLATFORMS` to `LIVE_PLATFORMS` in `apps/api/app/platforms.py` and in `apps/mobile/src/platforms.ts` (one line
each). `GET /api/connections` rows gain `availability: "live" | "upcoming"` (additive; old clients ignore it).

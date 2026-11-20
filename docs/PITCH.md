# Pulse: how we win the Tanda Hackathon 2026

Rules (kickoff deck): theme "Bring an idea to life": something people can pick up and use, not watch. Counts: a link
judges open on their own phone, a multi-player tool the crowd can play with, works end to end. Does not count: slides,
screenshots, video, a form that saves to nowhere, something only the team can run. Link in #showcase by 4:30 pm
Saturday; 2 slides, ~2 min pitch, ~2 min play; judges try every project. Auditorium has its own network: not everyone
is on it, so test on mobile data too. US$150 key: cap requests.

## Scorecard against the five criteria

| Criterion | What judges look for | What Pulse shows | Status |
|---|---|---|---|
| Idea and imagination | Creative, useful, surprising | A social media manager that closes the loop: it reads your real stats, learns which themes turn views into onboarded users, and writes the next posts per network. The surprise: the room itself trains it (Room mode). | Room mode in build (W4) |
| Execution and craft | Core works, sensibly scoped, standout details | No sign-up guest workspace in one tap; live dashboard (views pie, funnel to Onboard); platform-native LinkedIn and Instagram cards; tracked links with real clicks; desktop board layout like the whiteboard; Android APK + iPhone home-screen web app | App polish in build (U5) |
| Interactivity | Hosted, people use it themselves | https://pulse-hackathon.fly.dev on any phone, any network (public cloud, always on, 2 CPU); every judge gets a private workspace; the whole room votes in Room mode and watches the funnel move | Live; Room mode in build |
| Technical ingenuity | Clever answers to hard problems | Jev (TypeSafe decision model) classifies posts into themes with calibrated probabilities, Claude as fallback; per-channel generation pipelines run in parallel; MCP server so Claude can run the whole dashboard; real analytics harvested from your own logged-in browser (script or Claude in Chrome), no platform API keys needed | Jev key live; W1/W2 in build |
| Presentation and demo | Clear, shows well, room excited | 2 slides + QR on screen; 2-minute play is Room mode, everyone in the room participates; funnel and winner on the big screen | Script below |

## The 2 slides

1. **"Your social media, on autopilot, that learns what actually converts."** Problem: founders post blind on six
   networks and never learn which message brings customers. Pulse: connect (real stats), see (views by platform, sales
   funnel to Onboard), generate (one prompt, a native post per network), learn (Jev sorts every post into themes; the
   winners feed the next posts). Whiteboard-to-product photo in the corner.
2. **"Try it now"**: giant QR to the room join page + the short URL; underneath: "No sign-up. Your own workspace at
   pulse-hackathon.fly.dev. Built with Claude (Sonnet + Opus), Jev by TypeSafe, MCP, Fly.io, Expo."

## Demo script (2 + 2 minutes)

- 0:00 Slide 1 (20 s): the problem in one line, the loop in one line.
- 0:20 Live on the big screen (desktop board): the team's real Sleep Sage workspace: views pie, funnel, "Real data"
  badges from harvested LinkedIn/Instagram stats; Themes (Jev AI) card with the winning theme and its lift.
- 0:50 Generate: one brief -> LinkedIn post + Instagram carousel plan + X/Threads + Reddit, written in parallel; hit
  "Post on LinkedIn": the real LinkedIn composer opens prefilled with the tracked link.
- 1:30 Claude via MCP (optional, 15 s): in Claude, "what worked this week, and draft tomorrow's posts" -> it calls Pulse.
- 1:45 Slide 2 / Room mode: "Start a room" -> giant QR. **Play (2 min):** everyone scans, picks A or B, taps Get
  started; the big screen shows scans, votes and onboards racing up the funnel. Close voting: "the room picked theme X";
  Generate again, and the new post leans toward the room's theme. End: "the link is in #showcase; it's yours to keep."

## Checklist before 4:30 pm

- [ ] Link posted in #showcase: https://pulse-hackathon.fly.dev
- [ ] Tested on the auditorium Wi-Fi and on mobile data, iPhone Safari and Android Chrome
- [ ] Room mode rehearsed with 5+ phones; big-screen page at 1920x1080
- [ ] Team workspaces (Sleep Sage, personal) harvested with real LinkedIn/Instagram stats that morning
- [ ] APK link works (`/download/android`); iPhone: "Add to Home Screen"
- [ ] AI caps checked (`/api/ai/usage`); Anthropic key budget left

# Room mode (crowd play) and share links

Room mode is the two-minute, whole-room demo. The presenter puts two AI-written posts on the projector, the
audience scans a QR code, votes A or B on their phones, and taps **Get started** on the landing page. The votes
are real events: they move the dashboard's funnel and the winning theme feeds back into generation.

## The flow

1. **Create a room** (workspace token): posts A and B become a room with a 6-character code.
2. **Big screen** `<PUBLIC_BASE_URL>/room/<CODE>?token=<token>`: shows the QR code, both posts, a live vote bar,
   the scan/vote/onboard funnel and recent votes. **Close voting** appears only with a valid token.
3. **Phones** open `<PUBLIC_BASE_URL>/v/<CODE>` (the QR target): read both posts, vote A or B (re-voting switches),
   then tap **Get started**. The page also works without JavaScript through form posts that 303 back.
4. **Close**: voting stops, the winner is fixed and stored (see below), and the screen shows the winning theme so
   the next generation can lean on it.

## Running it for the demo

1. Make sure `PUBLIC_BASE_URL` is the public address (on Fly it is set in `fly.toml`). The QR code encodes
   `<PUBLIC_BASE_URL>/v/<CODE>`, so a wrong value sends every phone to localhost.
2. Create the room with the workspace token, from the app, the MCP client or curl (walkthrough below). With no
   `post_a`/`post_b` it takes the two newest LinkedIn drafts with different themes, or generates them (Claude when
   the key and caps allow, deterministic templates otherwise). Name the posts yourself to control the pitch.
3. Open the response's `presenter_url` (`screen_url + "?token=<token>"`) on the projector. The token controls the
   whole workspace: do not screenshot or share that URL.
4. Tell the room to scan the QR or type `<PUBLIC_BASE_URL>/v/<CODE>` (codes avoid `I L O 0 1`, any case works).
5. When the votes settle, press **Close voting** (or `POST /api/rooms/<CODE>/close`).

## Endpoints

JSON unless noted. Errors are `{"detail": "..."}`. "token" means `Authorization: Bearer <workspace token>`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /api/rooms | token | create a room |
| GET | /api/rooms/{code} | public | the room and its two variants |
| POST | /api/rooms/{code}/vote | cookie | cast or change a vote |
| POST | /api/rooms/{code}/onboard | cookie | the "Get started" tap |
| GET | /api/rooms/{code}/stats | public | live numbers |
| POST | /api/rooms/{code}/close | token | close voting, return stats |
| GET | /v/{code} | public | phone page (HTML) |
| POST | /v/{code}/vote, /v/{code}/onboard | cookie | no-JS form fallbacks, answer 303 back to `/v/{code}` |
| GET | /room/{code}[?token=] | public | big screen (HTML) |
| GET | /api/posts/{id}/share | token | composer links, see "Share links" |

### POST /api/rooms

Body (all optional): `{"title": "...", "post_a": "<post id>", "post_b": "<post id>", "brief": "..."}`.
`post_a` and `post_b` come as a pair (400 if only one, or if they are the same post; 404 if not in the workspace).
`brief` steers generated drafts. Default title: "Which post would you click?".

```json
{ "id": "rm_...", "code": "K7QX2M", "title": "...", "status": "open",
  "join_url": "<PUBLIC_BASE_URL>/v/K7QX2M", "screen_url": "<PUBLIC_BASE_URL>/room/K7QX2M",
  "presenter_url": "<PUBLIC_BASE_URL>/room/K7QX2M?token=<token>",
  "post_a": "p_...", "post_b": "p_...", "posts": [ <Post>, <Post> ] }
```

### GET /api/rooms/{code}

```json
{ "code": "K7QX2M", "title": "...", "status": "open",
  "variants": [ { "choice": "a", "platform": "linkedin", "content": "<= 700 chars", "theme": "Product tips",
                  "theme_color": "#7C5CFF", "media_prompt": "..." }, { "choice": "b", ... } ] }
```

It never carries the workspace id or token. An unknown code is 404 `room not found`.

### POST /api/rooms/{code}/vote

Body `{"choice": "a"}` or `"b"` (anything else is 422). Response `{"ok": true, "choice": "a", "votes": {"a": 3, "b": 1}}`.
A closed room answers 409 `voting is closed`. The voter is the `pv` cookie (set on first contact); voting again
switches the choice, and a click is recorded on the chosen post whenever the stored choice changes (repeating the
same choice records nothing).

### POST /api/rooms/{code}/onboard

No body. `{"ok": true, "onboarded": true}`. 400 `vote first` if this voter has not voted. Idempotent: the first call
records one conversion on the voter's chosen post, later calls change nothing.

### GET /api/rooms/{code}/stats and POST /api/rooms/{code}/close

```json
{ "status": "open", "scans": 112, "votes": {"a": 51, "b": 38}, "onboarded": 20,
  "funnel": { "views": 112, "engage": 89, "click": 89, "onboard": 20 },
  "winner": { "choice": "a", "theme": "Product tips", "share": 0.573 },
  "recent": [ { "choice": "a", "at": "2026-11-21T06:58:01+00:00", "ago": 3 } ] }
```

- `funnel`: views = scans, engage and click = people who voted, onboard = "Get started" taps.
- `winner`: `{choice: null, theme: null, share: 0}` before any vote, and `{choice: null, theme: null, share: 0.5}`
  on a tie. `share` is the winner's fraction of the votes (0..1).
- `recent`: the latest votes, newest first (`ago` in seconds).
- `close` needs the token, is idempotent, and returns the same shape with `status: "closed"`.

## Data model notes

No new tables: rooms use `rooms` and `room_votes` from `app/db.py`.

- A **scan** is a `room_votes` row with `choice = ''` (created when the phone page loads, once per voter). A vote
  sets `choice` to `a` or `b` on the same row; `onboarded = 1` marks the Get started tap. Primary key is
  `(room_id, voter)`, so one phone is one voter.
- The voter id is the **`pv` cookie**: random token, `httpOnly`, `SameSite=Lax`, path `/`, 24 h. Clearing cookies
  or using a private tab makes a new voter. Cookies need the same origin as the page only; HTTPS is not required.
- **Real events**: a vote's click and an onboard's conversion go through the same helper as `GET /r/<code>` and
  `POST /api/links/<code>/convert` (`app.routes.links._record`). The post's counters, today's `daily_metrics` and a
  real `events` row all move, so the dashboard's `real_clicks` and `real_conversions` and the activity feed update
  live. Votes and their click are committed in one transaction.
- **Stats cache**: `/stats` results are cached per room for 500 ms, so a crowd polling at once shares one set of
  queries. `close` clears the cache entry.
- **What `close` writes**: the first close flips the room to `closed`; if there is a clear winner whose post has a
  theme, it (a) inserts an `insights` row for the workspace *only when none exists yet*, a one-line summary such as
  `Room vote (89 votes): the crowd preferred "Product tips" (57%) over "Behind the scenes".`, and (b) upserts a
  `post_themes` row for the winning post with `classifier = 'room'` and `confidence` = the winner's vote share.
  A tie, no votes or a theme-less winner closes the room and writes nothing else. Closing again is a no-op.

## Share links

`GET /api/posts/{id}/share` (token; 404 `post not found` if the post is not in the token's workspace; any post
status works; one SELECT, no writes) returns a prefilled composer URL per network:

```json
{ "linkedin": "https://www.linkedin.com/feed/?shareActive=true&text=<enc>",
  "x": "https://x.com/intent/post?text=<enc>",
  "threads": "https://www.threads.net/intent/post?text=<enc>",
  "reddit": "https://www.reddit.com/submit?title=<enc>&text=<enc>",
  "facebook": "https://www.facebook.com/sharer/sharer.php?u=<enc tracked link>",
  "instagram": null, "instagram_note": "copy the caption, then post the image in the app",
  "text": "<plain caption with the tracked link, for a copy button>", "link_url": "<tracked link or null>" }
```

Every value is `urllib.parse.quote(value, safe="")` encoded, so `&`, `#`, `?`, `+`, newlines, emoji and the link
itself survive (`parse_qs` gives the exact text back).

| Network | Text | Limit | Hashtags |
|---|---|---|---|
| LinkedIn, `text` | content, blank line, hashtags, blank line, tracked link | none | yes, right after the content |
| X | content with whitespace collapsed, clipped at a word with `…`, then hashtags that fit, then the link | 280 characters | only while they fit |
| Threads | the LinkedIn text; if longer, clipped the same way as X (paragraphs kept) | 500 characters | only what fits |
| Reddit | `title` = first non-empty line (<= 300, clipped at a word); `text` = the rest, then the link as the last paragraph (the link alone for a one-liner) | 300 title | none |
| Facebook | `u` = the tracked link only | | none |
| Instagram | `null` plus `instagram_note`: no web composer exists, so copy `text` and post the image in the app | | |

- Limits count raw characters (conservative: X's 23-character link rule is not used). The link is never cut: the body
  is clipped instead, and the link stays last.
- The tracked link is `link_url` (`PUBLIC_BASE_URL/r/<code>`); content that already contains it is kept as is. A post
  without a link code omits the link, and Facebook falls back to `PUBLIC_BASE_URL`.
- Hashtags come from the post's `hashtags` list, normalised to a leading `#`; empties, duplicates (any case) and tags
  already in the content are dropped.

## Load and performance

Built for about 150 phones on one Fly machine (shared-cpu-2x, 1 GB, Sydney, always on).

- SQLite runs in WAL mode with a 15 s busy timeout, so voters write while the screen reads. Every request is a handful
  of small indexed queries; a repeat scan or vote on the same choice skips the write.
- Pages are tiny: inline CSS and JS, no framework, no external assets, QR as inline SVG (memoised per URL).
- Polling: the big screen every 1 s, phones every 2 s, both paused while the tab is hidden. 150 phones at 2 s is
  about 75 requests per second, and the 500 ms stats cache keeps that to at most two stats computations a second
  per room.

## curl walkthrough

```sh
BASE=https://<your-app>.fly.dev

# 1. workspace (seeded guest workspace) and its token
TOKEN=$(curl -s -X POST $BASE/api/workspaces -H 'content-type: application/json' -d '{}' | jq -r .token)
AUTH="Authorization: Bearer $TOKEN"

# 2. create a room (drafts are reused or generated); note the code from the response
curl -s -X POST $BASE/api/rooms -H "$AUTH" -H 'content-type: application/json' -d '{"brief":"launch week"}'
CODE=<code>

# 3. two phones, two cookie jars: scan, then vote
J='content-type: application/json'
curl -s -c a.jar -b a.jar $BASE/v/$CODE -o /dev/null
curl -s -c a.jar -b a.jar -X POST $BASE/api/rooms/$CODE/vote -H "$J" -d '{"choice":"a"}'
curl -s -c b.jar -b b.jar $BASE/v/$CODE -o /dev/null
curl -s -c b.jar -b b.jar -X POST $BASE/api/rooms/$CODE/vote -H "$J" -d '{"choice":"b"}'
curl -s -c b.jar -b b.jar -X POST $BASE/api/rooms/$CODE/vote -H "$J" -d '{"choice":"a"}'   # re-vote switches: a leads 2-0

# 4. phone A taps Get started
curl -s -c a.jar -b a.jar -X POST $BASE/api/rooms/$CODE/onboard
# 5. live numbers, then close (winner is stored as insight + post theme)
curl -s $BASE/api/rooms/$CODE/stats; curl -s -X POST $BASE/api/rooms/$CODE/close -H "$AUTH"

# 6. share links for any post id (e.g. post_a from step 2)
curl -s $BASE/api/posts/<post id>/share -H "$AUTH"
```

## Troubleshooting

- **No QR code on the screen**: the QR is generated with the `segno` package (in `requirements.txt`). Reinstall the
  requirements or rebuild the image; the join URL is still printed under the code so people can type it.
- **QR opens localhost or a wrong host**: `PUBLIC_BASE_URL` is not the public URL. Fix it (`fly.toml` `[env]` or
  `.env`) and restart. Links and the QR are built from it on every request, so existing rooms pick it up.
- **Votes vanish after a restart**: the database is not on the Fly volume. `DATABASE_PATH` must be `/data/pulse.db`
  with the `pulse_data` volume mounted at `/data`.
- **"vote first" on Get started**: the phone has no `pv` cookie or voted in another browser. Cookies need the page
  and the API on the same origin; HTTPS is not required, but a blocked-cookie or private tab counts as a new voter.
- **No Close button / 409 `voting is closed`**: the screen URL needs a valid `?token=` (use `presenter_url`); a closed
  room cannot reopen, so create a new one.
- **Share text looks cut**: X and Threads clip by design (280 and 500); LinkedIn and `text` carry the full caption.

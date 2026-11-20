# Pulse learning loop

The loop the founders described, in code:

1. **Sort** every post into a theme (semantically, not by tag).
2. **Measure** each theme and platform against the workspace baseline.
3. **Feed back** the winners into the next generation (prompt and template fallback).

```
post created ──► classify (Jev → Claude → keyword) ──► post_themes
                                                          │
published posts' views/engagements/clicks/onboard ──► insights (theme × platform, lift vs baseline)
                                                          │
                      top themes + "what works" per platform ──► ai.build_prompt / template theme bias
```

## 1. Theme classifier (`app/services/classify.py`)

`classify_posts(conn, workspace_id, post_ids) -> [(post_id, theme_id, confidence, classifier)]`.
It never raises. It writes `post_themes` (one automatic row per post; a `manual` row is never overwritten) and
returns only what it persisted. Stages, each handling only the posts the previous stage left unassigned; any failure
falls through to the next stage:

| # | Classifier | When | `classifier` |
|---|---|---|---|
| 1 | **Jev decision model** | `JEV_API_URL` is set | `jev` |
| 2 | Claude (`messages.parse`, structured output) | `ANTHROPIC_API_KEY` set, per-workspace `classify` budget and the global dollar cap not exhausted | `claude` |
| 3 | Offline token overlap with the theme name (weight 2) and description (weight 1) | always | `keyword` |

A post with no confident match (keyword stage: zero overlap) stays unclassified rather than being forced into a
theme, so insights are not polluted. Only ACTIVE themes of the same workspace are ever assigned.

### Pointing Pulse at Jev

Set `JEV_API_URL` (full URL of the classification endpoint) and, if it needs one, `JEV_API_KEY`. Pulse then sends
one request per classify call (8 second timeout):

```http
POST {JEV_API_URL}
Authorization: Bearer {JEV_API_KEY}        # omitted when JEV_API_KEY is empty
Content-Type: application/json

{
  "workspace_id": "w_ab12cd34ef56",
  "themes": [
    {"id": "t_1", "name": "Behind the beans", "description": "Sourcing, roasting and the people behind each batch."}
  ],
  "posts": [
    {"id": "p_9", "platform": "instagram", "content": "Meet this week's single-origin ..."}
  ]
}
```

Jev must answer `200` with:

```json
{"assignments": [{"post_id": "p_9", "theme_id": "t_1", "confidence": 0.93}]}
```

- `theme_id` must be one of the `themes[].id` that were sent; `post_id` one of the `posts[].id`; `confidence` a number
  in 0..1 (values outside are clamped). Posts Jev does not return, or returns with unknown ids, fall through to
  Claude and then the keyword stage.
- Any non-2xx status, timeout, invalid JSON or wrong shape counts as a Jev failure: the whole batch falls through.
- Post content is truncated to about 2000 characters before sending.

## 2. Insights (`app/services/insights.py`, `app/routes/insights.py`)

Population: the workspace's **published** posts with `published_at` inside the window (`days`, default 30).

| Metric | Definition |
|---|---|
| `posts, views, engagements, clicks` | sums over the population |
| `onboard` | sum of `posts.conversions` (people who got started) |
| `engagement_rate` | `engagements / views` |
| `click_rate` | `clicks / views` |
| `onboard_rate` | `onboard / views` |
| `lift` | `rate / baseline_rate - 1` on the primary metric (0.25 = 25% above the workspace baseline) |
| `lift_by` | the same lift for each of the three rates |

The **baseline** is every published post in the window, including posts without a theme. The primary `lift` uses
the onboard rate when the baseline onboard rate is above 0, otherwise the click rate, otherwise the engagement
rate; it is `0.0` when there is nothing to compare against. Rates are 0 when views are 0.

A post's theme is its `post_themes` row with the highest confidence (manual wins ties). A post without any row falls
back to `posts.theme_id` (treated as manual), which is what makes seeded workspaces and posts created through
`POST /api/posts` work before anything is classified. Posts with neither count in the baseline and the platform
block but not in the theme block.

`top_themes` = the best three themes by onboard rate, then click rate, then engagement rate, with at least two
posts. `sources` counts the window's posts by `posts.metrics_source` (`sim` is simulated, anything else is real).
`summary` is a template-built plain-English paragraph. `POST /api/insights/refresh` asks Claude for a better
paragraph, stores it in the `insights` table and returns it (template text when the AI is not allowed or fails);
`GET /api/insights` surfaces the stored paragraph as `cached_summary`.

Endpoints:

| Method | Path | Result |
|---|---|---|
| GET | `/api/insights?days=30` | themes, platforms, `top_themes`, `sources`, `summary`, `cached_summary`, `baseline` |
| POST | `/api/insights/refresh` | `{summary, ai_used, created_at}` |
| POST | `/api/themes/classify` | classifies up to 60 unclassified posts: `{backfilled, classified, remaining, assignments, classifiers}` |

## 3. Feedback into generation

`ai.load_learning` reads the top themes and one "what works" line per platform. `ai.build_prompt` puts them into
every channel's prompt, and the template fallback biases the theme to the best-performing one when the request names
no theme. `ai.save_variants` writes a manual `post_themes` row whenever a theme was given (so autopilot posts are
covered); `/api/generate` runs the classifier for posts generated without a theme.

## 4. Per-channel pipelines (`app/services/channels.py`)

One pipeline per channel: system rules, limits, a template fallback and a validator/normaliser. `generate_variants`
makes one Claude call per channel in parallel (thread pool, workers only talk to Anthropic, never to SQLite) and
records one `ai_usage` row for the whole generation.

| Channel | Serves | Rules |
|---|---|---|
| `linkedin` | linkedin | strong hook line, 1200-1800 chars, 3 hashtags, CTA with the tracked link |
| `instagram` | instagram, tiktok | caption <= 2200, 8-15 hashtags, `media_prompt` = concrete visual plan (carousel slides or a 15-30 s reel shot list); TikTok is a video script on the same channel |
| `x` | x (Threads rides on it) | <= 280 chars |
| `reddit` | reddit | title + body, no hashtags, `Suggested subreddit: r/...`, community tone |
| `facebook` | facebook | friendly, ends with a question, 0-3 hashtags |

If a channel's Claude output cannot meet its limits after normalisation (for example a LinkedIn post that is too
short), that channel alone falls back to its template; the other channels keep their AI output.

## AI budget

Each purpose (`generate`, `classify`, `insights`) has its own per-workspace budget of `AI_WORKSPACE_LIMIT` calls;
`AI_GLOBAL_CAP_USD` is shared by all of them. `GET /api/ai/usage` still reports the `generate` budget only.

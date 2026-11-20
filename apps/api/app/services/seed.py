"""Seed a guest workspace with a believable last 30 days. Deterministic per workspace id."""

import json
import random
import sqlite3
from datetime import UTC, datetime, timedelta

from app.db import PLATFORMS, new_id
from app.services.posts import create_post

DEMO_BRAND = "Brew & Bloom"

DEMO = {
    "brand_voice": "Warm, witty and a little nerdy about coffee and plants. Short sentences, plenty of charm.",
    "audience": "Urban professionals aged 25-40 who love good coffee and a greener home.",
    "offer": "15% off your first box",
}

THEMES = [
    ("Behind the beans", "Sourcing, roasting and the people behind each batch.", "#b5651d"),
    ("Plant care tips", "Quick, friendly care advice for desk and balcony plants.", "#2e9e5b"),
    ("Customer stories", "Real customers, real mornings, real photos.", "#e0527a"),
    ("Weekend deals", "Limited weekend offers and bundles.", "#7c5cff"),
]

DEMO_COPY = [
    "Meet this week's single-origin: Ethiopian Guji, roasted Tuesday, brewing blueberry jam by Friday.",
    "Your pothos is not dying, it is dramatic. Water once the top two inches are dry and give it light.",
    "\"My Monday standup is now 40% better thanks to the Sunrise Box.\" Thanks Priya, we're blushing.",
    "Weekend only: bundle any bag with a mini fern and take 15% off your first box.",
]
GENERIC_COPY = [
    "A peek behind the scenes at how {brand} makes every order, from first idea to your door.",
    "Quick tip from the {brand} team: small habits beat big plans. Try one this week.",
    "\"Honestly the best thing I bought this year.\" Thanks for the kind words, we love hearing it.",
    "This weekend only at {brand}: a little something special for new customers.",
]
TAGS = [
    ["coffee", "specialtycoffee", "roastery"],
    ["plantcare", "houseplants", "urbanjungle"],
    ["customerlove", "happycustomers", "coffeeandplants"],
    ["weekenddeal", "firstbox", "treatyourself"],
]

# followers, handle suffix, daily views base, eng rate, click rate (of eng), conv rate (of clicks),
# weekday weights Mon..Sun, spikiness
SHAPES = {
    "tiktok": (18400, "", 4200, 0.065, 0.12, 0.05, (0.9, 0.95, 1.0, 1.05, 1.15, 1.1, 0.95), 0.25),
    "instagram": (9600, "", 3000, 0.072, 0.12, 0.05, (0.9, 0.95, 1.0, 1.0, 1.05, 1.1, 1.1), 0.18),
    "linkedin": (3100, "", 520, 0.058, 0.24, 0.085, (1.2, 1.3, 1.3, 1.2, 0.9, 0.35, 0.3), 0.15),
    "reddit": (1450, "", 900, 0.045, 0.17, 0.05, (1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0), 0.9),
    "x": (4200, "", 640, 0.04, 0.14, 0.05, (1.1, 1.1, 1.05, 1.05, 1.0, 0.8, 0.8), 0.2),
    "facebook": (6800, "", 1000, 0.042, 0.15, 0.06, (0.85, 0.9, 0.95, 1.0, 1.1, 1.2, 1.15), 0.15),
}


def _handle(platform: str, slug: str) -> str:
    if platform == "linkedin":
        return f"company/{slug}"
    if platform == "reddit":
        return f"u/{slug}"
    return f"@{slug}"


def _fmt_time(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


def seed_workspace(conn: sqlite3.Connection, workspace_id: str, brand_name: str, *, demo: bool) -> None:
    """Insert connections, themes, metrics, posts, autopilot and events for a fresh workspace."""
    rng = random.Random(workspace_id)
    now = datetime.now(UTC).replace(microsecond=0)
    slug = "".join(ch for ch in brand_name.lower() if ch.isalnum())[:24] or "brand"
    if demo:
        slug = "brewandbloom"
    scale = 1.0 if demo else rng.uniform(0.6, 1.4)

    # connections
    followers = {}
    for p in PLATFORMS:
        f = int(SHAPES[p][0] * scale * rng.uniform(0.92, 1.08))
        followers[p] = f
        conn.execute(
            "INSERT INTO connections (id, workspace_id, platform, handle, status, mode, followers, connected_at)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (new_id("c_"), workspace_id, p, _handle(p, slug), "connected", "sandbox", f,
             _fmt_time(now - timedelta(days=rng.randint(30, 200)))),
        )

    # themes
    theme_ids = []
    for name, desc, color in THEMES:
        tid = new_id("t_")
        theme_ids.append(tid)
        conn.execute(
            "INSERT INTO themes (id, workspace_id, name, description, color, active, created_at)"
            " VALUES (?,?,?,?,?,1,?)",
            (tid, workspace_id, name, desc, color, _fmt_time(now - timedelta(days=30))),
        )

    # daily metrics: 30 days per platform
    platform_totals = {}
    rows = []
    for p in PLATFORMS:
        _, _, base, eng_r, click_r, conv_r, weekly, _spike = SHAPES[p]
        base *= scale
        tv = 0
        for i in range(29, -1, -1):
            d = (now - timedelta(days=i)).date()
            v = base * weekly[d.weekday()] * (1 + 0.006 * (29 - i)) * rng.lognormvariate(0, 0.12)
            if p == "reddit" and rng.random() < 0.12:
                v *= rng.uniform(3, 6)  # front-page spike
            elif p == "reddit":
                v *= rng.uniform(0.4, 0.9)
            if i == 0:
                v *= max(now.hour / 24, 0.15)  # today is partial
            views = max(int(v), 0)
            eng = int(views * eng_r * rng.uniform(0.88, 1.12) + rng.random())
            clicks = int(eng * click_r * rng.uniform(0.88, 1.12) + rng.random())
            conv = int(clicks * conv_r * rng.uniform(0.9, 1.1) + rng.random())
            rows.append((workspace_id, p, d.isoformat(), views, eng, clicks, conv))
            tv += views
        # The 30 days before that, so the dashboard's default 30-day "change %" has a previous period to compare
        # with (it showed 0% everywhere). A separate generator keeps every number above unchanged.
        hist = random.Random(f"{workspace_id}:{p}:hist")
        for i in range(59, 29, -1):
            d = (now - timedelta(days=i)).date()
            v = base * weekly[d.weekday()] * (1 + 0.006 * (29 - i)) * hist.lognormvariate(0, 0.12) * 0.9
            if p == "reddit":
                v *= hist.uniform(3, 6) if hist.random() < 0.12 else hist.uniform(0.4, 0.9)
            views = max(int(v), 0)
            eng = int(views * eng_r * hist.uniform(0.85, 1.05) + hist.random())
            clicks = int(eng * click_r * hist.uniform(0.85, 1.05) + hist.random())
            conv = int(clicks * conv_r * hist.uniform(0.85, 1.05) + hist.random())
            rows.append((workspace_id, p, d.isoformat(), views, eng, clicks, conv))
        platform_totals[p] = tv
    conn.executemany("INSERT INTO daily_metrics VALUES (?,?,?,?,?,?,?)", rows)

    # posts: one per platform x theme. 18 published, 3 drafts, 3 scheduled.
    copy = DEMO_COPY if demo else [c.format(brand=brand_name) for c in GENERIC_COPY]
    draft_platforms = {"linkedin", "x", "reddit"}
    sched_platforms = {"instagram", "tiktok", "facebook"}
    for pi, p in enumerate(PLATFORMS):
        _, _, _, eng_r, click_r, conv_r, _, _ = SHAPES[p]
        for ti, tid in enumerate(theme_ids):
            text = copy[ti]
            if p == "linkedin":
                text += f"\n\nWhat's your take? Tell us below. #{TAGS[ti][0]}"
            elif p == "x":
                text = text[:200]
            tags = TAGS[ti][: 2 if p in ("x", "linkedin") else 3]
            if ti == 3 and p in draft_platforms:
                status = "draft"
            elif ti == 3 and p in sched_platforms:
                status = "scheduled"
            else:
                status = "published"
            quality = rng.uniform(0.35, 0.9)
            post = create_post(
                conn, workspace_id, platform=p, content=text, hashtags=tags,
                media_prompt=f"Bright, natural-light photo for {THEMES[ti][0].lower()} at {brand_name}",
                theme_id=tid, status=status, source="seed", quality=quality, commit=False,
            )
            if status == "scheduled":
                conn.execute("UPDATE posts SET scheduled_at=? WHERE id=?",
                             (_fmt_time(now + timedelta(hours=rng.randint(4, 60))), post.id))
            elif status == "draft":
                conn.execute("UPDATE posts SET created_at=? WHERE id=?",
                             (_fmt_time(now - timedelta(hours=rng.randint(2, 40))), post.id))
            else:
                age = rng.uniform(1, 28)
                pub = now - timedelta(days=age)
                views = int(platform_totals[p] * rng.uniform(0.04, 0.13) * (0.6 + quality))
                eng = int(views * eng_r * rng.uniform(0.9, 1.1))
                clicks = int(eng * click_r * rng.uniform(0.9, 1.1))
                conv = int(clicks * conv_r * rng.uniform(0.9, 1.1) + rng.random())
                conn.execute(
                    "UPDATE posts SET status='published', published_at=?, created_at=?, last_tick_at=?,"
                    " views=?, engagements=?, clicks=?, conversions=? WHERE id=?",
                    (_fmt_time(pub), _fmt_time(pub - timedelta(hours=1)), _fmt_time(now),
                     views, eng, clicks, conv, post.id),
                )
                if rng.random() < 0.35 or (pi == 0 and ti == 0):
                    conn.execute(
                        "INSERT INTO events (id, workspace_id, post_id, type, platform, detail, real, ts)"
                        " VALUES (?,?,?,?,?,?,0,?)",
                        (new_id("e_"), workspace_id, post.id, "published", p,
                         f"Published to {p.capitalize()}: {text[:60]}", _fmt_time(pub)),
                    )

    # autopilot (disabled)
    conn.execute(
        "INSERT INTO autopilot (workspace_id, enabled, interval_min, platforms, require_approval)"
        " VALUES (?,0,30,?,1)",
        (workspace_id, json.dumps(list(PLATFORMS))),
    )

    # a handful of misc events
    for p in PLATFORMS:
        conn.execute(
            "INSERT INTO events (id, workspace_id, post_id, type, platform, detail, real, ts)"
            " VALUES (?,?,NULL,?,?,?,0,?)",
            (new_id("e_"), workspace_id, "connected", p, f"Connected {p.capitalize()} (sandbox)",
             _fmt_time(now - timedelta(days=29, hours=rng.randint(0, 5)))),
        )
    for hours, plat, n in ((3, "instagram", 42), (7, "tiktok", 118), (26, "linkedin", 15)):
        conn.execute(
            "INSERT INTO events (id, workspace_id, post_id, type, platform, detail, real, ts)"
            " VALUES (?,?,NULL,?,?,?,0,?)",
            (new_id("e_"), workspace_id, "engagement", plat,
             f"{n} new likes on {plat.capitalize()}", _fmt_time(now - timedelta(hours=hours))),
        )
    conn.commit()

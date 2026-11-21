"""Claude copy generation with a deterministic template fallback (U2 + W1 learning loop).

One Claude call per channel (see `app.services.channels`), run in parallel worker threads. Workers only talk to the
Anthropic client; every sqlite access (usage rows, learning, themes) stays on the calling thread.
"""

import logging
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

import anthropic
from pydantic import ValidationError

from app.config import settings
from app.db import new_id, now_iso
from app.models import AiUsage, Post
from app.services import channels
from app.services import posts as posts_svc
from app.services.channels import LINK, Variant, Variants, _clip

log = logging.getLogger("pulse")

INPUT_USD_PER_MTOK = 2.0
OUTPUT_USD_PER_MTOK = 10.0


def get_client() -> anthropic.Anthropic:
    return anthropic.Anthropic(api_key=settings.anthropic_api_key, max_retries=1, timeout=45)


def _global_spent(conn: sqlite3.Connection) -> float:
    return float(conn.execute("SELECT COALESCE(SUM(cost_usd), 0) FROM ai_usage").fetchone()[0])


def ai_allowed(conn: sqlite3.Connection, workspace_id: str, purpose: str = "generate") -> bool:
    """True when a Claude call for `purpose` ('generate' | 'classify' | 'insights') may be made.

    Each purpose has its own per-workspace budget of `AI_WORKSPACE_LIMIT` calls; the global dollar cap is shared.
    """
    if not settings.anthropic_api_key:
        return False
    used = conn.execute(
        "SELECT COUNT(*) FROM ai_usage WHERE workspace_id = ? AND purpose = ?", (workspace_id, purpose)
    ).fetchone()[0]
    if used >= settings.ai_workspace_limit:
        return False
    return _global_spent(conn) < settings.ai_global_cap_usd


def usage_status(conn: sqlite3.Connection, workspace_id: str) -> AiUsage:
    used = conn.execute(
        "SELECT COUNT(*) FROM ai_usage WHERE workspace_id = ? AND purpose = 'generate'", (workspace_id,)
    ).fetchone()[0]
    return AiUsage(
        workspace_used=used,
        workspace_limit=settings.ai_workspace_limit,
        global_spent_usd=_global_spent(conn),
        global_cap_usd=settings.ai_global_cap_usd,
        ai_available=ai_allowed(conn, workspace_id),
    )


def _record_usage(conn: sqlite3.Connection, workspace_id: str, usage, purpose: str = "generate") -> None:
    cost = usage.input_tokens * INPUT_USD_PER_MTOK / 1e6 + usage.output_tokens * OUTPUT_USD_PER_MTOK / 1e6
    conn.execute(
        "INSERT INTO ai_usage (id, workspace_id, purpose, model, input_tokens, output_tokens, cost_usd, ts) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            new_id("u"),
            workspace_id,
            purpose,
            settings.ai_model,
            usage.input_tokens,
            usage.output_tokens,
            cost,
            now_iso(),
        ),
    )
    conn.commit()


# ---------------------------------------------------------------------------------------------------------
# Learning loop: what the workspace's own results say works
# ---------------------------------------------------------------------------------------------------------


@dataclass
class Learning:
    """What the workspace's own results say works. Empty until there is enough data."""

    top_themes: list[str] = field(default_factory=list)  # theme names, best first
    what_works: dict[str, str] = field(default_factory=dict)  # platform -> one plain-English line
    top_theme_ids: list[str] = field(default_factory=list)  # parallel to top_themes, for the template bias


def load_learning(conn: sqlite3.Connection, workspace_id: str) -> Learning:
    """Reads the insights; never raises and never makes a network call."""
    # Imported here: classify/insights import this module for their own Claude calls.
    from app.services import insights

    learning = Learning()
    try:
        for theme in insights.top_themes(conn, workspace_id):
            learning.top_themes.append(theme.name)
            learning.top_theme_ids.append(theme.theme_id)
    except Exception:
        log.warning("learning: top themes unavailable", exc_info=True)
        learning.top_themes, learning.top_theme_ids = [], []
    try:
        learning.what_works = {
            str(platform): str(line) for platform, line in insights.what_works(conn, workspace_id).items() if line
        }
    except Exception:
        log.warning("learning: what-works lines unavailable", exc_info=True)
        learning.what_works = {}
    return learning


def _learned_theme(conn: sqlite3.Connection, workspace_id: str, learning: Learning) -> sqlite3.Row | None:
    """The first top theme that is still an active theme of the workspace."""
    for theme_id in learning.top_theme_ids:
        row = conn.execute(
            "SELECT * FROM themes WHERE id = ? AND workspace_id = ? AND active = 1", (theme_id, workspace_id)
        ).fetchone()
        if row is not None:
            return row
    return None


def build_prompt(
    ws: sqlite3.Row,
    platforms: list[str],
    theme: sqlite3.Row | None,
    trend: sqlite3.Row | None,
    brief: str,
    tone: str,
    learning: Learning | None = None,
) -> str:
    lines = [
        "Brand profile:",
        f"- brand_name: {ws['brand_name']}",
        f"- brand_voice: {ws['brand_voice']}",
        f"- audience: {ws['audience']}",
        f"- offer: {ws['offer']}",
        f"- product_url: {ws['product_url']}",
    ]
    # Imported here: style imports this module for its own Claude calls. Empty until the person uploads writing.
    from app.services import style

    lines += style.prompt_lines(ws)
    if theme is not None:
        lines.append(f"Theme: {theme['name']}. {theme['description']}")
    if trend is not None:
        lines.append(f"Trending topic: {trend['title']} ({trend['url']})")
    if brief:
        lines.append(f"Brief: {brief}")
    if tone:
        lines.append(f"Tone: {tone}")
    if learning is not None:
        if learning.top_themes:
            lines.append(
                "Top-performing themes for this workspace: "
                + ", ".join(_clip(name, 60) for name in learning.top_themes)
            )
        for platform in platforms:
            note = learning.what_works.get(platform)
            if note:
                lines.append(f"What works on {platform}: {_clip(note, 300)}")
    lines.append("Write one variant for each of these platforms, in this order: " + ", ".join(platforms))
    return "\n".join(lines)


# ---------------------------------------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------------------------------------


@dataclass
class _Call:
    channel_id: str
    platforms: list[str]
    response: Any = None  # the SDK response; None when the call failed before one came back


def _call_model(channel_id: str, platforms: list[str], system: str, prompt: str) -> _Call:
    """Runs in a worker thread: only the Anthropic client is touched here, never sqlite."""
    try:
        response = get_client().messages.parse(
            model=settings.ai_model,
            max_tokens=4000,
            output_config={"effort": "low"},
            system=system,
            messages=[{"role": "user", "content": prompt}],
            output_format=Variants,
        )
    except (
        anthropic.RateLimitError,
        anthropic.APIStatusError,
        anthropic.APIConnectionError,
        ValidationError,
    ) as exc:
        log.warning("AI generation for %s fell back to templates: %s", channel_id, type(exc).__name__)
        return _Call(channel_id, platforms)
    return _Call(channel_id, platforms, response)


def _tracked_link_len() -> int:
    """Length of a tracked link (`<PUBLIC_BASE_URL>/r/<code>`), so limits are checked on the final post."""
    return len(settings.public_base_url.rstrip("/")) + len("/r/") + channels.TRACKED_CODE_LEN


def _pick_variants(call: _Call, ctx: channels.Context, link_len: int) -> dict[str, Variant]:
    """The first usable variant per platform of the call, normalised to its channel's limits."""
    parsed = call.response.parsed_output
    picked: dict[str, Variant] = {}
    for variant in parsed.variants:
        if variant.platform not in call.platforms or variant.platform in picked or not variant.content.strip():
            continue
        fixed = channels.normalise(variant, link_len=link_len, ctx=ctx)
        if fixed is not None:
            picked[variant.platform] = fixed
    return picked


def generate_variants(
    conn: sqlite3.Connection,
    ws: sqlite3.Row,
    *,
    platforms: list[str],
    theme: sqlite3.Row | None = None,
    trend: sqlite3.Row | None = None,
    brief: str = "",
    tone: str = "",
) -> tuple[list[Variant], bool]:
    """One variant per requested platform (de-duplicated, in order). Never raises for AI problems.

    Platforms are grouped by channel and each channel gets one Claude call, all in parallel. A channel whose call
    fails, is refused, or whose output cannot meet its limits gets that channel's templates; the others keep
    their AI copy. The returned flag is True when at least one variant came from Claude.
    """
    wanted = list(dict.fromkeys(platforms))
    learning = load_learning(conn, ws["id"])
    # With no explicit theme the template fallback leans on the workspace's best-performing active theme.
    template_theme = theme if theme is not None else _learned_theme(conn, ws["id"], learning)
    ctx = channels.build_context(ws, template_theme, trend, brief, tone)

    by_channel: dict[str, list[str]] = {}
    for platform in wanted:
        by_channel.setdefault(channels.channel_for(platform).id, []).append(platform)

    picks: dict[str, Variant] = {}
    if by_channel and ai_allowed(conn, ws["id"]):
        jobs = [
            (
                channel_id,
                group,
                channels.CHANNELS[channel_id].system_prompt(group),
                build_prompt(ws, group, theme, trend, brief, tone, learning),
            )
            for channel_id, group in by_channel.items()
        ]
        with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
            calls = list(pool.map(lambda job: _call_model(*job), jobs))

        answered = [call for call in calls if call.response is not None]
        if answered:  # a refusal or max_tokens response still cost tokens; a connection error costs nothing
            total = SimpleNamespace(
                input_tokens=sum(c.response.usage.input_tokens for c in answered),
                output_tokens=sum(c.response.usage.output_tokens for c in answered),
            )
            _record_usage(conn, ws["id"], total)
        link_len = _tracked_link_len()
        for call in answered:
            if call.response.stop_reason in ("refusal", "max_tokens") or call.response.parsed_output is None:
                log.warning(
                    "AI generation for %s fell back to templates: stop_reason=%s",
                    call.channel_id,
                    call.response.stop_reason,
                )
                continue
            picks.update(_pick_variants(call, ctx, link_len))

    variants = [picks[p] if p in picks else channels.template_variant(p, ctx) for p in wanted]
    return variants, bool(picks)


def save_variants(
    conn: sqlite3.Connection,
    ws: sqlite3.Row,
    variants: list[Variant],
    *,
    batch_id: str,
    theme_id: str | None,
    trend_id: str | None,
    source: str,
    status: str = "draft",
    scheduled_at: str | None = None,
) -> list[Post]:
    from app.services import classify  # imported here: classify imports this module for its own Claude calls

    published_at = now_iso() if status == "published" else None
    ids: list[str] = []
    for v in variants:
        post = posts_svc.create_post(
            conn,
            ws["id"],
            platform=v.platform,
            content=v.content,
            hashtags=v.hashtags,
            media_prompt=v.media_prompt,
            theme_id=theme_id,
            trend_id=trend_id,
            batch_id=batch_id,
            source=source,
            quality=v.quality,
            status=status,
            commit=False,
        )
        link_url = post.link_url or ""
        conn.execute(
            "UPDATE posts SET content = ?, scheduled_at = ?, published_at = ?, last_tick_at = ? WHERE id = ?",
            (v.content.replace(LINK, link_url), scheduled_at, published_at, published_at, post.id),
        )
        if theme_id is not None:  # the theme was chosen by a person (or autopilot's rota): a manual assignment
            classify.assign_theme(conn, post.id, theme_id, confidence=1.0, classifier="manual", commit=False)
        ids.append(post.id)
    conn.commit()
    return [
        posts_svc.row_to_post(conn, conn.execute("SELECT * FROM posts WHERE id = ?", (post_id,)).fetchone())
        for post_id in ids
    ]

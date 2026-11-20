"""Theme and platform performance insights (W1).

STUB with the agreed interface; unit (b) replaces everything except the names used by ai.py.
"""

import sqlite3

from pydantic import BaseModel


class ThemeInsight(BaseModel):
    theme_id: str
    name: str
    posts: int = 0
    onboard_rate: float = 0.0
    click_rate: float = 0.0
    lift: float = 0.0


def top_themes(conn: sqlite3.Connection, workspace_id: str, days: int = 30) -> list[ThemeInsight]:
    """Best (up to 3) themes by onboard rate then click rate, at least 2 posts. Never raises."""
    return []


def what_works(conn: sqlite3.Connection, workspace_id: str, days: int = 30) -> dict[str, str]:
    """{platform: one plain-English 'what works' line}. Platforms without enough data are absent. Never raises."""
    return {}

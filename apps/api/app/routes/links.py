"""Tracked links: /r/{code} click, /l/{code} landing page, convert."""

import html
import json
import sqlite3

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse

from app.db import get_db, new_id, now_iso
from app.services import metrics

router = APIRouter()


def _post_by_code(conn: sqlite3.Connection, code: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM posts WHERE link_code = ?", (code,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="unknown link")
    return row


def _record(conn: sqlite3.Connection, post: sqlite3.Row, kind: str) -> None:
    col = "clicks" if kind == "click" else "conversions"
    conn.execute(f"UPDATE posts SET {col} = {col} + 1 WHERE id = ?", (post["id"],))
    metrics.bump_daily(conn, post["workspace_id"], post["platform"], metrics.today(),
                       **{col: 1})
    verb = "Real click" if kind == "click" else "Real conversion"
    conn.execute(
        "INSERT INTO events (id, workspace_id, post_id, type, platform, detail, real, ts)"
        " VALUES (?,?,?,?,?,?,1,?)",
        (new_id("e_"), post["workspace_id"], post["id"], kind, post["platform"],
         f"{verb} from {post['platform'].capitalize()} tracked link", now_iso()),
    )
    conn.commit()


@router.get("/r/{code}")
def track_click(code: str, conn: sqlite3.Connection = Depends(get_db)):
    post = _post_by_code(conn, code)
    _record(conn, post, "click")
    return RedirectResponse(f"/l/{code}", status_code=302)


@router.post("/api/links/{code}/convert")
def convert(code: str, conn: sqlite3.Connection = Depends(get_db)):
    post = _post_by_code(conn, code)
    _record(conn, post, "conversion")
    return {"ok": True}


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__BRAND__</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:linear-gradient(160deg,#1b1233,#3b2a7a);color:#fff;padding:20px}
main{max-width:420px;width:100%;text-align:center}
h1{font-size:34px;margin:0 0 8px}p{font-size:18px;line-height:1.45;opacity:.9}
.offer{display:inline-block;margin:18px 0 26px;padding:10px 18px;border-radius:999px;background:rgba(255,255,255,.14);font-weight:600}
button{width:100%;font-size:22px;font-weight:700;padding:20px;border:0;border-radius:16px;background:#ffd166;color:#241a4a;cursor:pointer}
button:disabled{opacity:.6}.thanks{display:none}.small{font-size:13px;opacity:.6;margin-top:22px}
</style></head><body><main>
<div id="start"><h1>__BRAND__</h1><p>__AUDIENCE__</p>
<div class="offer">__OFFER__</div>
<button id="go">Get started</button></div>
<div id="thanks" class="thanks"><h1>Thank you!</h1><p>You're in. __BRAND__ will be in touch soon.</p></div>
<p class="small">Demo landing page</p>
</main>
<script>
document.getElementById('go').addEventListener('click',function(){
var b=this;b.disabled=true;
fetch('/api/links/'+__CODE__+'/convert',{method:'POST'}).catch(function(){}).then(function(){
document.getElementById('start').style.display='none';
document.getElementById('thanks').style.display='block';});});
</script></body></html>"""


@router.get("/l/{code}", response_class=HTMLResponse)
def landing(code: str, conn: sqlite3.Connection = Depends(get_db)):
    post = _post_by_code(conn, code)
    ws = conn.execute("SELECT * FROM workspaces WHERE id = ?", (post["workspace_id"],)).fetchone()
    page = (
        PAGE.replace("__BRAND__", html.escape(ws["brand_name"]))
        .replace("__AUDIENCE__", html.escape(ws["audience"] or ""))
        .replace("__OFFER__", html.escape(ws["offer"] or ""))
        .replace("__CODE__", html.escape(json.dumps(code), quote=False).replace("<", "\\u003c"))
    )
    return HTMLResponse(page)

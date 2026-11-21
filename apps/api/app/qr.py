"""QR helpers shared by the rooms code and the public "Install Pulse" routes."""

from functools import lru_cache

import segno

from app.config import settings


@lru_cache(maxsize=256)
def qr_svg(url: str) -> str:
    """One inline `<svg viewBox=...>` QR code for `url` (no XML declaration), memoised per url."""
    return segno.make(url, error="m", micro=False).svg_inline(
        omitsize=True, dark="#0B0F1A", light="#FFFFFF", border=2, svgclass="qr", lineclass=None
    )


def android_download_url() -> str:
    """Absolute public URL that 302s to the newest APK. Never carries a token or workspace id."""
    return f"{settings.public_base_url.rstrip('/')}/download/android"


def standalone_qr_svg(url: str) -> str:
    """The QR as a standalone image document (with xmlns), for `<img>` / SvgXml use."""
    svg = qr_svg(url)
    return svg.replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ', 1) if "xmlns" not in svg else svg


_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Install Pulse on Android</title>
<meta name="description" content="Pulse reads your Instagram and LinkedIn numbers and posts for you in two taps.">
<style>
:root{--bg:#0b1020;--card:#141a2e;--hi:#1b2340;--bd:#232b47;--tx:#f4f6ff;--dim:#a8b0cf;--mute:#6f7899;
--ac:#7c5cff;--ac2:#ff5c8a;--ok:#2fe0a3;--info:#4cc3ff;--li:#0a66c2;--ig:#e1306c}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--tx);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
background-image:radial-gradient(900px 500px at 85% -10%,rgba(124,92,255,.28),transparent 60%),
radial-gradient(700px 420px at -10% 30%,rgba(255,92,138,.16),transparent 60%)}
.wrap{max-width:1080px;margin:0 auto;padding:28px 16px 56px}
nav{display:flex;align-items:center;gap:10px;font-weight:800;font-size:20px;letter-spacing:-.3px}
.logo{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,var(--ac),var(--ac2));
display:grid;place-items:center;font-size:18px}
.hero{display:grid;grid-template-columns:1.1fr .9fr;gap:40px;align-items:center;margin-top:44px}
.pill{display:inline-block;padding:6px 12px;border-radius:999px;background:var(--hi);border:1px solid var(--bd);
color:var(--dim);font-size:13px;font-weight:600}
h1{font-size:clamp(36px,6vw,58px);line-height:1.04;letter-spacing:-1.5px;margin:16px 0 14px;font-weight:800}
.grad{background:linear-gradient(90deg,var(--ac),var(--ac2));-webkit-background-clip:text;background-clip:text;color:transparent}
.lead{color:var(--dim);font-size:18px;line-height:1.55;margin:0 0 26px;max-width:520px}
.cta{display:flex;flex-wrap:wrap;gap:16px;align-items:center}
.btn{display:inline-flex;align-items:center;gap:10px;padding:16px 26px;border-radius:16px;font-weight:800;font-size:17px;
color:#fff;text-decoration:none;background:linear-gradient(135deg,var(--ac),var(--ac2));box-shadow:0 10px 30px rgba(124,92,255,.35)}
.btns{display:flex;flex-direction:column;gap:12px;min-width:290px}
.btn .i{width:24px;height:24px;flex:none}.bi{display:inline-flex;gap:10px;width:58px;flex:none;justify-content:center;font-style:normal}.btns .btn{justify-content:flex-start}.btn span{display:flex;flex-direction:column;line-height:1.15}
.btn small{font-size:12px;font-weight:600;opacity:.85}
.btn2{background:var(--hi);border:1px solid var(--borderHi,#35406a);box-shadow:none}
.alt{color:var(--mute);font-size:13.5px;margin-top:16px}.alt a{color:var(--dim)}
.qr{display:flex;gap:12px;align-items:center;color:var(--mute);font-size:13px;line-height:1.4}
.qr .box{width:92px;height:92px;background:#fff;border-radius:12px;padding:5px}
.qr svg{width:100%;height:100%;display:block}
.steps{color:var(--mute);font-size:13.5px;margin-top:16px}
.phone{justify-self:center;width:300px;border-radius:40px;padding:12px;background:#05070f;border:1px solid var(--bd);
box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 0 6px #121829}
.screen{border-radius:30px;background:var(--bg);padding:20px 14px 18px;min-height:540px}
.sh{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.sh b{font-size:22px;letter-spacing:-.4px}.sh span{font-size:11px;color:var(--ok);font-weight:700}
.tiles{display:grid;grid-template-columns:1fr 1fr;gap:9px}
.t{background:var(--card);border:1px solid var(--bd);border-radius:16px;padding:11px}
.t small{display:block;color:var(--dim);font-size:11px;font-weight:600}
.t b{display:block;font-size:22px;margin-top:3px;letter-spacing:-.5px}
.t i{font-style:normal;font-size:10.5px;color:var(--ok);font-weight:700}
.chart{margin-top:10px;background:var(--card);border:1px solid var(--bd);border-radius:16px;padding:11px}
.bars{display:flex;align-items:flex-end;gap:5px;height:70px;margin-top:8px}
.bars div{flex:1;border-radius:5px 5px 2px 2px;background:linear-gradient(180deg,var(--ac),rgba(124,92,255,.35))}
.post{margin-top:10px;background:var(--card);border:1px solid var(--bd);border-radius:16px;padding:11px;font-size:12px;color:var(--dim)}
.row{display:flex;gap:6px;margin-top:9px}
.chip{flex:1;text-align:center;padding:8px 0;border-radius:11px;font-weight:800;font-size:11.5px;color:#fff}
h2{font-size:30px;letter-spacing:-.7px;margin:72px 0 8px}
.sub{color:var(--dim);margin:0 0 24px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.f{background:var(--card);border:1px solid var(--bd);border-radius:22px;padding:20px}
.ic{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;font-weight:800;color:#fff;margin-bottom:14px}
.f h3{margin:0 0 6px;font-size:16.5px}.f p{margin:0;color:var(--dim);font-size:14px;line-height:1.5}
.more{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:14px}
.m{background:var(--hi);border:1px solid var(--bd);border-radius:16px;padding:14px 16px;color:var(--dim);font-size:14px}
.m b{color:var(--tx);display:block;margin-bottom:3px}
footer{margin-top:64px;color:var(--mute);font-size:13px;text-align:center}
@media (max-width:860px){.hero{grid-template-columns:1fr;margin-top:28px}.grid{grid-template-columns:1fr 1fr}
.more{grid-template-columns:1fr}.qr{display:none}.btns{width:100%;min-width:0}.btn{width:100%;justify-content:flex-start}}
@media (max-width:520px){.grid{grid-template-columns:1fr}.phone{width:270px}}
</style></head><body><div class="wrap">
<nav><div class="logo">&#9889;</div>Pulse</nav>
<section class="hero"><div>
<span class="pill">Android app &middot; free</span>
<h1>Your socials, <span class="grad">on autopilot.</span></h1>
<p class="lead">Pulse reads your real Instagram and LinkedIn numbers, writes the next post with AI, and publishes it for you in two taps. No copy and paste, no switching apps.</p>
<div class="cta"><div class="btns"><a class="btn" href="/download/android"><i class="bi"><svg class="i" viewBox="0 0 24 24"><path fill="currentColor" d="M17.6 9.48l1.84-3.18a.38.38 0 0 0-.66-.38l-1.86 3.22A11.5 11.5 0 0 0 12 8.08c-1.74 0-3.4.37-4.92 1.06L5.22 5.92a.38.38 0 0 0-.66.38L6.4 9.48A10.8 10.8 0 0 0 1 18h22a10.8 10.8 0 0 0-5.4-8.52zM7 15.25a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm10 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5z"/></svg></i><span>Download for Android<small>APK for phones</small></span></a><a class="btn btn2" href="/download/desktop"><i class="bi"><svg class="i" viewBox="0 0 24 24"><path fill="currentColor" d="M3 5.5l7.5-1v7H3zM11.5 4.3L21 3v8.5h-9.5zM3 12.5h7.5v7L3 18.5zM11.5 12.5H21V21l-9.5-1.3z"/></svg><svg class="i" viewBox="0 0 24 24"><path fill="currentColor" d="M16.4 12.6c0-2.5 2-3.7 2.1-3.8-1.2-1.7-3-1.9-3.6-2-1.5-.2-3 .9-3.8.9-.8 0-2-.9-3.3-.8-1.7 0-3.2 1-4.1 2.5-1.8 3.1-.5 7.6 1.3 10.1.8 1.2 1.8 2.6 3.1 2.5 1.2 0 1.7-.8 3.2-.8s1.9.8 3.2.8c1.3 0 2.2-1.2 3-2.4.9-1.4 1.3-2.7 1.3-2.8 0 0-2.4-1-2.4-4.2zM14 5.2c.7-.8 1.1-1.9 1-3-1 0-2.2.7-2.9 1.5-.6.7-1.2 1.8-1 2.9 1.1.1 2.2-.6 2.9-1.4z"/></svg></i><span>Download for Desktop<small>Windows and macOS</small></span></a></div><div class="qr"><div class="box" role="img" aria-label="QR code to download Pulse for Android">__QR__</div><div>Android phone nearby?<br>Scan to install.</div></div></div>
<div class="alt">Or pick yours: <a href="/download/android">Android</a> &middot; <a href="/download/windows">Windows</a> &middot; <a href="/download/mac">macOS</a></div>

</div>
<div class="phone"><div class="screen">
<div class="sh"><b>Dashboard</b><span>&#9679; Live</span></div>
<div class="tiles">
<div class="t"><small>Followers</small><b>2,481</b><i>+124 this week</i></div>
<div class="t"><small>Views</small><b>18.2k</b><i>+31%</i></div>
<div class="t"><small>Engagements</small><b>1,036</b><i>+18%</i></div>
<div class="t"><small>Link clicks</small><b>342</b><i>+57</i></div></div>
<div class="chart"><small style="color:var(--dim);font-size:11px;font-weight:600">Engagement, last 7 days</small>
<div class="bars"><div style="height:38%"></div><div style="height:52%"></div><div style="height:45%"></div>
<div style="height:70%"></div><div style="height:61%"></div><div style="height:84%"></div><div style="height:100%"></div></div></div>
<div class="post"><b style="color:var(--tx)">Next post, drafted by AI</b><br>3 lessons from shipping our first product in 48 hours&hellip;
<div class="row"><div class="chip" style="background:var(--li)">Post on LinkedIn</div><div class="chip" style="background:var(--ig)">Post to Instagram</div></div></div>
</div></div></section>

<h2>Four things, done for you</h2><p class="sub">Sign in once inside the app. Pulse does the rest.</p>
<div class="grid">
<div class="f"><div class="ic" style="background:var(--ig)">IG</div><h3>Reads Instagram</h3><p>Followers, likes and comments on every post, pulled straight from your account.</p></div>
<div class="f"><div class="ic" style="background:var(--li)">in</div><h3>Reads LinkedIn</h3><p>Followers, views and reactions from your profile, on one dashboard.</p></div>
<div class="f"><div class="ic" style="background:linear-gradient(135deg,var(--ig),var(--ac))">&#10148;</div><h3>Posts to Instagram</h3><p>Pulse makes the image card and publishes the post. Tap, confirm, done.</p></div>
<div class="f"><div class="ic" style="background:linear-gradient(135deg,var(--li),var(--ac))">&#10148;</div><h3>Posts to LinkedIn</h3><p>Your AI draft goes live from inside Pulse in two taps.</p></div></div>
<div class="more">
<div class="m"><b>AI writing in your style</b>Drafts from a one-line brief, tuned to each platform.</div>
<div class="m"><b>Tracked links</b>Every post gets a short link, so you see clicks and conversions.</div>
<div class="m"><b>Trends and insights</b>What is rising today and what worked best for you.</div></div>
<footer>Pulse &middot; built for the hackathon &middot; <a href="/download/android" style="color:var(--dim)">Download the APK</a></footer>
</div></body></html>"""


def install_page(url: str) -> str:
    return _PAGE.replace("__QR__", qr_svg(url))

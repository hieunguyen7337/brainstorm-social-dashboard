"""Server-rendered HTML for Room mode: the voter's phone page, the big screen and a friendly 404.

Pure inline CSS + vanilla JS, no framework and no external request. Every dynamic value is either
`html.escape`d (HTML context) or JSON-encoded with `<`, `>` and `&` escaped (script context). Templates use
`__NAME__` placeholders that are filled in a single pass, so a value can never inject another placeholder.
"""

import html
import json
import re
from urllib.parse import quote

_ACCENT = "#7C5CFF"
_DEFAULT_TITLE = "Which post would you click?"
_HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
_PLACEHOLDER = re.compile(r"__([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)__")


def _e(value: object) -> str:
    """HTML-escape any value (None -> empty string)."""
    return html.escape("" if value is None else str(value), quote=True)


def _js(value: object) -> str:
    """JSON for a <script> block: safe against `</script>`, `<!--` and HTML entities."""
    return (
        json.dumps(value, ensure_ascii=True)
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
    )


def _fill(template: str, **values: str) -> str:
    """Replace every `__NAME__` placeholder in one pass (unknown names raise KeyError)."""
    return _PLACEHOLDER.sub(lambda m: values[m.group(1)], template)


def _color(value: object) -> str:
    text = str(value or "")
    return text if _HEX_COLOR.match(text) else _ACCENT


def _initials(name: str) -> str:
    words = [w for w in re.split(r"\s+", name.strip()) if w]
    return "".join(w[0] for w in words[:2]).upper() or "P"


def _variant_map(variants: list[dict]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for v in variants or []:
        if v.get("choice") in ("a", "b"):
            out[v["choice"]] = v
    for c in ("a", "b"):
        out.setdefault(c, {"choice": c, "content": "", "theme": "", "theme_color": _ACCENT})
    return out


def _count(votes: dict[str, int] | None, key: str) -> int:
    try:
        return max(0, int((votes or {}).get(key, 0)))
    except (TypeError, ValueError):
        return 0


def _long_text(text: str) -> bool:
    """Rough guess that the post needs the 5-line clamp (JS refines it, this serves the no-JS case)."""
    return sum(max(1, -(-len(line) // 32)) for line in text.split("\n")) > 5


_FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif'
_MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace'

_HEAD = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0B0F1A">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex">
<meta name="referrer" content="same-origin">
<title>__TITLE__</title>
<style>
"""

# ---------------------------------------------------------------------------------------------------------
# Phone page
# ---------------------------------------------------------------------------------------------------------

_PHONE_CSS = """
*{box-sizing:border-box;margin:0}
:root{--bg:#0B0F1A;--card:#141A2B;--hi:#1B2340;--line:#232B47;--line2:#35406A;--tx:#F4F6FF;--dim:#B3BBD8;
--mute:#8E97B8;--ac:#7C5CFF;--acd:#6A47F2;--act:#B9A9FF;--b:#FF5C8A;--bt:#FF8FB0;--ok:#2FE0A3;--warn:#FFB648}
html{-webkit-text-size-adjust:100%;background:var(--bg)}
body{background:var(--bg);color:var(--tx);min-height:100vh;font:16px/1.45 __FONT__;overflow-wrap:break-word}
[hidden]{display:none!important}
.top{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:10px;min-height:52px;
padding:8px 16px;
background:rgba(11,15,26,.94);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);
border-bottom:1px solid var(--line);font-size:15px;color:var(--dim)}
.top b{color:var(--tx)}.top span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.logo{flex:none;width:22px;height:22px;border-radius:7px;
background:linear-gradient(135deg,var(--ac),var(--b))}
main{max-width:560px;margin:0 auto;padding:18px 16px 44px}
h1{font-size:26px;line-height:1.15;font-weight:800;letter-spacing:-.5px;margin:2px 0 6px}
.sub{color:var(--dim);font-size:15px;margin-bottom:18px}
.msg{margin:0 0 14px;padding:10px 14px;border-radius:12px;background:rgba(255,182,72,.12);
border:1px solid rgba(255,182,72,.5);font-size:15px}
.msg:empty,.banner p:empty{display:none}
.banner{display:none;margin-bottom:16px;padding:14px 16px;border-radius:14px;background:rgba(255,182,72,.12);
border:1px solid rgba(255,182,72,.55)}
.banner h2{font-size:19px;color:#FFD08A}.banner p{margin-top:2px;font-size:16px}
.result{display:none;margin-bottom:22px;padding:18px;border-radius:18px;border:1px solid var(--line2);
background:linear-gradient(160deg,rgba(124,92,255,.2),rgba(255,92,138,.08)),var(--card)}
.thanks{display:flex;gap:12px;align-items:center}
.check{flex:none;width:44px;height:44px;border-radius:50%;background:var(--ok);color:#06231A;display:grid;
place-items:center}
.thanks h2{font-size:22px;line-height:1.2;letter-spacing:-.3px}.thanks p{color:var(--dim);font-size:15px}
.thanks b{color:var(--tx)}
.btn{display:flex;align-items:center;justify-content:center;width:100%;min-height:56px;padding:12px 18px;
border:0;border-radius:14px;font-family:inherit;font-weight:800;font-size:19px;line-height:1.2;cursor:pointer;
-webkit-tap-highlight-color:transparent;transition:transform .12s,filter .12s,opacity .12s}
.btn:active{transform:scale(.98)}.btn[disabled]{opacity:.6;cursor:default}
.btn:focus-visible,.link:focus-visible,.tg:focus-visible~.more{outline:3px solid #fff;outline-offset:3px}
.btn-a{background:var(--ac);color:#fff}.btn-b{background:var(--b);color:#0B0F1A}
.btn-go{margin-top:16px;background:var(--ok);color:#06231A;font-size:20px}
.onb-done{display:none;align-items:center;gap:10px;margin-top:16px;padding:14px 16px;border-radius:14px;
background:rgba(47,224,163,.12);border:1px solid rgba(47,224,163,.55);font-weight:700;font-size:17px}
.mini{margin-top:18px}
.mini h3{font-size:14px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--mute);
margin-bottom:8px}
.bar{display:flex;height:14px;border-radius:999px;background:var(--hi);overflow:hidden}
.bar span{display:block;height:100%;transition:width .5s ease}
.sa{background:var(--ac)}.sb{background:var(--b)}
.lg{display:flex;justify-content:space-between;gap:10px;margin-top:8px;font-size:15px;color:var(--dim)}
.lg b{color:var(--tx)}.lg i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px}
.chg{display:none;margin-top:10px}
.link{min-height:44px;padding:8px 2px;border:0;background:none;color:var(--act);font:inherit;font-size:15px;
font-weight:600;text-decoration:underline;text-underline-offset:3px;cursor:pointer}
.opt+.opt{margin-top:26px}
.post{position:relative;padding:14px;border-radius:14px;background:var(--card);border:1px solid var(--line);
transition:border-color .2s,box-shadow .2s}
.tg{position:absolute;opacity:0;width:1px;height:1px;margin:0;pointer-events:none}
.ph{display:flex;align-items:center;gap:10px}
.av{flex:none;width:40px;height:40px;border-radius:50%;display:grid;place-items:center;font-weight:800;
font-size:15px;color:#fff;background:linear-gradient(135deg,var(--ac),var(--b))}
.who{flex:1;min-width:0;line-height:1.3}
.who b{display:block;font-size:15px}
.who small{display:block;font-size:14px;color:var(--mute);overflow:hidden;text-overflow:ellipsis;
white-space:nowrap}
.tagpick{display:none;position:absolute;top:-15px;left:14px;padding:2px 12px;border-radius:999px;
background:var(--acd);color:#fff;font-size:14px;font-weight:700;box-shadow:0 0 0 3px var(--bg)}
.badge{flex:none;width:30px;height:30px;border-radius:9px;display:grid;place-items:center;font-weight:800;
font-size:15px}
.ba{background:var(--acd);color:#fff}.bb{background:var(--b);color:#0B0F1A}
.body{margin-top:12px;font-size:15px;line-height:1.5;color:#E8EBFA;white-space:pre-line;
overflow-wrap:anywhere;max-height:7.5em;overflow:hidden}
.tg:checked~.body{max-height:none;overflow:visible}
.more{display:flex;width:max-content;align-items:center;min-height:36px;font-size:15px;font-weight:600;
color:var(--mute);cursor:pointer;border-radius:4px}
.more .m2,.tg:checked~.more .m1{display:none}.tg:checked~.more .m2{display:inline}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.chip{display:inline-flex;align-items:center;gap:7px;max-width:100%;margin-top:8px;padding:5px 12px;
border-radius:999px;background:var(--hi);border:1px solid var(--line);font-size:14px;color:var(--dim)}
.chip i{flex:none;width:9px;height:9px;border-radius:50%}
.chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lf{display:flex;justify-content:space-between;margin-top:12px;padding-top:10px;
border-top:1px solid var(--line);
font-size:13px;color:var(--mute);user-select:none}
.vote-form{margin-top:10px}
.foot{margin-top:28px;text-align:center;font-size:14px;color:var(--mute)}
#app:not([data-voted=""]) .result{display:block}
#app:not([data-voted=""]) h1{margin-bottom:22px}
#app[data-closed="1"][data-voted=""] h1{margin-bottom:16px}
#app:not([data-voted=""]) .sub,#app[data-closed="1"] .sub,
#app:not([data-voted=""]) .vote-form,#app[data-closed="1"] .vote-form{display:none}
#app[data-closed="1"] .banner{display:block}
#app[data-closed="1"] .chg{display:none!important}
#app[data-voted="a"][data-closed="0"] .chg-b,#app[data-voted="b"][data-closed="0"] .chg-a{display:block}
#app[data-voted="a"] #card-a,#app[data-voted="b"] #card-b{border-color:var(--ac);
box-shadow:0 0 0 1px var(--ac),0 10px 30px rgba(124,92,255,.28)}
#app[data-voted="a"] #card-a .tagpick,#app[data-voted="b"] #card-b .tagpick{display:inline-block}
#app[data-onb="1"] .onb-form{display:none}#app[data-onb="1"] .onb-done{display:flex}
@media (max-width:359px){h1{font-size:23px}.btn{font-size:18px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
"""

_PHONE_BODY = """</style></head><body>
<header class="top"><i class="logo"></i><span><b>__BRAND__</b> &middot; Room __CODE__</span></header>
<main id="app" data-voted="__VOTED__" data-closed="__CLOSED__" data-onb="__ONB__">
<div class="banner" role="status" aria-live="polite"><h2>Voting is closed</h2><p
id="winline">__WINLINE__</p></div>
<p class="msg" id="msg" role="status" aria-live="polite"></p>
<section class="result" aria-labelledby="thx">
<div class="thanks"><span class="check"><svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
<path
d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"
stroke-linejoin="round"/></svg></span>
<div><h2 id="thx">Thanks for voting!</h2><p>Your pick: <b id="pick">__PICK__</b>. Watch the big screen.</p>
</div></div>
<form class="onb-form" method="post" action="/v/__CODEURL__/onboard" data-act="onboard">
<button class="btn btn-go" type="submit">Get started</button></form>
<p class="onb-done" role="status">You're in. Watch the big screen!</p>
<div class="mini" aria-live="polite"><h3>The room so far</h3>
<div class="bar" aria-hidden="true"><span class="sa" id="sa" style="width:__WA__%"></span><span class="sb"
id="sb"
style="width:__WB__%"></span></div>
<div class="lg"><span><i class="sa"></i>A <b id="pa">__PA__%</b> (<span id="ca">__VA__</span>)</span>
<span><i class="sb"></i>B <b id="pb">__PB__%</b> (<span id="cb">__VB__</span>)</span></div></div>
<form class="chg chg-a" method="post" action="/v/__CODEURL__/vote" data-act="vote">
<input type="hidden" name="choice" value="a"><button class="link" type="submit">Change my vote to A</button>
</form>
<form class="chg chg-b" method="post" action="/v/__CODEURL__/vote" data-act="vote">
<input type="hidden" name="choice" value="b"><button class="link" type="submit">Change my vote to B</button>
</form>
</section>
<h1>__HEADING__</h1>
<p class="sub">Read both posts, then tap the one you would click.</p>
__CARDS__
<p class="foot">Anonymous. One tap. No sign-up.</p>
</main>
<script>
(function(){
"use strict";
var CODE=__CODE_JS__,votes={a:__VA__,b:__VB__},
app=document.getElementById("app"),msg=document.getElementById("msg"),
voting=false,onbing=false,flight=false,settled=false,fails=0,timer=0;
function $(i){return document.getElementById(i)}
function api(p){return"/api/rooms/"+encodeURIComponent(CODE)+"/"+p}
function say(t){msg.textContent=t||""}
function attr(k){return app.getAttribute("data-"+k)}
function share(n,t){return t?Math.round(n/t*100):0}
function render(){
var a=votes.a,b=votes.b,t=a+b,pa=share(a,t);
$("sa").style.width=(t?a/t*100:0)+"%";$("sb").style.width=(t?b/t*100:0)+"%";
$("pa").textContent=pa+"%";$("pb").textContent=(t?100-pa:0)+"%";
$("ca").textContent=a;$("cb").textContent=b}
function setVoted(c){app.setAttribute("data-voted",c||"");if(c)$("pick").textContent=c.toUpperCase()}
function toClosed(){app.setAttribute("data-closed","1");say("");window.scrollTo(0,0)}
function winText(w){
var a=votes.a,b=votes.b;
if(w&&w.choice){var c=w.choice,n=w.theme||"";
return(n?"Winning theme: "+n:"Winner: Post "+c.toUpperCase())+" \\u00b7 "+
Math.round((w.share||share(Math.max(a,b),a+b)/100)*100)+"% of the room"}
return a&&a===b?"It's a tie.":""}
function stats(d){
if(d.votes){votes.a=d.votes.a|0;votes.b=d.votes.b|0;render()}
if(d.status==="closed"){
if(attr("closed")!=="1")toClosed();
settled=true;$("winline").textContent=winText(d.winner)}}
function loop(){
clearTimeout(timer);
if(document.hidden||flight)return;
var closed=attr("closed")==="1";
if(closed?settled:!attr("voted"))return;
flight=true;
var ctl=window.AbortController?new AbortController():null,
to=setTimeout(function(){if(ctl)ctl.abort()},6000);
fetch(api("stats"),{cache:"no-store",credentials:"same-origin",signal:ctl?ctl.signal:undefined})
.then(function(r){if(!r.ok)throw 0;return r.json()})
.then(function(d){fails=0;stats(d)})
.catch(function(){fails++})
.then(function(){clearTimeout(to);flight=false;
if(!(attr("closed")==="1"&&settled))timer=setTimeout(loop,fails?5000:2000)})}
function vote(form){
var c=form.querySelector("input[name=choice]").value,prev=attr("voted"),bak={a:votes.a,b:votes.b};
if(voting||prev===c)return;
voting=true;say("");
if(prev)votes[prev]=Math.max(0,votes[prev]-1);
votes[c]++;setVoted(c);render();window.scrollTo(0,0);
fetch(api("vote"),{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},
body:JSON.stringify({choice:c})})
.then(function(r){
if(r.status===409){votes=bak;setVoted(prev);render();toClosed();settled=false;loop();return}
if(!r.ok)throw 0;
return r.json().then(function(d){
if(d&&d.votes){votes.a=d.votes.a|0;votes.b=d.votes.b|0}
setVoted(d&&d.choice||c);render();loop()})})
.catch(function(){form.submit()})
.then(function(){voting=false})}
function onboard(form){
var btn=form.querySelector("button");
if(onbing)return;
onbing=true;btn.disabled=true;btn.textContent="Joining\\u2026";
fetch(api("onboard"),{method:"POST",credentials:"same-origin"})
.then(function(r){
if(r.status===400){say("Pick A or B first, then tap Get started.");btn.disabled=false;
btn.textContent="Get started";return}
if(!r.ok)throw 0;
app.setAttribute("data-onb","1")})
.catch(function(){form.submit()})
.then(function(){onbing=false})}
document.addEventListener("submit",function(e){
var f=e.target,act=f&&f.getAttribute&&f.getAttribute("data-act");
if(act==="vote"){e.preventDefault();vote(f)}else if(act==="onboard"){e.preventDefault();onboard(f)}});
document.addEventListener("visibilitychange",function(){if(!document.hidden)loop()});
function fit(){
var bs=document.querySelectorAll(".body");
for(var i=0;i<bs.length;i++){
var b=bs[i],cb=b.parentNode.querySelector(".tg"),lb=b.parentNode.querySelector(".more");
if(cb&&lb){lb.hidden=!(cb.checked||b.scrollHeight>b.clientHeight+1);cb.disabled=lb.hidden}}}
var rz=0;
window.addEventListener("resize",function(){cancelAnimationFrame(rz);rz=requestAnimationFrame(fit)});
fit();loop();
})();
</script></body></html>"""


def _post_card(c: str, v: dict, code_url: str, initials: str) -> str:
    text = str(v.get("content") or "").replace("\r\n", "\n").replace("\r", "\n")
    theme = str(v.get("theme") or "").strip()
    chip = ""
    if theme:
        chip = (
            f'<div class="chip"><i style="background:{_color(v.get("theme_color"))}"></i>'
            f"<span>{_e(theme)}</span></div>"
        )
    toggle = more = ""
    if _long_text(text):
        toggle = f'<input type="checkbox" class="tg" id="more-{c}">'
        more = (
            f'<label class="more" for="more-{c}"><span class="m1">&hellip;see more'
            f'<span class="sr"> of post {c.upper()}</span></span>'
            f'<span class="m2">see less<span class="sr"> of post {c.upper()}</span></span></label>'
        )
    upper = c.upper()
    btn = f'<button class="btn btn-{c}" type="submit">I&rsquo;d click {upper}</button>'
    return (
        f'<section class="opt" aria-label="Post {upper}">\n'
        f'<article class="post" id="card-{c}">'
        f'{toggle}<div class="ph"><span class="av" aria-hidden="true">{initials}</span>'
        f'<div class="who"><b>Pulse demo</b><small>Promoted &middot; now</small></div>'
        f'<span class="tagpick">Your pick</span>'
        f'<span class="badge b{c}">{upper}</span></div>'
        f'<div class="body" id="body-{c}">{_e(text)}</div>{more}{chip}'
        f'<div class="lf" aria-hidden="true"><span>Like</span><span>Comment</span><span>Repost</span>'
        f"<span>Send</span></div></article>\n"
        f'<form class="vote-form" method="post" action="/v/{code_url}/vote" data-act="vote">'
        f'<input type="hidden" name="choice" value="{c}">{btn}</form>\n</section>'
    )


def _winner_line(by: dict[str, dict], a: int, b: int) -> str:
    total = a + b
    if total == 0:
        return ""
    if a == b:
        return "It's a tie."
    lead = "a" if a > b else "b"
    theme = str(by[lead].get("theme") or "").strip()
    pct = round(max(a, b) / total * 100)
    name = f"Winning theme: {theme}" if theme else f"Winner: Post {lead.upper()}"
    return f"{name} · {pct}% of the room"


def render_phone_page(*, app_name: str, code: str, title: str, variants: list[dict], status: str,
                      voted: str | None, onboarded: bool, votes: dict[str, int]) -> str:
    """The voter's phone page (`GET /v/{code}`): two post cards, vote buttons, then the result state."""
    by = _variant_map(variants)
    a, b = _count(votes, "a"), _count(votes, "b")
    total = a + b
    pa = round(a / total * 100) if total else 0
    pb = 100 - pa if total else 0
    voted = voted if voted in ("a", "b") else None
    closed = status == "closed"
    code_url = quote(code, safe="")
    initials = _e(_initials(app_name))
    cards = "\n".join(_post_card(c, by[c], _e(code_url), initials) for c in ("a", "b"))
    heading = (title or "").strip() or _DEFAULT_TITLE
    page_title = f"{app_name} · Room {code}"
    return _fill(
        _HEAD + _PHONE_CSS.replace("__FONT__", _FONT) + _PHONE_BODY,
        TITLE=_e(page_title),
        BRAND=_e(app_name),
        CODE=_e(code),
        CODEURL=_e(code_url),
        VOTED=voted or "",
        CLOSED="1" if closed else "0",
        ONB="1" if onboarded else "0",
        PICK=voted.upper() if voted else "",
        WINLINE=_e(_winner_line(by, a, b)) if closed else "",
        WA=f"{a / total * 100:.1f}" if total else "0",
        WB=f"{b / total * 100:.1f}" if total else "0",
        PA=str(pa),
        PB=str(pb),
        VA=str(a),
        VB=str(b),
        HEADING=_e(heading),
        CARDS=cards,
        CODE_JS=_js(code),
    )


# ---------------------------------------------------------------------------------------------------------
# Big screen
# ---------------------------------------------------------------------------------------------------------

_SCREEN_CSS = """
*{box-sizing:border-box;margin:0}
:root{--bg:#0B0F1A;--card:#141A2B;--hi:#1B2340;--line:#232B47;--line2:#35406A;--tx:#F4F6FF;--dim:#B3BBD8;
--mute:#8E97B8;--ac:#7C5CFF;--act:#B9A9FF;--b:#FF5C8A;--bt:#FF8FB0;--ok:#2FE0A3;--warn:#FFB648;--bad:#FF5D73;
--info:#4CC3FF}
html{font-size:clamp(8px,min(1.0417vw,1.852vh),40px);background:#0B0F1A}
body{height:100vh;height:100dvh;overflow:hidden;display:flex;flex-direction:column;
padding:1.2rem 2.4rem 1.4rem;
color:var(--tx);font:1rem/1.35 __FONT__;background-color:#0B0F1A;
background-image:radial-gradient(60rem 40rem at 88% -8%,rgba(124,92,255,.2),transparent 62%),
radial-gradient(50rem 36rem at 0% 108%,rgba(255,92,138,.1),transparent 62%)}
[hidden]{display:none!important}
.hd{flex:none;display:flex;justify-content:space-between;align-items:center;height:2.8rem}
.brand{display:flex;align-items:center;gap:.9rem;font-size:1.6rem;font-weight:600;color:var(--dim)}
.brand b{color:var(--tx)}
.logo{width:2.2rem;height:2.2rem;border-radius:.7rem;background:linear-gradient(135deg,var(--ac),var(--b))}
.hd-r{display:flex;align-items:center;gap:1.4rem;font-size:1.3rem;font-weight:600}
.pill{padding:.3rem 1.1rem;border-radius:999px;border:1px solid var(--line2);color:var(--dim)}
.closed .pill{border-color:var(--warn);color:var(--warn)}
.conn{display:flex;align-items:center;gap:.6rem;color:var(--dim)}
.dot{width:1rem;height:1rem;border-radius:50%;background:var(--ok);animation:pulse 2s infinite}
.conn.bad{color:var(--warn)}.conn.bad .dot{background:var(--warn);animation:none}
.grid{flex:1;min-height:0;display:grid;grid-template-columns:30rem minmax(0,1fr);gap:2.4rem;margin-top:.8rem}
.left{min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1rem}
.qr{width:100%;aspect-ratio:1;padding:1.1rem;border-radius:2rem;background:#fff;
box-shadow:0 1rem 4rem rgba(124,92,255,.35)}
.qr svg{display:block;width:100%;height:100%;shape-rendering:crispEdges}
.url{max-width:100%;margin-top:.8rem;font-family:__MONO__;font-weight:800;white-space:nowrap;
text-align:center;
font-size:min(3.2rem,calc(30rem/(var(--n)*.66)))}
.cap{font-size:1.7rem;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:var(--dim)}
.right{min-width:0;min-height:0;display:grid;grid-template-columns:minmax(0,1fr);
grid-template-rows:auto auto auto auto minmax(0,1fr);gap:1rem}
.title{font-size:max(1.5rem,min(2.6rem,calc(56rem/(var(--tn)*.56))));line-height:1.15;font-weight:800;
letter-spacing:-.03em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.counters{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem}
.ctr{position:relative;padding:.9rem 1.6rem .8rem;border-radius:1.4rem;background:var(--card);
border:1px solid var(--line)}
.ctr::before{content:"";position:absolute;left:1.6rem;top:0;width:3.4rem;height:.3rem;
border-radius:0 0 .3rem .3rem;
background:var(--c)}
.ctr b{display:block;font-size:4.2rem;line-height:1;font-weight:800;letter-spacing:-.03em;
font-variant-numeric:tabular-nums}
.ctr span{display:block;margin-top:.35rem;font-size:1.25rem;font-weight:700;letter-spacing:.14em;
text-transform:uppercase;color:var(--dim)}
.panel{min-height:0;position:relative;display:flex;flex-direction:column;padding:1rem 1.6rem 1.1rem;
border-radius:1.4rem;background:var(--card);border:1px solid var(--line)}
.ph2{flex:none;margin-bottom:.7rem;font-size:1.15rem;font-weight:700;letter-spacing:.14em;
text-transform:uppercase;
color:var(--mute)}
.race{display:grid;grid-template-columns:minmax(0,1fr);gap:.8rem;padding:1rem 1.6rem}
.rw{display:grid;grid-template-columns:minmax(0,1fr);gap:.4rem}
.rt{display:flex;justify-content:space-between;align-items:center;gap:1rem;font-size:1.8rem;line-height:1.2;
font-weight:800}
.rn{min-width:0;display:flex;align-items:center;gap:.8rem;white-space:nowrap}
.rn span{overflow:hidden;text-overflow:ellipsis}
.td{flex:none;width:1.1rem;height:1.1rem;border-radius:50%}
.cr{flex:none;display:none;width:2rem;height:2rem;fill:#FFD27A}
.rw.lead .cr{display:block}
.rv{white-space:nowrap;font-variant-numeric:tabular-nums}
.rv small{margin-left:.8rem;font-size:1.5rem;font-weight:700;color:var(--dim)}
.trk{height:1.7rem;border-radius:999px;background:var(--hi)}
.fl{height:100%;width:0;border-radius:999px;transition:width .6s cubic-bezier(.2,.8,.2,1)}
.fa{background:linear-gradient(90deg,#5B3FE0,var(--ac) 60%,#A592FF)}
.fb{background:linear-gradient(90deg,#E63E74,var(--b) 60%,#FF9DBA)}
.rw.lead .fa{box-shadow:0 0 1.8rem rgba(124,92,255,.75)}
.rw.lead .fb{box-shadow:0 0 1.8rem rgba(255,92,138,.7)}
.win{display:flex;align-items:center;gap:1rem;padding:.8rem 1.8rem;border-radius:1.4rem;
background:var(--card);
border:1px solid var(--line);color:var(--dim);font-size:1.9rem;font-weight:800;
transition:background .4s,border-color .4s,box-shadow .4s,color .4s}
.win svg{flex:none;display:none;width:2.2rem;height:2.2rem;fill:#FFD27A}
.win.lead{color:var(--tx);border-color:var(--line2)}
.win.done{color:#fff;border-color:var(--ac);background:linear-gradient(100deg,rgba(124,92,255,.38),
rgba(255,92,138,.2)),var(--card);box-shadow:0 0 3rem rgba(124,92,255,.35)}
.win.done svg{display:block}
.low{min-height:0;display:grid;grid-template-columns:1.1fr .9fr;gap:1rem}
.fun{flex:1;min-height:0;container-type:size;display:grid;grid-template-rows:repeat(4,minmax(0,1fr));
gap:.6rem}
.fr{display:grid;grid-template-columns:6rem minmax(0,1fr) 4.8rem;align-items:center;gap:1rem;
font-size:1.4rem;font-size:min(1.4rem,17cqh);
font-weight:600;color:var(--dim)}
.fr b{text-align:right;color:var(--tx);font-variant-numeric:tabular-nums}
.ft{height:min(100%,2.2rem);border-radius:.6rem;background:var(--hi)}
.ff{height:100%;width:4%;border-radius:.6rem;transition:width .6s ease;background:var(--c)}
#feed{flex:1;min-height:0;container-type:size;list-style:none;padding:0;display:grid;
grid-template-rows:repeat(8,minmax(0,1fr))}
#feed li{min-height:0;display:flex;align-items:center;gap:.9rem;overflow:hidden;white-space:nowrap;
font-size:1.3rem;font-size:min(1.3rem,10.4cqh);color:var(--dim);animation:slide .5s ease both}
#feed li b{color:var(--tx)}
.tag{flex:none;width:1rem;height:1rem;border-radius:.3rem}.tag.a{background:var(--ac)}
.tag.b{background:var(--b)}
.empty{position:absolute;left:1.6rem;top:3.6rem;font-size:1.4rem;color:var(--mute)}
.closebox{position:fixed;right:2.4rem;bottom:.6rem;display:flex;align-items:center;gap:1rem;font-size:1.2rem}
.closebox span{color:#FF9AA8}
.closebox button{padding:.45rem 1.5rem;border-radius:999px;border:2px solid var(--bad);
background:rgba(255,93,115,.08);
color:#FF9AA8;font:inherit;font-size:1.25rem;font-weight:700;cursor:pointer}
.closebox button:hover{background:rgba(255,93,115,.2)}
.closebox button:focus-visible{outline:3px solid #fff;outline-offset:3px}
.closebox button[disabled]{opacity:.5;cursor:default}
.has-close .low{margin-bottom:2.2rem}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(47,224,163,.6)}
70%,100%{box-shadow:0 0 0 .8rem rgba(47,224,163,0)}}
@keyframes slide{from{opacity:0;transform:translateY(-.9rem)}to{opacity:1;transform:none}}
@media (max-width:899px),(max-height:480px){
html{font-size:14px}body{height:auto;min-height:100vh;overflow:auto;padding:1rem}
.hd{height:auto;flex-wrap:wrap;gap:.6rem}.hd-r{flex-wrap:wrap;gap:.8rem}
.grid{grid-template-columns:minmax(0,1fr)}.low{grid-template-columns:minmax(0,1fr)}.left{order:2}
.qr{max-width:24rem}.url{font-size:min(2.2rem,calc(24rem/(var(--n)*.66)))}.right{grid-template-rows:none}
.fun,#feed{container-type:normal;grid-template-rows:none;gap:.7rem}
.ctr{padding:.8rem 1rem}.ctr b{font-size:2.8rem}.ctr span{font-size:1rem;letter-spacing:.05em}
.has-close .low{margin-bottom:0}.closebox{position:static;margin-top:1rem}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
"""

_SCREEN_BODY = """</style></head>
<body class="__BODYCLASS__">
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><symbol id="crown"
viewBox="0 0 24 24"><path
d="M3 19h18l1.2-12.5-5.2 4.3L12 3.5 7 10.8 1.8 6.5z"/></symbol></svg>
<header class="hd"><div class="brand"><i class="logo"></i><span>
<b>__BRAND__</b> &middot; Room __CODE__</span></div>
<div class="hd-r"><span class="pill" id="pill">__PILL__</span>
<noscript><span class="pill">Turn on JavaScript for live results</span></noscript>
<span class="conn" id="conn" role="status" aria-live="polite"><i class="dot"></i><span
id="conn-t">Live</span></span>
</div></header>
<main class="grid">
<aside class="left">
<div class="qr" role="img" aria-label="QR code for __JOINURL__">__QR__</div>
<p class="url" style="--n:__URLLEN__">__JOINDISPLAY__</p>
<p class="cap">Scan to play</p>
</aside>
<section class="right">
<h1 class="title" style="--tn:__TITLELEN__">__HEADING__</h1>
<div class="counters">
<div class="ctr" style="--c:var(--info)"><b id="n-scans">0</b><span>Scans</span></div>
<div class="ctr" style="--c:var(--act)"><b id="n-votes">0</b><span>Votes</span></div>
<div class="ctr" style="--c:var(--ok)"><b id="n-onb">0</b><span>Onboarded</span></div>
</div>
<div class="panel race" aria-live="polite">
<div class="rw" id="rw-a"><div class="rt"><div class="rn"><svg class="cr" aria-hidden="true"><use
href="#crown"/></svg>
<i class="td" style="background:__COLORA__"></i><span>A__NAMEA__</span></div>
<div class="rv"><span id="v-a">0</span><small id="p-a">0%</small></div></div>
<div class="trk"><div class="fl fa" id="f-a"></div></div></div>
<div class="rw" id="rw-b"><div class="rt"><div class="rn"><svg class="cr" aria-hidden="true"><use
href="#crown"/></svg>
<i class="td" style="background:__COLORB__"></i><span>B__NAMEB__</span></div>
<div class="rv"><span id="v-b">0</span><small id="p-b">0%</small></div></div>
<div class="trk"><div class="fl fb" id="f-b"></div></div></div>
</div>
<div class="win" id="win" role="status" aria-live="polite"><svg aria-hidden="true"><use href="#crown"/></svg>
<span id="win-t">__WINTEXT__</span></div>
<div class="low">
<div class="panel"><div class="ph2">Funnel</div><div class="fun">
<div class="fr" style="--c:#4A3A9E"><span>Views</span><div class="ft"><div class="ff" id="fn-views"></div>
</div><b>0</b></div>
<div class="fr" style="--c:#6048D6"><span>Engage</span><div class="ft"><div class="ff" id="fn-engage"></div>
</div><b>0</b></div>
<div class="fr" style="--c:#7C5CFF"><span>Click</span><div class="ft"><div class="ff" id="fn-click"></div>
</div><b>0</b></div>
<div class="fr" style="--c:#A592FF"><span>Onboard</span><div class="ft"><div class="ff" id="fn-onboard">
</div></div><b>0</b></div>
</div></div>
<div class="panel"><div class="ph2">Live votes</div><ul id="feed"></ul>
<p class="empty" id="empty">Waiting for the first vote&hellip;</p></div>
</div>
</section>
</main>
__CLOSEBOX__
<script>
(function(){
"use strict";
var CODE=__CODE_JS__,TOKEN=__TOKEN_JS__,NAMES=__NAMES_JS__,
S={status:__STATUS_JS__,scans:0,votes:{a:0,b:0},onboarded:0,
funnel:{views:0,engage:0,click:0,onboard:0},winner:{choice:null,theme:null,share:0},recent:[]},
RM=!!(window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches),
inflight=false,fails=0,timer=0,seeded=false,nodes=[];
function $(i){return document.getElementById(i)}
function api(p){return"/api/rooms/"+encodeURIComponent(CODE)+"/"+p}
function num(v){v=+v;return v>0?v:0}
function fmt(n){return Math.round(n).toLocaleString("en-AU")}
function tween(el,to){
if(el._to===to)return;
var from=el._v||0;el._to=to;cancelAnimationFrame(el._raf);
if(RM||from===to){el._v=to;el.textContent=fmt(to);return}
var t0=performance.now();
(function step(t){
var k=Math.min(1,(t-t0)/400),e=1-Math.pow(1-k,3);
el._v=from+(to-from)*e;el.textContent=fmt(el._v);
if(k<1)el._raf=requestAnimationFrame(step);else el._v=to})(t0)}
function name(c){return NAMES[c]||"Post "+c.toUpperCase()}
function setConn(ok){
$("conn").className=ok?"conn":"conn bad";$("conn-t").textContent=ok?"Live":"Reconnecting\\u2026"}
function renderRace(){
var a=S.votes.a,b=S.votes.b,t=a+b,pa=t?Math.round(a/t*100):0,pb=t?100-pa:0;
tween($("v-a"),a);tween($("v-b"),b);
$("p-a").textContent=pa+"%";$("p-b").textContent=pb+"%";
$("f-a").style.width=(t?a/t*100:0)+"%";$("f-b").style.width=(t?b/t*100:0)+"%";
$("rw-a").className="rw"+(a>b?" lead":"");$("rw-b").className="rw"+(b>a?" lead":"")}
function renderWin(){
var a=S.votes.a,b=S.votes.b,t=a+b,closed=S.status==="closed",w=$("win"),x=$("win-t"),cls="win",txt;
if(!t){txt=closed?(seeded?"Voting closed \\u00b7 no votes were cast":"Voting closed"):"No votes yet"}
else if(a===b){txt="It\\u2019s a tie \\u00b7 "+Math.round(a/t*100)+"% each";if(closed)cls+=" done"}
else{
var c=a>b?"a":"b",pct=Math.round(Math.max(a,b)/t*100),th=name(c);
if(closed){
var wn=S.winner||{};
if(wn.choice){c=wn.choice;th=wn.theme||name(c);if(wn.share)pct=Math.round(wn.share*100)}
txt="Winner: "+th+" \\u00b7 "+pct+"% of the room";cls+=" done"}
else{txt="Leading: "+th+" ("+pct+"%)";cls+=" lead"}}
w.className=cls;if(x.textContent!==txt)x.textContent=txt}
function renderFunnel(){
var f=S.funnel,k=["views","engage","click","onboard"],mx=1,i;
for(i=0;i<4;i++)mx=Math.max(mx,num(f[k[i]]));
for(i=0;i<4;i++){
var el=$("fn-"+k[i]),v=num(f[k[i]]);
el.style.width=Math.max(4,v/mx*100)+"%";el.parentNode.nextElementSibling.textContent=fmt(v)}}
function ago(n){
var s=n.base+(performance.now()-n.t0)/1000;
return s<2?"just now":s<60?Math.floor(s)+" s ago":Math.floor(s/60)+" min ago"}
function tick(){for(var i=0;i<nodes.length;i++){var t=ago(nodes[i]);
if(nodes[i].tx.textContent!==t)nodes[i].tx.textContent=t}}
function mk(key,c,anim){
var li=document.createElement("li"),tg=document.createElement("i"),sp=document.createElement("span"),
b=document.createElement("b"),tm=document.createElement("span");
tg.className="tag "+c;b.textContent=c.toUpperCase();
sp.appendChild(document.createTextNode("someone picked "));sp.appendChild(b);
sp.appendChild(document.createTextNode(" \\u00b7 "));sp.appendChild(tm);
li.appendChild(tg);li.appendChild(sp);
if(!anim)li.style.animation="none";
return{key:key,el:li,tx:tm,base:0,t0:0}}
function renderFeed(){
var list=(S.recent||[]).slice(0,8),seen={},old={},next=[],feed=$("feed"),now=performance.now(),i;
for(i=0;i<nodes.length;i++)old[nodes[i].key]=nodes[i];
for(i=0;i<list.length;i++){
var r=list[i],c=r.choice==="b"?"b":"a",k0=(r.at||"")+"|"+c,k=k0,j=1;
while(seen[k])k=k0+"#"+(j++);
seen[k]=1;
var n=old[k]||mk(k,c,seeded);
n.base=num(r.ago);n.t0=now;next.push(n)}
for(i=0;i<nodes.length;i++)if(!seen[nodes[i].key])feed.removeChild(nodes[i].el);
for(i=0;i<next.length;i++){
if(feed.children[i]!==next[i].el)feed.insertBefore(next[i].el,feed.children[i]||null)}
nodes=next;$("empty").hidden=nodes.length>0;tick()}
function render(){
var closed=S.status==="closed";
document.body.classList.toggle("closed",closed);
$("pill").textContent=closed?"Voting closed":"Voting open";
tween($("n-scans"),num(S.scans));tween($("n-votes"),S.votes.a+S.votes.b);tween($("n-onb"),num(S.onboarded));
renderRace();renderWin();renderFunnel();renderFeed();
var cb=$("closebox");if(closed&&cb)cb.parentNode.removeChild(cb)}
function apply(d){
if(!d||typeof d!=="object")return;
if(d.status)S.status=d.status==="closed"?"closed":"open";
S.scans=num(d.scans);S.onboarded=num(d.onboarded);
if(d.votes)S.votes={a:num(d.votes.a),b:num(d.votes.b)};
if(d.funnel)S.funnel={views:num(d.funnel.views),engage:num(d.funnel.engage),click:num(d.funnel.click),
onboard:num(d.funnel.onboard)};
if(d.winner)S.winner=d.winner;
S.recent=d.recent instanceof Array?d.recent:[];
render();seeded=true}
function poll(){
clearTimeout(timer);
if(document.hidden||inflight)return;
inflight=true;
var ctl=window.AbortController?new AbortController():null,
to=setTimeout(function(){if(ctl)ctl.abort()},5000);
fetch(api("stats"),{cache:"no-store",signal:ctl?ctl.signal:undefined})
.then(function(r){if(!r.ok)throw 0;return r.json()})
.then(function(d){fails=0;setConn(true);apply(d)})
.catch(function(){fails++;setConn(false)})
.then(function(){clearTimeout(to);inflight=false;
timer=setTimeout(poll,fails?Math.min(8000,1000*Math.pow(2,fails)):1000)})}
document.addEventListener("visibilitychange",function(){if(!document.hidden){poll();tick()}});
(function loopTick(){tick();setTimeout(loopTick,1000)})();
__CLOSEJS__
render();poll();
})();
</script></body></html>"""

_CLOSEJS = r"""var btn=$("close");
if(btn){btn.addEventListener("click",function(){
if(!window.confirm("Close voting for everyone? This cannot be undone."))return;
var err=$("close-err");err.textContent="";btn.disabled=true;
fetch(api("close"),{method:"POST",headers:{Authorization:"Bearer "+TOKEN}})
.then(function(r){if(!r.ok)throw 0;return r.json()})
.then(function(d){d.status="closed";apply(d)})
.catch(function(){btn.disabled=false;err.textContent="Could not close voting. Try again."})})}"""

_CLOSEBOX = (
    '<div class="closebox" id="closebox"><span id="close-err" role="alert"></span>'
    '<button type="button" id="close">Close voting</button></div>'
)


def render_screen_page(*, app_name: str, code: str, title: str, variants: list[dict], status: str,
                       join_url: str, join_url_display: str, qr_svg: str, token: str | None) -> str:
    """The big-screen page (`GET /room/{code}`): QR, live counters, funnel, A/B race, feed, winner."""
    by = _variant_map(variants)
    closed = status == "closed"
    has_close = token is not None and not closed
    classes = [c for c, on in (("closed", closed), ("has-close", has_close)) if on]
    names = {c: str(by[c].get("theme") or "").strip() for c in ("a", "b")}
    heading = (title or "").strip() or _DEFAULT_TITLE
    return _fill(
        _HEAD + _SCREEN_CSS.replace("__FONT__", _FONT).replace("__MONO__", _MONO) + _SCREEN_BODY,
        TITLE=_e(f"{app_name} · Room {code} · Big screen"),
        BODYCLASS=" ".join(classes),
        BRAND=_e(app_name),
        CODE=_e(code),
        PILL="Voting closed" if closed else "Voting open",
        JOINURL=_e(join_url),
        QR=qr_svg,
        URLLEN=str(max(len(join_url_display), 8)),
        JOINDISPLAY=_e(join_url_display),
        HEADING=_e(heading),
        TITLELEN=str(max(len(heading), 1)),
        COLORA=_color(by["a"].get("theme_color")),
        COLORB=_color(by["b"].get("theme_color")),
        NAMEA=_e(f" · {names['a']}" if names["a"] else ""),
        NAMEB=_e(f" · {names['b']}" if names["b"] else ""),
        WINTEXT="Voting closed" if closed else "No votes yet",
        CLOSEBOX=_CLOSEBOX if has_close else "",
        CLOSEJS=_CLOSEJS if has_close else "",
        CODE_JS=_js(code),
        TOKEN_JS=_js(token if has_close else None),
        NAMES_JS=_js(names),
        STATUS_JS=_js("closed" if closed else "open"),
    )


# ---------------------------------------------------------------------------------------------------------
# 404
# ---------------------------------------------------------------------------------------------------------

_NOT_FOUND = """</style></head><body>
<main><div class="mark"><i class="logo"></i></div>
<h1>We can&rsquo;t find room __CODE__</h1>
<p>That room doesn&rsquo;t exist or has ended. Check the code on the big screen and scan the QR code
again.</p>
<p class="brand">__BRAND__</p></main></body></html>"""

_NOT_FOUND_CSS = """
*{box-sizing:border-box;margin:0}
html{background:#0B0F1A}
body{min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:#0B0F1A;color:#F4F6FF;
font:16px/1.5 __FONT__;text-align:center;overflow-wrap:anywhere}
main{max-width:420px}
.logo{display:block;width:56px;height:56px;margin:0 auto 20px;border-radius:16px;
background:linear-gradient(135deg,#7C5CFF,#FF5C8A)}
h1{font-size:26px;line-height:1.2;font-weight:800;letter-spacing:-.5px;margin-bottom:10px}
p{color:#B3BBD8;font-size:16px}.brand{margin-top:28px;font-size:14px;color:#8E97B8}
"""


def render_not_found(*, app_name: str, code: str) -> str:
    """A small friendly 404 page in the same theme."""
    return _fill(
        _HEAD + _NOT_FOUND_CSS.replace("__FONT__", _FONT) + _NOT_FOUND,
        TITLE=_e(f"Room not found · {app_name}"),
        CODE=_e(code),
        BRAND=_e(app_name),
    )

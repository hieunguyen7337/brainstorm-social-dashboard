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
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#0B0F1A;--dim:#475069}
@media (prefers-color-scheme:dark){:root{--bg:#0B0F1A;--fg:#f4f6ff;--dim:#a9b1c9}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
gap:3vmin;padding:3vmin;background:var(--bg);color:var(--fg);font-family:system-ui,sans-serif;text-align:center}
h1{margin:0;font-size:clamp(28px,6vmin,72px);line-height:1.1}
.qr-box{width:70vmin;height:70vmin;max-width:100%;background:#fff;border-radius:3vmin;padding:1.5vmin}
.qr-box svg{width:100%;height:100%;display:block}
ol{margin:0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:1vmin 3vmin;justify-content:center;
font-size:clamp(16px,3vmin,34px);color:var(--dim)}
a{color:inherit;font-size:clamp(14px,2.4vmin,26px)}
</style></head><body>
<h1>Scan to install Pulse on Android</h1>
<div class="qr-box" role="img" aria-label="QR code to download Pulse for Android">__QR__</div>
<ol><li>1. Scan</li><li>2. Tap Download</li><li>3. Open the file and allow the install</li></ol>
<a href="/download/android">No camera? Download the Android app here</a>
</body></html>"""


def install_page(url: str) -> str:
    return _PAGE.replace("__QR__", qr_svg(url))

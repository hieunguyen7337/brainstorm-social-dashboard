"""A post as a 1080x1080 JPEG "card", so the phone can post to Instagram without picking a photo."""

import io
import re

from PIL import Image, ImageDraw, ImageFont

SIZE = 1080
MARGIN = 90


def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "DejaVuSans-Bold.ttf", "arialbd.ttf"):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def _clean(text: str) -> str:
    text = re.sub(r"https?://\S+", "", text or "")
    text = re.sub(r"(^|\s)#\w+", " ", text)
    text = " ".join(text.split())
    return text[:220].rstrip() + ("…" if len(text) > 220 else "")


def _wrap(draw: ImageDraw.ImageDraw, text: str, font, width: int) -> list[str]:
    lines: list[str] = []
    line = ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if draw.textlength(trial, font=font) <= width or not line:
            line = trial
        else:
            lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def render_card(text: str, brand: str | None = None) -> bytes:
    corners = Image.new("RGB", (2, 2))
    corners.putdata([(40, 26, 90), (82, 31, 85), (82, 31, 85), (124, 36, 80)])  # violet-to-pink diagonal
    img = corners.resize((SIZE, SIZE), Image.BILINEAR)
    draw = ImageDraw.Draw(img)
    body = _clean(text) or (brand or "Pulse")
    width = SIZE - 2 * MARGIN
    for size in (76, 66, 58, 50, 44, 38):
        font = _font(size)
        lines = _wrap(draw, body, font, width)
        if len(lines) * size * 1.25 <= SIZE - 2 * MARGIN - 120:
            break
    y = (SIZE - len(lines) * size * 1.25) / 2 - 30
    for line in lines:
        draw.text((MARGIN, y), line, font=font, fill="#f4f6ff")
        y += size * 1.25
    draw.rounded_rectangle((MARGIN, SIZE - MARGIN - 50, MARGIN + 50, SIZE - MARGIN), 14, fill="#ff5c8a")
    draw.text((MARGIN + 70, SIZE - MARGIN - 44), (brand or "Pulse")[:40], font=_font(36), fill="#f4f6ff")
    out = io.BytesIO()
    img.save(out, "JPEG", quality=88)
    return out.getvalue()

"""Writing-style learning from uploaded files: POST/DELETE /api/workspace/style and its use in prompts."""

import base64
import io
import zipfile
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.config import settings
from app.db import connect
from app.services import ai, style

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 24
JPEG = b"\xff\xd8\xff\xe0" + b"0" * 24
MB = 1024 * 1024


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def file_(name: str, data: bytes, media_type: str = "") -> dict:
    return {"name": name, "media_type": media_type, "data_base64": b64(data)}


def md(name: str = "post.md", text: str = "I write short, warm posts. No buzzwords. Ever.") -> dict:
    return file_(name, text.encode(), "text/markdown")


def reading(summary="Warm, plain-spoken.", traits=("Short sentences", "No buzzwords"), examples=("No buzzwords.",)):
    return style.StyleReading(summary=summary, traits=list(traits), examples=list(examples))


def make_docx(*paragraphs: str, xml_extra: str = "", pad: int = 0) -> bytes:
    body = "".join(f"<w:p><w:r><w:t>{p}</w:t></w:r></w:p>" for p in paragraphs)
    xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'{xml_extra}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{body}{'a' * pad}</w:body></w:document>"
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("word/document.xml", xml)
    return buf.getvalue()


def make_pdf(text: str) -> bytes:
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET"
    objs = [
        "<</Type/Catalog/Pages 2 0 R>>",
        "<</Type/Pages/Kids[3 0 R]/Count 1>>",
        "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
        f"<</Length {len(stream)}>>\nstream\n{stream}\nendstream",
        "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    ]
    out = b"%PDF-1.4\n"
    offsets = []
    for i, obj in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n{obj}\nendobj\n".encode()
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    out += "".join(f"{off:010d} 00000 n \n" for off in offsets).encode()
    out += f"trailer\n<</Size {len(objs) + 1}/Root 1 0 R>>\nstartxref\n{xref}\n%%EOF\n".encode()
    return out


def blank_pdf() -> bytes:
    from pypdf import PdfWriter

    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def claude(monkeypatch, parsed=None, *, stop_reason="end_turn", exc=None, key="sk-ant-test-key") -> list[dict]:
    """Fakes the Anthropic client and the key; returns the kwargs of every messages.parse call."""
    calls: list[dict] = []

    def parse(**kwargs):
        calls.append(kwargs)
        if exc is not None:
            raise exc
        return SimpleNamespace(
            parsed_output=parsed if parsed is not None else reading(),
            stop_reason=stop_reason,
            usage=SimpleNamespace(input_tokens=900, output_tokens=200),
        )

    monkeypatch.setattr(style, "get_client", lambda: SimpleNamespace(messages=SimpleNamespace(parse=parse)))
    monkeypatch.setattr(settings, "anthropic_api_key", key)
    return calls


def texts(call: dict) -> list[str]:
    return [b["text"] for b in call["messages"][0]["content"] if b["type"] == "text"]


def post(auth, **body):
    client, headers, _ = auth
    return client.post("/api/workspace/style", json=body, headers=headers)


def workspace(auth) -> dict:
    client, headers, _ = auth
    return client.get("/api/workspace", headers=headers).json()


def usage_purposes() -> list[str]:
    conn = connect(settings.database_path)
    try:
        return [r[0] for r in conn.execute("SELECT purpose FROM ai_usage ORDER BY ts, id")]
    finally:
        conn.close()


def ws_row(ws_id: str):
    conn = connect(settings.database_path)
    return conn, conn.execute("SELECT * FROM workspaces WHERE id = ?", (ws_id,)).fetchone()


# ---------------------------------------------------------------------------------------------------------
# Learning
# ---------------------------------------------------------------------------------------------------------


def test_new_workspace_has_no_style(auth):
    assert auth[2]["writing_style"] is None
    assert workspace(auth)["writing_style"] is None


def test_learn_from_a_file_saves_and_shows_the_style(auth, monkeypatch):
    calls = claude(monkeypatch)
    r = post(auth, files=[md()])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["skipped"] == []
    assert body["style"]["summary"] == "Warm, plain-spoken."
    assert body["style"]["traits"] == ["Short sentences", "No buzzwords"]
    assert body["style"]["sources"] == ["post.md"]
    assert body["style"]["file_count"] == 1
    assert body["style"]["sample_chars"] > 0
    assert workspace(auth)["writing_style"]["summary"] == "Warm, plain-spoken."
    assert len(calls) == 1
    assert any('<sample name="post.md">' in t and "No buzzwords. Ever." in t for t in texts(calls[0]))
    assert calls[0]["output_config"] == {"effort": "low"}
    assert usage_purposes() == ["style"]


def test_second_batch_refines_the_profile_and_accumulates(auth, monkeypatch):
    calls = claude(monkeypatch, reading(traits=["Short sentences", "Opens with a question"]))
    assert post(auth, files=[md("a.md")]).status_code == 200
    calls = claude(monkeypatch, reading(summary="Warm and curious.", traits=["Asks questions"]))
    r = post(auth, files=[md("b.md"), md("a.md")], text="A pasted line of my own writing, for the record.")
    assert r.status_code == 200, r.text
    first = texts(calls[0])[0]
    assert "Current style profile" in first and "Opens with a question" in first  # the old profile goes in
    style_ = r.json()["style"]
    assert style_["summary"] == "Warm and curious."
    assert style_["file_count"] == 1 + 3  # a.md once before, then b.md, a.md and the pasted text
    # pasted text goes first within a batch; a re-uploaded a.md moves to the newest end, with no duplicate
    assert style_["sources"] == ["pasted text", "b.md", "a.md"]
    assert usage_purposes() == ["style", "style"]


def test_pasted_text_alone(auth, monkeypatch):
    claude(monkeypatch)
    r = post(auth, text="Hey team. Quick update: we shipped it. Go try it.")
    assert r.status_code == 200, r.text
    assert r.json()["style"]["sources"] == ["pasted text"]


def test_docx_and_pdf_are_read_as_text(auth, monkeypatch):
    calls = claude(monkeypatch)
    r = post(
        auth,
        files=[
            file_("essay.docx", make_docx("First paragraph of my essay.", "Second one, same voice."), ""),
            file_("memo.pdf", make_pdf("Short punchy sentences win every single day."), "application/pdf"),
        ],
    )
    assert r.status_code == 200, r.text
    assert r.json()["skipped"] == []
    joined = "\n".join(texts(calls[0]))
    assert "First paragraph of my essay.\nSecond one, same voice." in joined
    assert "Short punchy sentences win every single day." in joined
    assert r.json()["style"]["sources"] == ["essay.docx", "memo.pdf"]


def test_unreadable_files_are_skipped_and_the_rest_still_learns(auth, monkeypatch):
    claude(monkeypatch)
    entity = '<!DOCTYPE d [<!ENTITY a "b">]>'
    r = post(
        auth,
        files=[
            file_("scan.pdf", blank_pdf(), "application/pdf"),
            file_("evil.docx", make_docx("Some text that is long enough.", xml_extra=entity)),
            file_("bomb.docx", make_docx("Some text that is long enough.", pad=9 * MB)),
            file_("junk.txt", bytes(range(256)) * 20),
            file_("fake.png", b"not an image at all"),
            md("good.md"),
        ],
    )
    assert r.status_code == 200, r.text
    skipped = {s["name"]: s["reason"] for s in r.json()["skipped"]}
    assert set(skipped) == {"scan.pdf", "evil.docx", "bomb.docx", "junk.txt", "fake.png"}
    assert "no text" in skipped["scan.pdf"]
    assert r.json()["style"]["sources"] == ["good.md"]


def test_images_become_image_blocks_with_the_type_read_from_the_bytes(auth, monkeypatch):
    calls = claude(monkeypatch)
    r = post(auth, files=[file_("shot.jpg", PNG, "image/jpeg"), file_("two.png", JPEG, "image/png")])
    assert r.status_code == 200, r.text
    images = [b for b in calls[0]["messages"][0]["content"] if b["type"] == "image"]
    assert [i["source"]["media_type"] for i in images] == ["image/png", "image/jpeg"]
    assert images[0]["source"]["data"] == b64(PNG)
    assert r.json()["style"]["sample_chars"] == 0  # screenshots carry no extracted text


def test_text_is_capped_per_file(auth, monkeypatch):
    calls = claude(monkeypatch)
    post(auth, files=[md(text="word " * 5000)])
    sample = next(t for t in texts(calls[0]) if t.startswith("<sample"))
    assert style.PER_SAMPLE_CHARS - 10 < len(sample) < style.PER_SAMPLE_CHARS + 60


def test_the_answer_is_clipped_and_cleaned(auth, monkeypatch):
    long = "x" * 1000
    parsed = SimpleNamespace(
        summary=" Calm.\n\nDirect. " + long,
        traits=["a\nb", "a\nb", "", *[f"trait {i}" for i in range(12)], long],
        examples=[long, "ok", "ok", "three", "four"],
    )
    claude(monkeypatch, parsed)
    s = post(auth, files=[md()]).json()["style"]
    assert "\n" not in s["summary"] and len(s["summary"]) <= style.MAX_SUMMARY
    assert len(s["traits"]) == style.MAX_TRAITS and s["traits"][0] == "a b" and s["traits"].count("a b") == 1
    assert all(len(t) <= style.MAX_TRAIT for t in s["traits"])
    assert s["examples"] == ["x" * style.MAX_EXAMPLE, "ok", "three"]


# ---------------------------------------------------------------------------------------------------------
# Bad uploads (no AI is spent on any of these)
# ---------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("files", "text", "status"),
    [
        ([file_("data.csv", b"a,b\n1,2", "text/csv")], "", 415),
        ([file_("big.txt", b"a" * (5 * MB + 1))], "", 413),
        ([file_(f"f{i}.txt", b"a" * (4 * MB)) for i in range(4)], "", 413),  # 16 MB in one batch
        ([{"name": "x.txt", "media_type": "", "data_base64": "***not base64***"}], "", 422),
        ([file_("empty.txt", b"")], "", 422),
        ([md(f"f{i}.md") for i in range(11)], "", 422),  # more than 10 files in one request
        ([], "", 422),  # nothing at all
        ([], "   ", 422),
        ([file_("scan.pdf", blank_pdf())], "", 422),  # accepted, but nothing readable in the whole batch
    ],
)
def test_bad_uploads_are_refused_without_spending_ai(auth, monkeypatch, files, text, status):
    calls = claude(monkeypatch)
    r = post(auth, files=files, text=text)
    assert r.status_code == status, r.text
    assert calls == [] and usage_purposes() == []
    assert workspace(auth)["writing_style"] is None


# ---------------------------------------------------------------------------------------------------------
# AI unavailable, busy, forgetting
# ---------------------------------------------------------------------------------------------------------


def test_no_key_is_a_friendly_503_and_the_client_is_never_called(auth, monkeypatch):
    calls = claude(monkeypatch, key="")
    r = post(auth, files=[md()])
    assert r.status_code == 503
    assert "needs the AI" in r.json()["detail"]
    assert calls == []


def test_a_refusal_is_a_503_whose_usage_is_still_recorded(auth, monkeypatch):
    claude(monkeypatch, stop_reason="refusal")
    assert post(auth, files=[md()]).status_code == 503
    assert usage_purposes() == ["style"]  # it cost tokens
    assert workspace(auth)["writing_style"] is None


def test_an_unparseable_answer_is_a_503_and_costs_nothing(auth, monkeypatch):
    try:
        style.StyleReading.model_validate_json('{"summary": "cut off"')
    except ValidationError as exc:
        claude(monkeypatch, exc=exc)
    assert post(auth, files=[md()]).status_code == 503
    assert usage_purposes() == []


def test_an_empty_profile_is_a_503_and_keeps_the_old_one(auth, monkeypatch):
    claude(monkeypatch)
    assert post(auth, files=[md()]).status_code == 200
    claude(monkeypatch, SimpleNamespace(summary="", traits=[], examples=[]))
    assert post(auth, files=[md("b.md")]).status_code == 503
    assert workspace(auth)["writing_style"]["summary"] == "Warm, plain-spoken."


def test_a_second_learn_while_one_is_running_is_a_409(auth, monkeypatch):
    calls = claude(monkeypatch)
    assert style.acquire(auth[2]["id"])
    try:
        r = post(auth, files=[md()])
    finally:
        style.release(auth[2]["id"])
    assert r.status_code == 409 and calls == []
    assert post(auth, files=[md()]).status_code == 200  # released: works again


def test_per_workspace_style_budget_is_separate_from_generate(auth, monkeypatch):
    claude(monkeypatch)
    monkeypatch.setattr(settings, "ai_workspace_limit", 2)
    assert post(auth, files=[md()]).status_code == 200
    assert post(auth, files=[md()]).status_code == 200
    assert post(auth, files=[md()]).status_code == 503  # style budget used up
    assert auth[0].get("/api/ai/usage", headers=auth[1]).json()["workspace_used"] == 0  # generate untouched


def test_forget_clears_the_style(auth, monkeypatch):
    claude(monkeypatch)
    post(auth, files=[md()])
    client, headers, _ = auth
    assert client.delete("/api/workspace/style", headers=headers).json() == {"ok": True}
    assert workspace(auth)["writing_style"] is None
    assert client.delete("/api/workspace/style", headers=headers).json() == {"ok": True}  # nothing to forget is fine


def test_style_needs_a_workspace_token(client):
    assert client.post("/api/workspace/style", json={"text": "hello there, this is me"}).status_code in (401, 403)
    assert client.delete("/api/workspace/style").status_code in (401, 403)


# ---------------------------------------------------------------------------------------------------------
# It reaches every generation prompt
# ---------------------------------------------------------------------------------------------------------


def test_build_prompt_includes_the_learned_style_only_when_there_is_one(auth, monkeypatch):
    ws_id = auth[2]["id"]
    conn, row = ws_row(ws_id)
    before = ai.build_prompt(row, ["linkedin"], None, None, "", "")
    conn.close()
    assert "Writing style" not in before

    claude(monkeypatch, reading(traits=["Short sentences", "Dry humour"], examples=["No buzzwords.", "Ship it."]))
    post(auth, files=[md()])
    conn, row = ws_row(ws_id)
    after = ai.build_prompt(row, ["linkedin"], None, None, "", "")
    conn.close()
    assert "Writing style" in after and "- Dry humour" in after and '"No buzzwords." | "Ship it."' in after
    assert "match the voice, not the topics" in after
    assert after.index("Writing style") < after.index("Write one variant")


def test_a_corrupt_stored_style_reads_as_none_and_breaks_nothing(auth):
    ws_id = auth[2]["id"]
    conn, _ = ws_row(ws_id)
    conn.execute("UPDATE workspaces SET writing_style = ? WHERE id = ?", ("{not json", ws_id))
    conn.commit()
    row = conn.execute("SELECT * FROM workspaces WHERE id = ?", (ws_id,)).fetchone()
    assert workspace(auth)["writing_style"] is None
    assert "Writing style" not in ai.build_prompt(row, ["x"], None, None, "", "")
    conn.close()

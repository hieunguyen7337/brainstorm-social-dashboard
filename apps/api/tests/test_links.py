def _published(client, h):
    return next(p for p in client.get("/api/posts?status=published", headers=h).json())


def test_click_and_convert_update_dashboard(auth):
    client, h, _ = auth
    post = _published(client, h)
    code = post["link_code"]
    before = client.get("/api/dashboard", headers=h).json()
    r = client.get(f"/r/{code}", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == f"/l/{code}"
    assert client.post(f"/api/links/{code}/convert").json() == {"ok": True}
    after = client.get("/api/dashboard", headers=h).json()
    assert after["real_clicks"] == 1 and after["real_conversions"] == 1
    assert after["totals"]["clicks"] >= before["totals"]["clicks"] + 1
    assert after["totals"]["conversions"] >= before["totals"]["conversions"] + 1
    p2 = next(p for p in client.get("/api/posts", headers=h).json() if p["id"] == post["id"])
    assert p2["clicks"] >= post["clicks"] + 1 and p2["conversions"] >= post["conversions"] + 1
    acts = client.get("/api/activity", headers=h).json()
    assert {a["type"] for a in acts if a["real"]} == {"click", "conversion"}


def test_unknown_code_404(client):
    assert client.get("/r/zzzzzz", follow_redirects=False).status_code == 404
    assert client.get("/l/zzzzzz").status_code == 404
    assert client.post("/api/links/zzzzzz/convert").status_code == 404


def test_landing_page_html_escaped(client):
    r = client.post("/api/workspaces", json={"brand_name": "<script>alert(1)</script>"}).json()
    h = {"Authorization": f"Bearer {r['token']}"}
    code = client.get("/api/posts", headers=h).json()[0]["link_code"]
    page = client.get(f"/l/{code}")
    assert page.status_code == 200 and "text/html" in page.headers["content-type"]
    assert "<script>alert(1)</script>" not in page.text
    assert "&lt;script&gt;" in page.text and "Get started" in page.text
    assert f"/api/links/'+\"{code}\"+'/convert" in page.text

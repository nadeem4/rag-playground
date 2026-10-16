"""The hosted demo's rules for files that are not PDFs, and for URL documents.

PDFs keep their own rules (10 MB, 20 pages, 41 inches a side), pinned in
test_demo.py. Every other format has a lower byte cap; a Word or PowerPoint
file is a zip, so its unzipped size and its member count are capped too; an
image is capped by bytes and pixels. A URL counts as an upload, and each
visitor may ask for only a few fetches an hour, failed ones included.
"""

from __future__ import annotations

import io
import zipfile

import pytest

from playground.backend import demo
from tests.api.conftest import build_pdf, make_client
from tests.api.test_demo import _pdf_with_pages, demo_on

MB = 1024 * 1024


@pytest.fixture
def server():
    from test_fetch import Server

    s = Server()
    yield s
    s.stop()


@pytest.fixture
def on_demo(client, monkeypatch):
    """The demo, with the visitor cookie minted."""
    demo_on(monkeypatch)
    client.get("/api/settings/app")
    return client


@pytest.fixture
def local_fetches(monkeypatch):
    """Let the demo fetch from this machine: a test page server is not public.
    Only the address guard is lifted; every other demo rule stays."""
    monkeypatch.setattr(demo, "public_endpoints_only", lambda: False)


def zipped(members: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for name, data in members.items():
            z.writestr(name, data)
    return buf.getvalue()


def docx_bytes() -> bytes:
    return zipped({"[Content_Types].xml": b"<Types/>", "word/document.xml": b"<w:document>Hello</w:document>"})


def png_bytes(width: int = 40, height: int = 20, mode: str = "RGB") -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new(mode, (width, height)).save(buf, format="PNG")
    return buf.getvalue()


def post(client, name: str, data: bytes, content_type: str = "application/octet-stream"):
    return client.post("/api/v2/documents", files={"file": (name, data, content_type)})


def add_url(client, url: str):
    return client.post("/api/v2/documents/url", json={"url": url})


# --- formats on the demo -----------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "make"),
    [
        ("notes.docx", docx_bytes),
        ("page.html", lambda: b"<html><body><p>Hi</p></body></html>"),
        ("readme.md", lambda: b"# Title\n\nSome text."),
        ("notes.txt", lambda: b"just text"),
        ("scan.png", png_bytes),
    ],
)
def test_the_demo_takes_each_readable_format_within_its_caps(on_demo, name, make):
    r = post(on_demo, name, make())
    assert r.status_code == 200, r.text
    assert r.json()["filename"] == name


@pytest.mark.parametrize(
    ("name", "data"), [("notes.docx", None), ("notes.txt", b"just text"), ("scan.png", None)]
)
def test_locally_the_same_formats_are_taken(client, name, data):
    data = data or (docx_bytes() if name.endswith(".docx") else png_bytes())
    assert post(client, name, data).status_code == 200


def test_a_spreadsheet_is_415_on_the_demo_and_locally(client, monkeypatch):
    r = post(client, "budget.xlsx", zipped({"xl/workbook.xml": b"<x/>"}))
    assert r.status_code == 415
    assert r.json()["detail"] == (
        "This server reads PDF, Word, PowerPoint, HTML, Markdown, text, PNG and JPG files, "
        "and this file is not one of them."
    )
    demo_on(monkeypatch)
    client.get("/api/settings/app")
    assert post(client, "budget.xlsx", b"x").status_code == 415


def test_a_file_that_is_not_a_pdf_has_a_lower_byte_cap(on_demo):
    r = post(on_demo, "long.txt", b"a" * (2 * MB + 1))
    assert r.status_code == 413
    assert r.json()["detail"] == (
        "This file is 2.0 MB. The hosted demo takes Word, PowerPoint, HTML, Markdown and text "
        "files up to 2 MB. Run the playground locally for larger files."
    )
    assert post(on_demo, "fits.txt", b"a" * (2 * MB)).status_code == 200


def test_a_pdf_keeps_its_own_cap_and_page_check(on_demo):
    assert post(on_demo, "three-mb.pdf", _pdf_with_pages(1) + b"%" + b"0" * (3 * MB)).status_code == 200
    r = post(on_demo, "long.pdf", _pdf_with_pages(21), "application/pdf")
    assert r.status_code == 413 and r.json()["detail"].startswith("This PDF has 21 pages.")


def test_a_file_named_pdf_that_is_not_one_is_415(on_demo):
    r = post(on_demo, "fake.pdf", b"not a pdf at all", "application/pdf")
    assert r.status_code == 415
    assert r.json()["detail"] == "This file is named as a PDF, but it cannot be read as one."


def test_a_word_zip_bomb_is_413(on_demo):
    bomb = zipped({"[Content_Types].xml": b"<Types/>", "word/document.xml": b"\0" * (60 * MB)})
    assert len(bomb) < 2 * MB
    r = post(on_demo, "bomb.docx", bomb)
    assert r.status_code == 413
    assert r.json()["detail"] == (
        "This Word or PowerPoint file unpacks to more than 50 MB. "
        "The hosted demo takes files that unpack to 50 MB or less. Run the playground locally for larger files."
    )
    assert on_demo.get("/api/v2/documents").json() == []


def test_a_word_file_with_too_many_parts_is_413(on_demo):
    many = zipped({f"word/media/{i}.xml": b"x" for i in range(1001)})
    r = post(on_demo, "many.pptx", many)
    assert r.status_code == 413
    assert r.json()["detail"] == (
        "This Word or PowerPoint file has more than 1,000 parts. "
        "The hosted demo takes files with up to 1,000. Run the playground locally for larger files."
    )


def test_a_word_file_that_is_not_a_zip_is_415(on_demo):
    r = post(on_demo, "broken.docx", b"not a zip")
    assert r.status_code == 415
    assert r.json()["detail"] == "This file is named as a Word or PowerPoint file, but it cannot be opened as one."


def test_an_image_over_the_pixel_cap_is_413(on_demo):
    big = png_bytes(5000, 5000, mode="1")  # 25 million pixels, a few kilobytes
    r = post(on_demo, "huge.png", big)
    assert r.status_code == 413
    assert r.json()["detail"] == (
        "This image is 5000 by 5000 pixels. The hosted demo reads images of up to 20 million pixels, "
        "because each one is read with OCR. Run the playground locally for larger images."
    )


def test_an_image_over_the_byte_cap_is_413(on_demo):
    r = post(on_demo, "big.jpg", b"\xff\xd8" + b"0" * (5 * MB))
    assert r.status_code == 413
    assert r.json()["detail"].startswith("This file is 5.0 MB. The hosted demo takes images up to 5 MB.")


def test_an_image_that_cannot_be_opened_is_415(on_demo):
    r = post(on_demo, "broken.png", b"\x89PNG not really")
    assert r.status_code == 415
    assert r.json()["detail"] == "This file is named as an image, but it cannot be opened as one."


def test_the_page_routes_are_415_for_a_file_that_is_not_a_pdf(on_demo):
    sha = post(on_demo, "notes.txt", b"just text").json()["sha"]
    assert on_demo.get(f"/api/v2/documents/{sha}/pages").status_code == 415
    assert on_demo.get(f"/api/v2/documents/{sha}/pages/1").status_code == 415
    assert on_demo.get(f"/api/v2/documents/{sha}/pages/1/find", params={"text": "just"}).status_code == 415


# --- URL documents on the demo -----------------------------------------------------


def test_the_demo_fetches_https_on_port_443_only(on_demo):
    r = add_url(on_demo, "http://example.com/report.pdf")
    assert r.status_code == 403
    assert r.json()["detail"] == "Only https addresses on port 443 are fetched here."
    r = add_url(on_demo, "https://127.0.0.1/report.pdf")
    assert r.status_code == 403
    assert r.json()["detail"] == "That address is not on the public internet, so it was not fetched."


def test_a_url_document_is_kept_and_is_this_browsers_own(on_demo, dirs, server, local_fetches):
    data = build_pdf([["A page from the web."]])
    server.page("/paper.pdf", data, "application/pdf")
    url = server.url("/paper.pdf")
    body = add_url(on_demo, url).json()
    assert body["filename"] == "paper.pdf" and body["origin_url"] == url
    assert [d["sha"] for d in on_demo.get("/api/v2/documents").json()] == [body["sha"]]
    with make_client(dirs) as someone_else:
        someone_else.get("/api/settings/app")
        assert someone_else.get("/api/v2/documents").json() == []


def test_a_word_zip_bomb_from_a_url_is_413(on_demo, server, local_fetches):
    bomb = zipped({"[Content_Types].xml": b"<Types/>", "word/document.xml": b"\0" * (60 * MB)})
    server.page(
        "/bomb.docx", bomb, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )
    r = add_url(on_demo, server.url("/bomb.docx"))
    assert r.status_code == 413
    assert r.json()["detail"].startswith("This Word or PowerPoint file unpacks to more than 50 MB.")


def test_a_url_page_over_the_demo_cap_is_413(on_demo, server, local_fetches):
    server.page("/big.html", b"<p>" + b"x" * (10 * MB) + b"</p>", "text/html")
    r = add_url(on_demo, server.url("/big.html"))
    assert r.status_code == 413
    assert r.json()["detail"] == "The page is larger than the limit of 10,485,760 bytes, so it was not fetched."


def test_a_url_counts_toward_the_three_uploads_a_browser(on_demo, server, local_fetches):
    for i in range(2):
        assert post(on_demo, f"f{i}.pdf", _pdf_with_pages(i + 1), "application/pdf").status_code == 200
    server.page("/third.txt", b"the third document", "text/plain")
    server.page("/fourth.txt", b"the fourth document", "text/plain")
    assert add_url(on_demo, server.url("/third.txt")).status_code == 200
    full = "This browser already has 3 uploads. Wait for one to expire, or run the playground locally."
    r = post(on_demo, "f3.pdf", _pdf_with_pages(4), "application/pdf")
    assert r.status_code == 429 and r.json()["detail"] == full
    before = len(server.agents)
    r = add_url(on_demo, server.url("/fourth.txt"))
    assert r.status_code == 429 and r.json()["detail"] == full
    assert len(server.agents) == before  # refused before anything is fetched


def test_each_browser_has_a_few_fetches_an_hour_and_failed_ones_count(on_demo, dirs):
    for _ in range(demo.MAX_FETCHES_PER_HOUR):
        assert add_url(on_demo, "https://127.0.0.1/nothing.pdf").status_code == 403
    r = add_url(on_demo, "https://example.com/report.pdf")
    assert r.status_code == 429
    assert r.json()["detail"] == (
        "This browser has asked for 10 links in the last hour. Wait a while, or run the playground locally."
    )
    with make_client(dirs) as someone_else:
        someone_else.get("/api/settings/app")
        assert add_url(someone_else, "https://127.0.0.1/nothing.pdf").status_code == 403


def test_the_fetch_limit_frees_up_after_an_hour(on_demo, monkeypatch):
    from playground.backend import policy

    now = [1000.0]
    monkeypatch.setattr(policy, "_clock", lambda: now[0])
    for _ in range(demo.MAX_FETCHES_PER_HOUR):
        add_url(on_demo, "https://127.0.0.1/nothing.pdf")
    assert add_url(on_demo, "https://127.0.0.1/nothing.pdf").status_code == 429
    now[0] += 3601
    assert add_url(on_demo, "https://127.0.0.1/nothing.pdf").status_code == 403


def test_locally_a_url_is_not_rate_limited_and_any_address_is_fetched(client, server):
    server.page("/a.txt", b"local text", "text/plain")
    for _ in range(demo.MAX_FETCHES_PER_HOUR + 1):
        assert add_url(client, server.url("/a.txt")).status_code == 200


def test_the_demo_limits_name_the_new_caps(client, monkeypatch):
    demo_on(monkeypatch)
    limits = client.get("/api/settings/app").json()["limits"]
    assert limits["max_other_bytes"] == 2 * MB
    assert limits["max_image_bytes"] == 5 * MB
    assert limits["max_image_pixels"] == 20_000_000
    assert limits["max_fetches_per_hour"] == 10

"""I-9: PDF pages of an uploaded source, rendered and searched with pdfium."""

from __future__ import annotations

import struct

from tests.api.conftest import upload_pdf
from tests.plugins.conftest import SAMPLE_PAGES, build_paragraph_pdf

W, H = 612.0, 792.0  # the generated fixture's MediaBox


def png_size(data: bytes) -> tuple[int, int]:
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    assert data[12:16] == b"IHDR"
    return struct.unpack(">II", data[16:24])


def upload_bytes(client, data: bytes, name: str = "doc.pdf") -> str:
    r = client.post("/api/sources", files={"file": (name, data, "application/pdf")})
    assert r.status_code == 200, r.text
    return r.json()["sha"]


def find(client, sha, n, text):
    r = client.get(f"/api/sources/{sha}/pages/{n}/find", params={"text": text})
    assert r.status_code == 200, r.text
    return r.json()


def inside_page(rect) -> bool:
    l, b, r, t = rect
    return 0 <= l < r <= W and 0 <= b < t <= H


def test_pages_lists_sizes_in_points(client):
    sha = upload_pdf(client)["sha"]
    r = client.get(f"/api/sources/{sha}/pages")
    assert r.status_code == 200
    assert r.json() == [
        {"n": i, "width": W, "height": H} for i in range(1, len(SAMPLE_PAGES) + 1)
    ]


def test_unknown_sha_is_404(client):
    sha = "0" * 64
    assert client.get(f"/api/sources/{sha}/pages").status_code == 404
    assert client.get(f"/api/sources/{sha}/pages/1.png").status_code == 404
    r = client.get(f"/api/sources/{sha}/pages/1/find", params={"text": "x"})
    assert r.status_code == 404


def test_malformed_sha_is_404(client):
    assert client.get("/api/sources/..%2F..%2Fetc/pages").status_code == 404
    assert client.get("/api/sources/abc/pages").status_code == 404


def test_out_of_range_page_is_404(client):
    sha = upload_pdf(client)["sha"]
    for n in (0, 4, 99):
        assert client.get(f"/api/sources/{sha}/pages/{n}.png").status_code == 404
        r = client.get(f"/api/sources/{sha}/pages/{n}/find", params={"text": "Paris"})
        assert r.status_code == 404


def test_png_at_scale_2(client):
    sha = upload_pdf(client)["sha"]
    r = client.get(f"/api/sources/{sha}/pages/1.png", params={"scale": 2})
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert "max-age" in r.headers["cache-control"]
    assert png_size(r.content) == (1224, 1584)


def test_png_default_scale_is_1(client):
    sha = upload_pdf(client)["sha"]
    r = client.get(f"/api/sources/{sha}/pages/2.png")
    assert png_size(r.content) == (612, 792)


def test_png_bad_scale_is_422(client):
    sha = upload_pdf(client)["sha"]
    assert client.get(f"/api/sources/{sha}/pages/1.png?scale=0").status_code == 422
    assert client.get(f"/api/sources/{sha}/pages/1.png?scale=50").status_code == 422


def test_source_file_is_not_locked_after_rendering(client, dirs):
    # Opened from bytes, so no handle outlives the request (Windows locks).
    sha = upload_pdf(client)["sha"]
    client.get(f"/api/sources/{sha}/pages/1.png")
    find(client, sha, 1, "Paris")
    path = dirs["sources"] / f"{sha}.pdf"
    path.unlink()
    assert not path.exists()


def test_find_exact_sentence(client):
    sha = upload_pdf(client)["sha"]
    out = find(client, sha, 1, "The capital of France is Paris.")
    assert out["matched"] == "exact"
    assert len(out["rects"]) == 1
    assert inside_page(out["rects"][0])
    # the first line sits near the top: y grows upwards from the page bottom
    assert out["rects"][0][1] > H / 2


def test_find_is_page_scoped(client):
    sha = upload_pdf(client)["sha"]
    assert find(client, sha, 2, "The capital of France")["matched"] == "none"
    assert find(client, sha, 2, "Chunking splits")["matched"] == "exact"


def test_find_across_two_lines_gives_one_rect_per_line(client):
    sha = upload_pdf(client)["sha"]
    out = find(client, sha, 1, "is Paris. Lyon is renowned")
    assert out["matched"] in ("exact", "normalized")
    assert len(out["rects"]) == 2
    first, second = out["rects"]
    assert all(inside_page(r) for r in out["rects"])
    assert first[1] > second[3] - 1  # the second line is below the first


def test_find_normalized_handles_hyphenation_and_whitespace(client):
    data = build_paragraph_pdf(
        [[["Retrieval aug-", "mented generation grounds answers."]]]
    )
    sha = upload_bytes(client, data)
    out = find(client, sha, 1, "retrieval   augmented\ngeneration")
    assert out["matched"] == "normalized"
    assert len(out["rects"]) == 2
    assert all(inside_page(r) for r in out["rects"])


def test_find_normalized_handles_parser_line_breaks(client):
    # a parser may give the hyphen and the newline back verbatim
    data = build_paragraph_pdf(
        [[["Retrieval aug-", "mented generation grounds answers."]]]
    )
    sha = upload_bytes(client, data)
    out = find(client, sha, 1, "aug-\nmented generation")
    assert out["matched"] == "normalized"
    assert len(out["rects"]) == 2


def test_find_nothing(client):
    sha = upload_pdf(client)["sha"]
    assert find(client, sha, 1, "not on this page at all") == {
        "rects": [],
        "matched": "none",
    }


def test_find_requires_text(client):
    sha = upload_pdf(client)["sha"]
    assert client.get(f"/api/sources/{sha}/pages/1/find").status_code == 422
    r = client.get(f"/api/sources/{sha}/pages/1/find", params={"text": ""})
    assert r.status_code == 422


def test_non_pdf_source_is_415(client):
    r = client.post("/api/sources", files={"file": ("a.txt", b"hello", "text/plain")})
    sha = r.json()["sha"]
    assert client.get(f"/api/sources/{sha}/pages").status_code == 415

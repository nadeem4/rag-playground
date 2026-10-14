"""A document's file and pages: sizes, renders and text search."""

from concurrent.futures import ThreadPoolExecutor

from apihelpers import make_client, upload
from pandion_api import Policy
from pandion_api.pages import MAX_FIND_CHARS
from pdfs import SAMPLE_PAGES, build_pdf


def test_the_file_comes_back_byte_for_byte_and_is_never_cached(client):
    sha = upload(client)["sha"]
    r = client.get(f"/documents/{sha}/file")
    assert r.content == build_pdf(SAMPLE_PAGES)
    assert r.headers["content-type"] == "application/pdf"
    assert r.headers["cache-control"] == "private, no-store"


def test_pages_list_their_sizes_in_points(client):
    sha = upload(client)["sha"]
    pages = client.get(f"/documents/{sha}/pages").json()
    assert [p["n"] for p in pages] == [1, 2, 3]
    assert all(p["width"] > 0 and p["height"] > 0 for p in pages)


def test_a_page_renders_as_png_and_may_be_cached(client):
    sha = upload(client)["sha"]
    r = client.get(f"/documents/{sha}/pages/1", params={"scale": 2})
    assert r.status_code == 200 and r.content[:8] == b"\x89PNG\r\n\x1a\n"
    assert r.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert client.get(f"/documents/{sha}/pages/9").status_code == 404
    assert client.get(f"/documents/{sha}/pages/1", params={"scale": 0}).status_code == 422


def test_find_gives_the_rects_of_a_sentence(client):
    sha = upload(client)["sha"]
    body = client.get(f"/documents/{sha}/pages/1/find", params={"text": "The capital of France is Paris."}).json()
    assert body["matched"] == "exact" and body["rects"]
    assert client.get(f"/documents/{sha}/pages/2/find", params={"text": "Paris"}).json()["matched"] == "none"


def test_an_unknown_or_malformed_id_is_404(client):
    for sha in ("0" * 64, "nope"):
        assert client.get(f"/documents/{sha}/file").status_code == 404
        assert client.get(f"/documents/{sha}/pages").status_code == 404


def test_a_file_that_is_not_a_pdf_is_415(client):
    sha = client.post("/documents", files={"file": ("a.txt", b"hello", "text/plain")}).json()["sha"]
    assert client.get(f"/documents/{sha}/pages").status_code == 415


def test_the_policy_hides_a_document_and_makes_pages_private(tmp_path):
    class Private(Policy):
        def private(self, sha, request):
            return True

        def can_read(self, sha, request):
            return request.headers.get("x-allowed") == "yes"

    with make_client(tmp_path, Private()) as c:
        sha = upload(c)["sha"]
        assert c.get(f"/documents/{sha}/pages").status_code == 404
        r = c.get(f"/documents/{sha}/pages/1", headers={"X-Allowed": "yes"})
        assert r.headers["cache-control"] == "private, max-age=31536000, immutable"


def test_many_renders_at_once_all_succeed(client):
    sha = upload(client)["sha"]
    with ThreadPoolExecutor(8) as pool:
        codes = list(pool.map(lambda n: client.get(f"/documents/{sha}/pages/{n % 3 + 1}").status_code, range(24)))
    assert codes == [200] * 24


# --- the request's own values are checked ------------------------------------------


def test_an_unreadable_document_is_answered_exactly_like_a_missing_one(tmp_path):
    class Nobody(Policy):
        def can_read(self, sha, request):
            return False

    with make_client(tmp_path, Nobody()) as c:
        sha = upload(c)["sha"]
        missing = "0" * 64
        for tail in ("file", "pages", "pages/1", "pages/1/find?text=Paris"):
            hidden = c.get(f"/documents/{sha}/{tail}")
            absent = c.get(f"/documents/{missing}/{tail}")
            assert hidden.status_code == absent.status_code == 404
            assert hidden.json()["detail"].replace(sha, missing) == absent.json()["detail"]


def test_a_page_number_out_of_range_is_a_plain_4xx(client):
    sha = upload(client)["sha"]
    for n in ("0", "-1", "4", "99999999999999999999999"):
        assert client.get(f"/documents/{sha}/pages/{n}").status_code == 404
        assert client.get(f"/documents/{sha}/pages/{n}/find", params={"text": "Paris"}).status_code == 404
    assert client.get(f"/documents/{sha}/pages/one").status_code == 422
    for scale in ("nan", "inf", "-1", "8.5"):
        assert client.get(f"/documents/{sha}/pages/1", params={"scale": scale}).status_code == 422


def test_find_text_is_required_and_capped(client):
    sha = upload(client)["sha"]
    assert client.get(f"/documents/{sha}/pages/1/find").status_code == 422
    assert client.get(f"/documents/{sha}/pages/1/find", params={"text": ""}).status_code == 422
    too_long = "x" * (MAX_FIND_CHARS + 1)
    assert client.get(f"/documents/{sha}/pages/1/find", params={"text": too_long}).status_code == 422
    at_cap = client.get(f"/documents/{sha}/pages/1/find", params={"text": "x" * MAX_FIND_CHARS})
    assert at_cap.status_code == 200 and at_cap.json()["matched"] == "none"

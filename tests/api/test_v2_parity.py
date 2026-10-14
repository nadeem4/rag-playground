"""Today's API tests, run again on pandion-api's routes (/api/v2).

The playground serves both stacks until part 5 moves the web: the old routes
under /api, and pandion-api with PlaygroundPolicy under /api/v2. Every test
imported below is one of today's, unchanged. Here its client sends each
request to the /api/v2 twin of its path (`to_v2`), so every upload limit,
privacy rule and 403 is proven to hold on the new routes exactly as on the
old. A request with no twin (a run takes a graph; samples, lessons and the
app settings stay the playground's own) goes to the old route as it did.
"""

from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient

from api.deps import build_deps
from api.main import create_app
from tests.api import (
    conftest,
    test_delete_source,
    test_demo,
    test_pages,
    test_runs,
    test_source_file,
    test_sources,
)

#: (pattern, replacement): the first that matches wins; None keeps the path.
REWRITES: tuple[tuple[re.Pattern[str], str | None], ...] = (
    (re.compile(r"^/api/sources/sample$"), None),
    (re.compile(r"^/api/sources/([^/?]+)/pages/(\d+)\.png(?=\?|$)"), r"/api/v2/documents/\1/pages/\2"),
    (re.compile(r"^/api/sources(?=/|\?|$)"), "/api/v2/documents"),
    (re.compile(r"^/api/settings/llm(?=/|\?|$)"), "/api/v2/settings/models"),
    (re.compile(r"^/api/cache$"), "/api/v2/cache"),
    (re.compile(r"^/api/artifacts(?=/|$)"), "/api/v2/results"),
    (re.compile(r"^/api/trace$"), "/api/v2/trace"),
    # A run is started on the old route (it takes a graph); its state, events
    # and cancel are read on the twin, from the one shared run manager.
    (re.compile(r"^/api/runs/(?=[^/?]+)"), "/api/v2/runs/"),
)


def to_v2(url: str) -> str:
    for pattern, replacement in REWRITES:
        if pattern.search(url):
            return url if replacement is None else pattern.sub(replacement, url, count=1)
    return url


#: The scheme and host of an absolute URL: TestClient.request makes every URL
#: absolute before it reaches build_request; a streamed request stays relative.
ORIGIN = re.compile(r"^[a-z][a-z0-9+.-]*://[^/]+", re.IGNORECASE)


class V2Client(TestClient):
    """A test client that sends each request to its /api/v2 twin."""

    def build_request(self, method, url, *args, **kwargs):
        text = str(url)
        origin = ORIGIN.match(text)
        head, path = (origin.group(0), text[origin.end():]) if origin else ("", text)
        return super().build_request(method, head + to_v2(path), *args, **kwargs)


def make_v2_client(dirs, registry=None) -> TestClient:
    deps = build_deps(
        artifacts_dir=dirs["artifacts"],
        sources_dir=dirs["sources"],
        web_dist=dirs["web"],
        registry=registry,
    )
    return V2Client(create_app(deps))


#: The modules whose tests run here: each looks up `make_client` at call time.
MODULES = (conftest, test_delete_source, test_demo, test_pages, test_runs, test_source_file, test_sources)


@pytest.fixture(autouse=True)
def on_v2(monkeypatch):
    for module in MODULES:
        if hasattr(module, "make_client"):
            monkeypatch.setattr(module, "make_client", make_v2_client)


@pytest.fixture
def client(dirs):
    with make_v2_client(dirs) as c:
        yield c


def test_each_old_path_has_its_twin():
    sha = "a" * 64
    assert to_v2("/api/sources") == "/api/v2/documents"
    assert to_v2(f"/api/sources/{sha}") == f"/api/v2/documents/{sha}"
    assert to_v2(f"/api/sources/{sha}/pages/2.png?scale=1.5") == f"/api/v2/documents/{sha}/pages/2?scale=1.5"
    assert to_v2(f"/api/sources/{sha}/pages/2/find") == f"/api/v2/documents/{sha}/pages/2/find"
    assert to_v2("/api/sources/sample") == "/api/sources/sample"
    assert to_v2("/api/settings/llm/check") == "/api/v2/settings/models/check"
    assert to_v2("/api/settings/app") == "/api/settings/app"
    assert to_v2(f"/api/artifacts/{sha}/payload") == f"/api/v2/results/{sha}/payload"
    assert to_v2("/api/runs") == "/api/runs"
    assert to_v2("/api/runs/abc") == "/api/v2/runs/abc"
    assert to_v2("/api/runs/abc/events?last_event_id=2") == "/api/v2/runs/abc/events?last_event_id=2"
    assert to_v2("/api/runs/abc/cancel") == "/api/v2/runs/abc/cancel"
    assert to_v2("/api/sweeps") == "/api/sweeps"


def test_the_client_really_sends_requests_to_v2(client):
    r = client.get("/api/sources")
    assert r.request.url.path == "/api/v2/documents"
    with client.stream("GET", "/api/sources") as streamed:
        assert streamed.request.url.path == "/api/v2/documents"


def test_both_stacks_hold_the_same_record_lock():
    from api.routes import sources
    from pandion_api.documents import SIDECAR_LOCK

    assert sources.SIDECAR_LOCK is SIDECAR_LOCK


def test_both_stacks_hold_the_same_pdfium_lock():
    from api.routes import pages
    from pandion_api.pages import PDFIUM_LOCK

    assert pages.PDFIUM_LOCK is PDFIUM_LOCK


def test_both_stacks_cap_the_find_text(dirs):
    from fastapi.testclient import TestClient as Plain

    from pandion_api.pages import MAX_FIND_CHARS
    from tests.api.conftest import upload_pdf

    deps = build_deps(artifacts_dir=dirs["artifacts"], sources_dir=dirs["sources"], web_dist=dirs["web"])
    with Plain(create_app(deps)) as c:
        sha = upload_pdf(c)["sha"]
        for base in ("/api/sources", "/api/v2/documents"):
            url = f"{base}/{sha}/pages/1/find"
            assert c.get(url, params={"text": "x" * (MAX_FIND_CHARS + 1)}).status_code == 422
            assert c.get(url, params={"text": "x" * MAX_FIND_CHARS}).status_code == 200


# --- documents (Task 7) -----------------------------------------------------------

from tests.api.test_sources import (  # noqa: E402
    test_distinct_bytes_distinct_sha,
    test_empty_upload_is_400,
    test_list_sources,
    test_upload_is_content_addressed,
    test_upload_is_idempotent,
    test_uploaded_file_is_findable_by_the_upload_transform,
)
from tests.api.test_demo import (  # noqa: E402
    test_a_local_run_takes_a_large_page,
    test_demo_caps_live_uploads_per_visitor_and_a_reupload_does_not_count,
    test_demo_never_reads_more_than_the_cap_plus_one_byte,
    test_demo_refuses_a_file_over_10_mb,
    test_demo_refuses_a_non_pdf,
    test_demo_refuses_a_page_over_3000_points_a_side_with_a_plain_sentence,
    test_demo_refuses_more_than_20_pages,
    test_demo_upload_tolerates_a_corrupt_sidecar,
    test_list_shows_the_samples_and_only_your_own_uploads,
    test_outside_demo_mode_nothing_is_capped,
    test_uploading_a_samples_bytes_does_not_count_toward_the_cap,
)
from tests.api.test_delete_source import (  # noqa: E402
    test_a_file_two_visitors_uploaded_stays_for_the_other,
    test_a_malformed_sha_is_404,
    test_a_sample_in_the_list_has_no_upload_time,
    test_demo_deletes_your_own_upload_and_its_record,
    test_demo_refuses_another_visitors_upload,
    test_demo_refuses_to_delete_a_sample,
    test_demo_refuses_without_a_visitor_id,
    test_locally_a_delete_also_removes_the_question_set_beside_it,
    test_locally_a_sample_is_refused,
    test_locally_any_upload_can_be_deleted,
    test_the_list_gives_each_upload_its_upload_time,
    test_the_list_never_shows_the_visitor_ids,
    test_the_sources_list_is_never_cached,
)
from tests.api.test_sources import test_a_name_ending_in_part_is_refused  # noqa: E402


# --- only on /api/v2: the same bytes are stored once, whatever their name ------------


def test_a_samples_bytes_under_new_names_store_no_new_file(client, dirs, monkeypatch):
    from api import sample_set

    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    client.get("/api/settings/app")
    sample = sample_set.default_sample()
    before = sorted(p.name for p in dirs["sources"].iterdir() if p.is_file())
    for name in ("s.a", "s.b", "s.c"):
        r = client.post("/api/sources", files={"file": (name, sample.pdf.read_bytes(), "application/pdf")})
        assert r.request.url.path == "/api/v2/documents"
        assert r.status_code == 200 and r.json()["sha"] == sample.sha
    assert sorted(p.name for p in dirs["sources"].iterdir() if p.is_file()) == before


def test_your_own_reupload_under_another_name_stores_no_second_copy(client, dirs, monkeypatch):
    from tests.api.test_demo import _pdf_with_pages

    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    client.get("/api/settings/app")
    data = _pdf_with_pages(1)
    sha = client.post("/api/sources", files={"file": ("mine.pdf", data, "application/pdf")}).json()["sha"]
    assert client.post("/api/sources", files={"file": ("mine-again.bin", data, "application/pdf")}).status_code == 200
    assert [p.name for p in dirs["sources"].glob(f"{sha}*") if p.is_file()] == [f"{sha}.pdf"]


# --- a document's file and pages (Task 8) -----------------------------------------

from tests.api.test_pages import (  # noqa: E402
    test_a_huge_page_at_scale_8_is_clamped_to_25_megapixels,
    test_find_across_two_lines_gives_one_rect_per_line,
    test_find_exact_sentence,
    test_find_is_page_scoped,
    test_find_normalized_handles_hyphenation_and_whitespace,
    test_find_normalized_handles_parser_line_breaks,
    test_find_nothing,
    test_find_requires_text,
    test_in_demo_mode_an_uploads_pages_are_cached_privately,
    test_many_renders_at_once_all_succeed,
    test_malformed_sha_is_404,
    test_non_pdf_source_is_415,
    test_out_of_range_page_is_404,
    test_pages_lists_sizes_in_points,
    test_png_at_scale_2,
    test_png_bad_scale_is_422,
    test_png_default_scale_is_1,
    test_source_file_is_not_locked_after_rendering,
    test_unknown_sha_is_404,
)
from tests.api.test_source_file import (  # noqa: E402
    test_an_unknown_or_malformed_sha_is_404,
    test_demo_never_serves_another_visitors_upload,
    test_demo_serves_a_sample,
    test_demo_serves_your_own_upload_privately,
    test_every_sample_is_readable_straight_after_startup,
    test_the_file_comes_back_byte_for_byte,
)
from tests.api.test_demo import (  # noqa: E402
    test_every_sample_is_readable_in_demo_mode,
    test_outside_demo_any_uploaded_sha_is_served,
    test_pages_serve_only_the_sample,
    test_the_demo_refuses_uploads_past_its_total_budget,
)


# --- a run's state, events and cancel (Task 9) --------------------------------------
# Each test starts its run on the old POST /api/runs (a graph has no /api/v2 twin;
# test_v2_runs.py covers POST /api/v2/runs) and reads it on /api/v2.

from tests.api.test_runs import (  # noqa: E402
    gates,
    test_cancel_after_finish_is_409,
    test_cancel_stops_subsequent_nodes,
    test_idle_stream_sends_heartbeat,
    test_last_event_id_header_wins_over_query_param,
    test_last_event_id_query_param_resumes_like_the_header,
    test_last_event_id_resumes_after_that_event,
    test_real_run_reaches_run_finished,
    test_snapshot,
    test_sse_headers,
    test_subscribe_after_completion_replays_full_log,
    test_two_concurrent_runs_do_not_interleave,
    test_unknown_run_is_404,
)


def test_a_run_is_read_on_v2(client):
    from tests.api.test_runs import start

    src = conftest.upload_pdf(client)
    run_id = start(client, conftest.ingest_graph(src["sha"], src["filename"]))
    r = client.get(f"/api/runs/{run_id}")
    assert r.request.url.path == f"/api/v2/runs/{run_id}" and "result" in r.json()

"""POST /runs: an index run, one card or the whole index, and its events, cancel and keys."""

import json
import threading
from types import SimpleNamespace

from fastapi import Request

from apihelpers import PIPELINE, finish, make_client, read_events, upload
from pandion import IndexPipeline, StageResult
from pandion_api import Policy
from pandion_api.credentials import PROVIDERS
from pandion_api.routes.documents import NO_SUCH_DOCUMENT
from pdfs import build_pdf


def index(client, sha, **extra):
    return finish(client, client.post("/runs", json={"config": PIPELINE, "documents": [sha], **extra}))


def test_an_index_run_reports_every_step_with_its_result_id(client):
    sha = upload(client)["sha"]
    state, events = index(client, sha)
    assert state["kind"] == "index" and state["status"] == "finished" and state["ok"] is True
    steps = state["result"]["documents"]["report.pdf"]
    assert list(steps) == ["source", "parse", "chunk"]
    assert all(s["status"] == "executed" and len(s["result_id"]) == 64 for s in steps.values())
    assert state["result"]["index"]["strategy"] == "lancedb"
    assert events[-1]["event"] == "stream_end"
    finished = [e for e in events if e["event"] == "node_finished"]
    assert {"document": "report.pdf", "step": "chunk"} in [{"document": e["document"], "step": e["step"]} for e in finished]


def test_through_runs_one_card(client):
    sha = upload(client)["sha"]
    state, _ = index(client, sha, through="parse")
    assert list(state["result"]["documents"]["report.pdf"]) == ["source", "parse"]
    assert state["result"]["index"] is None


def test_a_second_run_is_read_from_the_cache_and_force_runs_it_again(client):
    sha = upload(client)["sha"]
    index(client, sha)
    again, _ = index(client, sha)
    assert {s["status"] for s in again["result"]["documents"]["report.pdf"].values()} == {"cached"}
    forced, _ = index(client, sha, force=True)
    assert forced["result"]["documents"]["report.pdf"]["parse"]["status"] == "executed"


def test_a_through_that_names_no_step_is_400_before_anything_runs(client):
    sha = upload(client)["sha"]
    r = client.post("/runs", json={"config": PIPELINE, "documents": [sha], "through": "clean.3"})
    assert r.status_code == 400
    assert r.json()["detail"] == "through names the step to stop after: one of parse, clean, chunk, index, not 'clean.3'."


def test_documents_are_checked_before_anything_runs(client):
    sha = upload(client)["sha"]
    assert client.post("/runs", json={"config": PIPELINE, "documents": ["0" * 64]}).status_code == 404
    assert client.post("/runs", json={"config": PIPELINE, "documents": ["nope"]}).status_code == 404
    assert client.post("/runs", json={"config": PIPELINE, "documents": []}).status_code == 422
    other = upload(client, "report.pdf", build_pdf([["Another report."]]))["sha"]
    r = client.post("/runs", json={"config": PIPELINE, "documents": [sha, other]})
    assert r.status_code == 400 and "report.pdf" in r.json()["detail"]
    bad = {**PIPELINE, "index": {**PIPELINE["index"], "chunk": {"use": "nope"}}}
    assert client.post("/runs", json={"config": bad, "documents": [sha]}).status_code == 422


def test_an_unknown_document_gets_a_fixed_sentence_that_never_echoes_the_id(client):
    for sha in ("0" * 64, "../../etc/passwd", "a" * 64 + "\n"):
        r = client.post("/runs", json={"config": PIPELINE, "documents": [sha]})
        assert r.status_code == 404 and r.json()["detail"] == NO_SUCH_DOCUMENT


def test_a_document_the_policy_hides_is_403_with_its_sentence(tmp_path):
    class Hidden(Policy):
        not_readable = "Not for you."

        def can_read(self, sha, request):
            return False

    with make_client(tmp_path, Hidden()) as c:
        sha = upload(c)["sha"]
        r = c.post("/runs", json={"config": PIPELINE, "documents": [sha]})
    assert r.status_code == 403 and r.json()["detail"] == "Not for you."


def test_cancel_stops_a_run_between_steps(client, monkeypatch):
    started = threading.Event()

    def slow_run(self, documents, *, cancel=None, on_event=None, **kwargs):
        started.set()
        cancel.wait(5)
        on_event({"event": "run_cancelled", "ts": 0})
        return SimpleNamespace(ok=False, documents={}, index=None)

    monkeypatch.setattr(IndexPipeline, "run", slow_run)
    sha = upload(client)["sha"]
    run_id = client.post("/runs", json={"config": PIPELINE, "documents": [sha]}).json()["run_id"]
    assert started.wait(5)
    r = client.post(f"/runs/{run_id}/cancel")
    assert r.status_code == 202 and r.json()["cancel_requested"] is True
    events = read_events(client, run_id)
    assert client.get(f"/runs/{run_id}").json()["status"] == "cancelled"
    assert events[-1]["event"] == "stream_end"
    assert client.post(f"/runs/{run_id}/cancel").status_code == 409


def test_an_unknown_run_is_404(client):
    assert client.get("/runs/nope").status_code == 404
    assert client.post("/runs/nope/cancel").status_code == 404
    assert client.get("/runs/nope/events").status_code == 404


def test_every_key_is_scrubbed_from_events_and_the_result(tmp_path, monkeypatch):
    seen: dict = {}

    class Keyed(Policy):
        def credentials(self, request):
            return {"anthropic_api_key": "sk-secret-123"}

    def leaky_run(self, documents, *, credentials=None, on_event=None, **kwargs):
        seen["credentials"] = credentials
        on_event({"event": "node_failed", "ts": 0, "node_id": "x", "error": "Traceback: bad key sk-secret-123"})
        failed = StageResult(stage="parse", transform="pdfium", output=None, status="failed", error="bad key sk-secret-123")
        return SimpleNamespace(ok=False, documents={"report.pdf": SimpleNamespace(stages={"parse": failed})}, index=None)

    monkeypatch.setattr(IndexPipeline, "run", leaky_run)
    with make_client(tmp_path, Keyed()) as c:
        sha = upload(c)["sha"]
        state, events = finish(c, c.post("/runs", json={"config": PIPELINE, "documents": [sha]}))
    assert seen["credentials"] == {"anthropic_api_key": "sk-secret-123"}
    text = json.dumps([state, events])
    assert "sk-secret-123" not in text and "[redacted]" in text


def test_a_run_is_given_each_document_by_its_name_and_stored_file(client, monkeypatch):
    seen: list = []

    def spy_run(self, documents, **kwargs):
        seen.append(documents)
        return SimpleNamespace(ok=True, documents={}, index=None)

    monkeypatch.setattr(IndexPipeline, "run", spy_run)
    sha = upload(client, "my report.pdf")["sha"]
    finish(client, client.post("/runs", json={"config": PIPELINE, "documents": [sha]}))
    store = client.app.state.documents
    assert seen == [{"my report.pdf": str(store.file(sha))}]


def test_a_name_with_an_unsafe_suffix_is_given_to_pandion_without_it(client):
    """Pandion keeps its own copy as <sha><the name's suffix>; a suffix the
    store would not keep (a space, a stream colon, too long) must not reach it."""
    for name, named in (("my report.p df", "my report_p df"), ("a.pdf.p df", "a_pdf_p df")):
        data = build_pdf([[name]])
        sha = upload(client, name, data)["sha"]
        state, _ = finish(client, client.post("/runs", json={"config": PIPELINE, "documents": [sha]}))
        assert list(state["result"]["documents"]) == [named]
        folder = client.app.state.settings.data_dir / "sources"
        assert sorted(p.name for p in folder.iterdir() if p.is_file() and p.name.startswith(sha)) == [sha]


def test_a_plain_name_reaches_pandion_unchanged_so_its_result_ids_do_not_change(client):
    sha = upload(client, "report.pdf")["sha"]
    state, _ = finish(client, client.post("/runs", json={"config": PIPELINE, "documents": [sha]}))
    assert list(state["result"]["documents"]) == ["report.pdf"]
    folder = client.app.state.settings.data_dir / "sources"
    assert sorted(p.name for p in folder.iterdir() if p.is_file()) == [f"{sha}.pdf"]


# --- whose run it is, and what its errors may say ------------------------------------


class ByHeader(Policy):
    """A run belongs to whoever the X-Who header names."""

    def run_owner(self, request):
        return request.headers.get("X-Who")


def test_a_run_with_an_owner_is_404_to_anyone_else(tmp_path, monkeypatch):
    def quick_run(self, documents, **kwargs):
        return SimpleNamespace(ok=True, documents={}, index=None)

    monkeypatch.setattr(IndexPipeline, "run", quick_run)
    with make_client(tmp_path, ByHeader()) as c:
        sha = upload(c)["sha"]
        mine, theirs = {"X-Who": "ann"}, {"X-Who": "bob"}
        run_id = c.post("/runs", json={"config": PIPELINE, "documents": [sha]}, headers=mine).json()["run_id"]
        with c.stream("GET", f"/runs/{run_id}/events", headers=mine) as r:
            assert r.status_code == 200
            list(r.iter_lines())
        for headers in (theirs, {}):
            for r in (
                c.get(f"/runs/{run_id}", headers=headers),
                c.get(f"/runs/{run_id}/events", headers=headers),
                c.post(f"/runs/{run_id}/cancel", headers=headers),
            ):
                assert r.status_code == 404 and r.json()["detail"] == f"unknown run {run_id}"
        assert c.get(f"/runs/{run_id}", headers=mine).json()["status"] == "finished"


def test_by_default_a_run_has_no_owner_and_anyone_may_follow_it(client, monkeypatch):
    def quick_run(self, documents, **kwargs):
        return SimpleNamespace(ok=True, documents={}, index=None)

    monkeypatch.setattr(IndexPipeline, "run", quick_run)
    sha = upload(client)["sha"]
    run_id = client.post("/runs", json={"config": PIPELINE, "documents": [sha]}).json()["run_id"]
    read_events(client, run_id)
    assert client.app.state.runs.get(run_id).owner is None
    assert client.get(f"/runs/{run_id}", headers={"X-Who": "anyone"}).status_code == 200


class NoPaths(Policy):
    def scrub(self, text):
        return text.replace("/srv/secret", "[path]")


def test_every_error_a_run_shows_goes_through_the_policys_scrub(tmp_path, monkeypatch):
    def failing_run(self, documents, *, on_event=None, **kwargs):
        on_event({"event": "node_failed", "ts": 0, "node_id": "x", "error": "File /srv/secret/a.py, bad"})
        failed = StageResult(stage="parse", transform="pdfium", output=None, status="failed", error="at /srv/secret/b")
        return SimpleNamespace(ok=False, documents={"report.pdf": SimpleNamespace(stages={"parse": failed})}, index=None)

    monkeypatch.setattr(IndexPipeline, "run", failing_run)
    with make_client(tmp_path, NoPaths()) as c:
        sha = upload(c)["sha"]
        state, events = finish(c, c.post("/runs", json={"config": PIPELINE, "documents": [sha]}))
    text = json.dumps([state, events])
    assert "/srv/secret" not in text and "[path]/a.py" in text and "[path]/b" in text


def test_a_crash_is_scrubbed_too(tmp_path, monkeypatch):
    def crashing_run(self, documents, **kwargs):
        raise ValueError("cannot read /srv/secret/c.pdf")

    monkeypatch.setattr(IndexPipeline, "run", crashing_run)
    with make_client(tmp_path, NoPaths()) as c:
        sha = upload(c)["sha"]
        state, events = finish(c, c.post("/runs", json={"config": PIPELINE, "documents": [sha]}))
    assert state["status"] == "error"
    error = next(e for e in events if e["event"] == "run_error")["error"]
    assert "[path]/c.pdf" in error and "/srv/secret" not in json.dumps([state, events])


def request_with(headers: dict[str, str]) -> Request:
    return Request({"type": "http", "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()]})


def test_the_default_policy_takes_a_key_from_the_header_then_the_environment(monkeypatch):
    for spec in PROVIDERS.values():
        monkeypatch.delenv(spec.env_var, raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "from-env")
    request = request_with({"X-OpenAI-Api-Key": " from-header "})
    policy = Policy()
    assert policy.key("openai", request) == ("from-header", "header")
    assert policy.key("anthropic", request) == ("from-env", "env")
    assert policy.key("custom", request) == (None, "none")
    assert policy.credentials(request) == {"openai_api_key": "from-header", "anthropic_api_key": "from-env"}


def test_a_run_dropped_after_an_hour_is_404_like_one_that_never_was(client):
    sha = upload(client)["sha"]
    r = client.post("/runs", json={"config": PIPELINE, "documents": [sha], "through": "parse"})
    run_id = r.json()["run_id"]
    finish(client, r)
    manager = client.app.state.runs
    later = manager._clock() + 3601
    manager._clock = lambda: later
    for r in (client.get(f"/runs/{run_id}"), client.post(f"/runs/{run_id}/cancel"), client.get(f"/runs/{run_id}/events")):
        assert r.status_code == 404 and r.json()["detail"] == f"unknown run {run_id}"


# --- how many runs one owner may have going ---------------------------------------


class TwoEach(ByHeader):
    """Two runs going at once for each owner the X-Who header names."""

    def max_runs_per_owner(self, request):
        return 2


def test_an_owner_past_their_runs_is_refused_with_429_until_one_ends(tmp_path, monkeypatch):
    gate = threading.Event()

    def held_run(self, documents, **kwargs):
        gate.wait(5)
        return SimpleNamespace(ok=True, documents={}, index=None)

    monkeypatch.setattr(IndexPipeline, "run", held_run)
    with make_client(tmp_path, TwoEach()) as c:
        sha = upload(c)["sha"]
        body = {"config": PIPELINE, "documents": [sha]}
        ann, bob = {"X-Who": "ann"}, {"X-Who": "bob"}
        first = c.post("/runs", json=body, headers=ann)
        second = c.post("/runs", json=body, headers=ann)
        assert first.status_code == 202 and second.status_code == 202
        third = c.post("/runs", json=body, headers=ann)
        assert third.status_code == 429
        assert third.json()["detail"] == "You already have 2 runs going. Wait for one to finish, or stop one."
        # Every route that starts a run is held to it.
        asked = c.post("/ask", json={"config": PIPELINE, "question": "Why?", "documents": [sha]}, headers=ann)
        assert asked.status_code == 429
        # Another owner is not.
        theirs = c.post("/runs", json=body, headers=bob)
        assert theirs.status_code == 202
        gate.set()
        for r, who in ((first, ann), (second, ann), (theirs, bob)):
            with c.stream("GET", f"/runs/{r.json()['run_id']}/events", headers=who) as s:
                list(s.iter_lines())
        assert c.post("/runs", json=body, headers=ann).status_code == 202


def test_by_default_an_owner_may_have_any_number_of_runs(tmp_path, monkeypatch):
    monkeypatch.setattr(IndexPipeline, "run", lambda self, documents, **kw: SimpleNamespace(ok=True, documents={}, index=None))
    with make_client(tmp_path, ByHeader()) as c:
        sha = upload(c)["sha"]
        ids = [
            c.post("/runs", json={"config": PIPELINE, "documents": [sha]}, headers={"X-Who": "ann"}).json()["run_id"]
            for _ in range(4)
        ]
        for run_id in ids:
            with c.stream("GET", f"/runs/{run_id}/events", headers={"X-Who": "ann"}) as s:
                list(s.iter_lines())

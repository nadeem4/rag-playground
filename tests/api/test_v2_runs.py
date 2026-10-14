"""Runs on /api/v2 keep the playground's rules (see also test_demo.py and test_credentials.py):
only documents this browser may read, no custom endpoint on the demo, and on the
demo only the visitor's own key. A run on the demo is its visitor's own, and an
error it shows names no server folder and no key."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from api import credentials
from api.policy import DEMO_NO_CUSTOM, NOT_AVAILABLE, PlaygroundPolicy
from api.visitor import COOKIE
from pandion import IndexPipeline, StageResult
from tests.api.conftest import make_client, read_sse, upload_pdf
from tests.api.test_credentials import DOTENV_KEY, ENV_KEY, FAKE_KEY, HEADER, write_dotenv
from tests.api.test_v2_strategies import CUSTOM_CONFIGS, PIPELINE


def demo_on(monkeypatch) -> None:
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")


def test_a_run_reads_only_what_this_browser_may_read(client, dirs, monkeypatch):
    with make_client(dirs) as someone_else:
        other = upload_pdf(someone_else)
    demo_on(monkeypatch)
    r = client.post("/api/v2/runs", json={"config": PIPELINE, "documents": [other["sha"]]})
    assert r.status_code == 403 and r.json()["detail"] == NOT_AVAILABLE
    sample = client.post("/api/sources/sample").json()
    r = client.post("/api/v2/runs", json={"config": PIPELINE, "documents": [sample["sha"]], "through": "chunk"})
    assert r.status_code == 202
    events = read_sse(client, r.json()["run_id"], prefix="/api/v2")
    assert [e["event"] for e in events][-2:] == ["run_finished", "stream_end"]
    assert not any(e["event"] == "node_failed" for e in events)


def test_on_the_demo_a_run_with_a_custom_endpoint_is_refused(client, monkeypatch):
    demo_on(monkeypatch)
    sample = client.post("/api/sources/sample").json()
    for config in CUSTOM_CONFIGS.values():
        r = client.post("/api/v2/runs", json={"config": config, "documents": [sample["sha"]]})
        assert r.status_code == 403 and r.json()["detail"] == DEMO_NO_CUSTOM


def test_on_the_demo_a_run_gets_only_the_visitors_own_key(client, monkeypatch):
    seen: list = []

    def spy_run(self, documents, *, credentials=None, **kwargs):
        seen.append(credentials)
        return SimpleNamespace(ok=True, documents={}, index=None)

    monkeypatch.setattr(IndexPipeline, "run", spy_run)
    demo_on(monkeypatch)
    monkeypatch.setenv("ANTHROPIC_API_KEY", ENV_KEY)
    write_dotenv(credentials.DOTENV_PATH, DOTENV_KEY)
    sample = client.post("/api/sources/sample").json()
    body = {"config": PIPELINE, "documents": [sample["sha"]]}
    read_sse(client, client.post("/api/v2/runs", json=body).json()["run_id"], prefix="/api/v2")
    read_sse(client, client.post("/api/v2/runs", json=body, headers=HEADER).json()["run_id"], prefix="/api/v2")
    assert seen == [None, {"anthropic_api_key": FAKE_KEY}]


def test_locally_a_run_gets_the_servers_key(client, monkeypatch):
    seen: list = []

    def spy_run(self, documents, *, credentials=None, **kwargs):
        seen.append(credentials)
        return SimpleNamespace(ok=True, documents={}, index=None)

    monkeypatch.setattr(IndexPipeline, "run", spy_run)
    monkeypatch.setenv("ANTHROPIC_API_KEY", ENV_KEY)
    sha = upload_pdf(client)["sha"]
    run_id = client.post("/api/v2/runs", json={"config": PIPELINE, "documents": [sha]}).json()["run_id"]
    read_sse(client, run_id, prefix="/api/v2")
    assert seen == [{"anthropic_api_key": ENV_KEY}]


def test_locally_a_run_gets_the_key_in_dotenv_when_there_is_no_other(client, monkeypatch):
    seen: list = []

    def spy_run(self, documents, *, credentials=None, **kwargs):
        seen.append(credentials)
        return SimpleNamespace(ok=True, documents={}, index=None)

    monkeypatch.setattr(IndexPipeline, "run", spy_run)
    write_dotenv(credentials.DOTENV_PATH, DOTENV_KEY)
    sha = upload_pdf(client)["sha"]
    run_id = client.post("/api/v2/runs", json={"config": PIPELINE, "documents": [sha]}).json()["run_id"]
    read_sse(client, run_id, prefix="/api/v2")
    assert seen == [{"anthropic_api_key": DOTENV_KEY}]


# --- a run on the demo is its visitor's own ----------------------------------------


def quick_run(self, documents, **kwargs):
    return SimpleNamespace(ok=True, documents={}, index=None)


def as_visitor(client, visitor: str) -> None:
    client.cookies.clear()
    client.cookies.set(COOKIE, visitor)


def test_on_the_demo_another_visitor_cannot_see_follow_or_cancel_a_run(client, monkeypatch):
    monkeypatch.setattr(IndexPipeline, "run", quick_run)
    demo_on(monkeypatch)
    ann, bob = "ann-" + "a" * 20, "bob-" + "b" * 20
    as_visitor(client, ann)
    sample = client.post("/api/sources/sample").json()
    run_id = client.post("/api/v2/runs", json={"config": PIPELINE, "documents": [sample["sha"]]}).json()["run_id"]
    read_sse(client, run_id, prefix="/api/v2")
    as_visitor(client, bob)
    for r in (
        client.get(f"/api/v2/runs/{run_id}"),
        client.get(f"/api/v2/runs/{run_id}/events"),
        client.post(f"/api/v2/runs/{run_id}/cancel"),
    ):
        assert r.status_code == 404 and r.json()["detail"] == f"unknown run {run_id}"
    as_visitor(client, ann)
    assert client.get(f"/api/v2/runs/{run_id}").json()["status"] == "finished"


def test_locally_a_run_has_no_owner(client, monkeypatch):
    monkeypatch.setattr(IndexPipeline, "run", quick_run)
    sha = upload_pdf(client)["sha"]
    run_id = client.post("/api/v2/runs", json={"config": PIPELINE, "documents": [sha]}).json()["run_id"]
    read_sse(client, run_id, prefix="/api/v2")
    as_visitor(client, "someone-" + "c" * 20)
    assert client.get(f"/api/v2/runs/{run_id}").status_code == 200


# --- an error a run shows names no server folder and no key -------------------------


def test_a_failed_step_names_no_server_folder_and_no_key(client, dirs, monkeypatch):
    data = dirs["sources"].parent
    leak = f'File "{data / "artifacts" / "x.py"}", line 3; {data.as_posix()}/sources/a.pdf; key {FAKE_KEY}'

    def failing_run(self, documents, *, on_event=None, **kwargs):
        on_event({"event": "node_failed", "ts": 0, "node_id": "report.pdf::parse", "error": leak})
        failed = StageResult(stage="parse", transform="pdfium", output=None, status="failed", error=leak)
        return SimpleNamespace(ok=False, documents={"report.pdf": SimpleNamespace(stages={"parse": failed})}, index=None)

    monkeypatch.setattr(IndexPipeline, "run", failing_run)
    for demo in (False, True):
        if demo:
            demo_on(monkeypatch)
            sha = client.post("/api/sources/sample").json()["sha"]
        else:
            sha = upload_pdf(client)["sha"]
        r = client.post("/api/v2/runs", json={"config": PIPELINE, "documents": [sha]}, headers=HEADER)
        events = read_sse(client, r.json()["run_id"], prefix="/api/v2")
        state = client.get(f"/api/v2/runs/{r.json()['run_id']}").json()
        failed = next(e for e in events if e["event"] == "node_failed")
        text = json.dumps([state, events])
        assert FAKE_KEY not in text and str(data) not in text and data.as_posix() not in text
        assert "x.py" in failed["error"] and credentials.REDACTED in failed["error"]


def test_the_playgrounds_scrub_takes_out_server_paths_but_not_web_addresses():
    scrub = PlaygroundPolicy().scrub
    text = (
        'File "C:\\Program Files\\Python\\lib\\x.py", line 1\n'
        "  in /usr/lib/python3/site-packages/pandion/y.py\n"
        "WindowsPath('D:/data/sources/abc.pdf') and \\\\server\\share\\z.txt\n"
        "calling https://api.example.com/v1/messages failed"
    )
    out = scrub(text)
    for gone in ("Program Files", "/usr/lib", "site-packages", "D:/data", "\\\\server"):
        assert gone not in out
    for kept in ("x.py", "y.py", "abc.pdf", "z.txt", "https://api.example.com/v1/messages", "line 1"):
        assert kept in out


def test_the_data_folder_is_scrubbed_only_where_it_ends_a_path_part():
    from api.policy import SERVER_PATH, scrub_paths

    data = Path("/data").resolve()
    folder = data.as_posix()
    text = f"see https://huggingface.co/datasets/x and {folder}base, not {folder}/sources/a.pdf or '{folder}'"
    out = scrub_paths(text, data)
    assert "https://huggingface.co/datasets/x" in out
    assert "database" in out and f"{SERVER_PATH}base" not in out
    assert f"{folder}/sources" not in out and f"'{SERVER_PATH}'" in out
    assert scrub_paths(f"ends in {folder}", data).endswith(SERVER_PATH)
    for around in ("({})", "in {}.", "{}, then"):
        assert scrub_paths(around.format(folder), data) == around.format(SERVER_PATH)
    assert scrub_paths(f"{folder}-old and {folder}_2", data).count(SERVER_PATH + "-old") == 0


# --- questions (Task 10) --------------------------------------------------------------


def test_on_the_demo_a_question_with_a_custom_endpoint_is_refused(client, monkeypatch):
    demo_on(monkeypatch)
    sample = client.post("/api/sources/sample").json()
    for config in CUSTOM_CONFIGS.values():
        body = {"config": config, "documents": [sample["sha"]], "question": "What is chunking?"}
        r = client.post("/api/v2/ask", json=body)
        assert r.status_code == 403 and r.json()["detail"] == DEMO_NO_CUSTOM


def test_on_the_demo_a_question_is_its_visitors_own(client, monkeypatch):
    demo_on(monkeypatch)
    as_visitor(client, "ann-" + "a" * 20)
    sample = client.post("/api/sources/sample").json()
    body = {"config": PIPELINE, "documents": [sample["sha"]], "question": "What is chunking?", "answer": False}
    run_id = client.post("/api/v2/ask", json=body).json()["run_id"]
    read_sse(client, run_id, prefix="/api/v2")
    assert client.get(f"/api/v2/runs/{run_id}").json()["kind"] == "retrieve"
    as_visitor(client, "bob-" + "b" * 20)
    assert client.get(f"/api/v2/runs/{run_id}").status_code == 404


# --- evaluations and comparisons (Task 13) ---------------------------------------------

QUESTIONS = [{"question": "What is chunking?", "gold_answers": ["Chunking splits a document into passages."]}]


def test_on_the_demo_an_evaluation_or_a_comparison_with_a_custom_endpoint_is_refused(client, monkeypatch):
    demo_on(monkeypatch)
    sample = client.post("/api/sources/sample").json()
    documents = [sample["sha"]]
    r = client.post("/api/v2/evaluations", json={"config": CUSTOM_CONFIGS["llm_rerank"], "documents": documents, "questions": QUESTIONS})
    assert r.status_code == 403 and r.json()["detail"] == DEMO_NO_CUSTOM
    custom_reranker = CUSTOM_CONFIGS["llm_rerank"]["retrieve"]["rerank"]
    body = {"config": PIPELINE, "stage": "rerank", "variants": [[], custom_reranker], "documents": documents, "questions": QUESTIONS}
    r = client.post("/api/v2/comparisons", json=body)
    assert r.status_code == 403 and r.json()["detail"] == DEMO_NO_CUSTOM


def test_on_the_demo_a_comparison_takes_as_many_variants_as_a_sweep(client, monkeypatch):
    from api.policy import MAX_VARIANTS

    demo_on(monkeypatch)
    sample = client.post("/api/sources/sample").json()
    variants = [{"use": "recursive_character", "chunk_size": 100 + n} for n in range(MAX_VARIANTS + 1)]
    body = {"config": PIPELINE, "stage": "chunk", "variants": variants, "documents": [sample["sha"]]}
    r = client.post("/api/v2/comparisons", json=body)
    assert MAX_VARIANTS == 10 and r.status_code == 422
    assert f"at most {MAX_VARIANTS}" in r.json()["detail"]["problems"][0]


def test_on_the_demo_an_evaluation_is_its_visitors_own(client, monkeypatch):
    demo_on(monkeypatch)
    as_visitor(client, "ann-" + "a" * 20)
    sample = client.post("/api/sources/sample").json()
    body = {"config": PIPELINE, "documents": [sample["sha"]], "questions": QUESTIONS}
    run_id = client.post("/api/v2/evaluations", json=body).json()["run_id"]
    read_sse(client, run_id, prefix="/api/v2")
    assert client.get(f"/api/v2/runs/{run_id}").json()["kind"] == "evaluation"
    as_visitor(client, "bob-" + "b" * 20)
    assert client.get(f"/api/v2/runs/{run_id}").status_code == 404




# --- the demo's capacity: questions in one run, and runs going at once --------------


def test_on_the_demo_an_evaluation_asks_at_most_50_questions(client, monkeypatch):
    from api.policy import too_many_questions

    demo_on(monkeypatch)
    sample = client.post("/api/sources/sample").json()
    body = {"config": PIPELINE, "documents": [sample["sha"]], "questions": QUESTIONS * 51}
    r = client.post("/api/v2/evaluations", json=body)
    assert r.status_code == 413 and r.json()["detail"] == too_many_questions("evaluation", 51)
    assert r.json()["detail"] == (
        "The demo scores at most 50 questions in one run, and this set has 51. "
        "Use fewer questions, or run the playground locally for more."
    )
    policy = PlaygroundPolicy()
    policy.check_question_count("evaluation", 50, None)
    monkeypatch.delenv("RAG_PLAYGROUND_DEMO")
    policy.check_question_count("evaluation", 500, None)


def test_on_the_demo_a_comparison_asks_at_most_120_recipe_questions(client, monkeypatch):
    from api.policy import too_many_questions

    demo_on(monkeypatch)
    sample = client.post("/api/sources/sample").json()
    variants = [{"use": "recursive_character", "chunk_size": 100 + n} for n in range(3)]
    body = {"config": PIPELINE, "stage": "chunk", "variants": variants, "documents": [sample["sha"]], "questions": QUESTIONS * 41}
    r = client.post("/api/v2/comparisons", json=body)
    assert r.status_code == 413 and r.json()["detail"] == too_many_questions("comparison", 123)
    assert r.json()["detail"] == (
        "The demo scores at most 120 recipe-questions in one comparison (recipes times questions), "
        "and this one asks for 123. Use fewer recipes or questions, or run the playground locally for more."
    )
    policy = PlaygroundPolicy()
    # Ten recipes on a bundled sample (12 questions) still fit.
    policy.check_question_count("comparison", 120, None)
    monkeypatch.delenv("RAG_PLAYGROUND_DEMO")
    policy.check_question_count("comparison", 5000, None)


def test_on_the_demo_a_visitor_has_at_most_two_runs_going(client, monkeypatch):
    import threading

    gate = threading.Event()

    def held_run(self, documents, **kwargs):
        gate.wait(5)
        return SimpleNamespace(ok=True, documents={}, index=None)

    monkeypatch.setattr(IndexPipeline, "run", held_run)
    demo_on(monkeypatch)
    ann, bob = "ann-" + "a" * 20, "bob-" + "b" * 20
    as_visitor(client, ann)
    sample = client.post("/api/sources/sample").json()
    body = {"config": PIPELINE, "documents": [sample["sha"]]}
    ids = [client.post("/api/v2/runs", json=body).json()["run_id"] for _ in range(2)]
    r = client.post("/api/v2/runs", json=body)
    assert r.status_code == 429
    assert r.json()["detail"] == "You already have 2 runs going. Wait for one to finish, or stop one."
    as_visitor(client, bob)
    theirs = client.post("/api/v2/runs", json=body).json()["run_id"]
    gate.set()
    read_sse(client, theirs, prefix="/api/v2")
    as_visitor(client, ann)
    for run_id in ids:
        read_sse(client, run_id, prefix="/api/v2")


def test_locally_a_visitor_may_have_any_number_of_runs(monkeypatch):
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    assert PlaygroundPolicy().max_runs_per_owner(None) == 2
    monkeypatch.delenv("RAG_PLAYGROUND_DEMO")
    assert PlaygroundPolicy().max_runs_per_owner(None) is None

"""I-12: GET /api/stages and POST /api/explain."""

from __future__ import annotations

from core.ports import STAGE_WHAT, Stage
from tests.api.conftest import ingest_graph, read_sse, upload_pdf


def test_stages_lists_every_stage_with_what_it_is_for(client):
    r = client.get("/api/stages")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {str(s) for s in Stage}
    for stage in Stage:
        assert body[str(stage)] == {"what": STAGE_WHAT[stage]}


def explain(client, stage, transform, config=None):
    return client.post(
        "/api/explain",
        json={"stage": stage, "transform": transform, "config": config or {}},
    )


def test_explain_returns_the_four_fields(client):
    r = explain(client, "chunk", "recursive_character", {"chunk_size": 800})
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"settings", "tradeoff", "warning", "blocking"}
    assert "800" in body["settings"]
    assert body["blocking"] is False


def test_explain_default_config_when_config_is_omitted(client):
    r = client.post("/api/explain", json={"stage": "chunk", "transform": "token_based"})
    assert r.status_code == 200, r.text
    assert "512" in r.json()["settings"]


def test_explain_reports_a_blocking_warning(client):
    r = explain(
        client, "chunk", "recursive_character", {"chunk_size": 100, "chunk_overlap": 100}
    )
    assert r.status_code == 200
    body = r.json()
    assert body["blocking"] is True
    assert body["warning"]


def test_explain_invalid_config_is_422_in_the_existing_shape(client):
    r = explain(client, "chunk", "recursive_character", {"chunk_size": 0})
    assert r.status_code == 422
    errors = r.json()["detail"]["errors"]
    assert errors and errors[0]["loc"] == ["chunk_size"]


def test_explain_unknown_transform_is_404(client):
    assert explain(client, "chunk", "nope").status_code == 404


def test_explain_unknown_stage_is_404(client):
    assert explain(client, "nope", "recursive_character").status_code == 404


def test_explain_is_pure(client, monkeypatch):
    """No model loads and no network: the root conftest already refuses a model
    load, and a network client is refused here too."""

    def refuse(*_a, **_k):
        raise AssertionError("explain must not build an API client")

    monkeypatch.setattr("plugins.use_case.chat.make_client", refuse)
    for stage, transform in [("index", "lancedb"), ("use_case", "chat"),
                             ("parse", "docling"), ("rerank", "mmr")]:
        assert explain(client, stage, transform).status_code == 200


def test_markdown_header_note_reaches_artifact_meta_after_a_real_run(client):
    src = upload_pdf(client)  # pdfium finds no headings in it
    graph = ingest_graph(src["sha"], src["filename"], chunker="markdown_header")
    r = client.post("/api/runs", json={"graph": graph})
    events = read_sse(client, r.json()["run_id"])
    aid = next(
        e["artifact_id"]
        for e in events
        if e["event"] == "node_finished" and e["node_id"] == "chunk"
    )
    meta = client.get(f"/api/artifacts/{aid}").json()["meta"]
    assert meta["note"] == (
        "The parser found no headings, so the whole document was treated as one "
        "section and packed into pieces of up to 512 tokens."
    )

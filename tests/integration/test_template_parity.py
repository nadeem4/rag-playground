"""The pipeline templates give the same result through Pandion and through pandion-api.

The fast tests check that every document and question pair composes, that
Pandion accepts it, and that pandion-api's validate route accepts it.

The `models` test runs each pair that needs no key for real: it indexes the
document template's sample and asks the sample's first question, once with
Pandion directly and once through pandion-api (in-process, TestClient), each
in its own folder. Both must make the same pieces, the same hits in the same
order, and the same result ids. It downloads models on first use, so it runs
in Release checks (`pytest -m models`), not in normal CI.
"""

from __future__ import annotations

import json
from itertools import product
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from pandion import ModelSettings, Pipeline, compose_template, list_templates
from pandion_api import ApiSettings, create_app

ROOT = Path(__file__).resolve().parents[2]
API = "/api/v2"
DEVICE = {"device": "cpu"}

LISTED = list_templates()
SAMPLES = {t["id"]: t["sample"] for t in LISTED["documents"]}
KEYED = {t["id"] for t in LISTED["questions"] if t["needs_key"]}
PAIRS = list(product(sorted(SAMPLES), sorted(t["id"] for t in LISTED["questions"])))
NO_KEY_PAIRS = [(d, q) for d, q in PAIRS if q not in KEYED]


def _api(folder: Path) -> TestClient:
    return TestClient(create_app(ApiSettings(data_dir=folder, models=ModelSettings(**DEVICE), prefix=API)))


@pytest.mark.parametrize(("document", "question"), PAIRS)
def test_every_pair_is_a_pipeline_pandion_accepts(document, question, tmp_path):
    p = Pipeline.from_dict(compose_template(document, question, path=str(tmp_path)))
    assert p.retrieval is not None and p.query is not None


def test_pandion_api_validates_every_pair(tmp_path):
    with _api(tmp_path / "data") as client:
        for document, question in PAIRS:
            config = compose_template(document, question)
            checked = client.post(f"{API}/pipelines/validate", json={"config": config}).json()
            assert checked["ok"] is True, (document, question, checked["problems"])


# --- the full run ---------------------------------------------------------------


def _sample(document: str) -> tuple[Path, str]:
    """The document template's sample PDF and its first question."""
    name = SAMPLES[document]
    folder = ROOT / "samples" / name
    first = json.loads((folder / "questions.json").read_text(encoding="utf-8"))[0]
    return folder / f"{name}.pdf", first["question"]


def _hit(hit: dict) -> tuple[str, str]:
    return hit["chunk"]["id"], hit["chunk"]["text"]


def _with_pandion(config: dict, pdf: Path, question: str) -> dict:
    p = Pipeline.from_dict({**config, "models": DEVICE})
    indexed = p.index.run(pdf)
    assert indexed.ok, indexed
    [document] = indexed.documents.values()
    asked = p.ask(question)
    assert asked.ok, asked.stages
    steps = [asked.stages["rewrite"], asked.stages["search"], *asked.stages["rerank"], asked.stages["answer"]]
    return {
        "pieces": [c.text for c in document.stages["chunk"].output.chunks],
        "hits": [_hit(h.model_dump(mode="json")) for h in asked.hits],
        "document_ids": {name: s.artifact_id for name, s in document.stages.items()},
        "index_id": indexed.index.artifact_id,
        "ask_ids": [s.artifact_id for s in steps],
    }


def _finish(client: TestClient, started) -> dict:
    assert started.status_code == 202, started.text
    run_id = started.json()["run_id"]
    with client.stream("GET", f"{API}/runs/{run_id}/events") as events:
        for line in events.iter_lines():
            if line.startswith("data: ") and json.loads(line[6:])["event"] == "stream_end":
                break
    return client.get(f"{API}/runs/{run_id}").json()["result"]


def _through_api(config: dict, pdf: Path, question: str, folder: Path) -> dict:
    with _api(folder) as client, pdf.open("rb") as f:
        uploaded = client.post(f"{API}/documents", files={"file": (pdf.name, f, "application/pdf")})
        sha = uploaded.json()["sha"]
        body = {"config": config, "documents": [sha]}
        indexed = _finish(client, client.post(f"{API}/runs", json=body))
        assert indexed["ok"], indexed
        [document] = indexed["documents"].values()
        asked = _finish(client, client.post(f"{API}/ask", json={**body, "question": question}))
        assert asked["ok"], asked
        chunks = client.get(f"{API}/results/{document['chunk']['result_id']}/payload").json()
        steps = [asked["steps"]["rewrite"], asked["steps"]["search"], *asked["steps"]["rerank"], asked["answer"]]
        return {
            "pieces": [c["text"] for c in chunks["chunks"]],
            "hits": [_hit(h) for h in asked["hits"]],
            "document_ids": {name: s["result_id"] for name, s in document.items()},
            "index_id": indexed["index"]["result_id"],
            "ask_ids": [s["result_id"] for s in steps],
        }


@pytest.mark.models
@pytest.mark.parametrize(("document", "question"), NO_KEY_PAIRS)
def test_a_template_gives_the_same_result_through_pandion_and_pandion_api(document, question, tmp_path):
    pdf, asked = _sample(document)
    direct = _with_pandion(compose_template(document, question, path=str(tmp_path / "direct")), pdf, asked)
    served = _through_api(compose_template(document, question), pdf, asked, tmp_path / "api")

    assert direct["pieces"] and direct["hits"], "the run found nothing"
    assert served["pieces"] == direct["pieces"]
    assert served["hits"] == direct["hits"]
    assert served["document_ids"] == direct["document_ids"]
    assert served["index_id"] == direct["index_id"]
    assert served["ask_ids"] == direct["ask_ids"]

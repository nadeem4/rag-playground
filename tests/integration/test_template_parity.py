"""The pipeline templates give the same result through Pandion and through pandion-api.

The fast tests check that every index and query pair composes, that
Pandion accepts it, and that pandion-api's validate route accepts it.

The `models` test runs pairs that need no key for real: it indexes the
index template's sample and asks the sample's first question, once with
Pandion directly and once through pandion-api (in-process, TestClient), each
in its own folder. Both must make the same pieces, the same hits in the same
order, and the same result ids. It downloads models on first use, so it runs
in Release checks (`pytest -m models`), not in normal CI. Release checks run
three representative pairs; with TEMPLATE_PARITY=all it runs every pair that
needs no key, as the weekly Template parity workflow does.
"""

from __future__ import annotations

import json
import os
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
SAMPLES = {t["id"]: t["sample"] for t in LISTED["index"] if t.get("sample")}
KEYED = {t["id"] for t in LISTED["query"] if t["needs_key"]}
QUERIES = sorted(t["id"] for t in LISTED["query"])
#: Every pair Pandion must accept; `web` has no sample, so it has no full run.
PAIRS = list(product(sorted(t["id"] for t in LISTED["index"]), QUERIES))
PAIRS_WITH_SAMPLES = [(d, q) for d, q in PAIRS if d in SAMPLES]
NO_KEY_PAIRS = [(d, q) for d, q in PAIRS_WITH_SAMPLES if q not in KEYED]
#: One pair per kind of parse, and each no-key query template once.
REPRESENTATIVE = [("text", "balanced"), ("tables", "precision"), ("scanned", "exact")]


def parity_pairs(env) -> list[tuple[str, str]]:
    """The pairs the full parity test runs: every no-key pair when
    TEMPLATE_PARITY is "all", else the three representative ones."""
    return NO_KEY_PAIRS if env.get("TEMPLATE_PARITY") == "all" else REPRESENTATIVE


def _api(folder: Path) -> TestClient:
    return TestClient(create_app(ApiSettings(data_dir=folder, models=ModelSettings(**DEVICE), prefix=API)))


@pytest.mark.parametrize(("index", "query"), PAIRS)
def test_every_pair_is_a_pipeline_pandion_accepts(index, query, tmp_path):
    p = Pipeline.from_dict(compose_template(index, query, path=str(tmp_path)))
    assert p.retrieval is not None and p.query is not None


def test_pandion_api_validates_every_pair(tmp_path):
    with _api(tmp_path / "data") as client:
        for index, query in PAIRS:
            config = compose_template(index, query)
            checked = client.post(f"{API}/pipelines/validate", json={"config": config}).json()
            assert checked["ok"] is True, (index, query, checked["problems"])


# --- the full run ---------------------------------------------------------------


def _sample(index: str) -> tuple[Path, str]:
    """The index template's sample PDF and its first question."""
    name = SAMPLES[index]
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
@pytest.mark.parametrize(("index", "query"), parity_pairs(os.environ))
def test_a_template_gives_the_same_result_through_pandion_and_pandion_api(index, query, tmp_path):
    pdf, asked = _sample(index)
    direct = _with_pandion(compose_template(index, query, path=str(tmp_path / "direct")), pdf, asked)
    served = _through_api(compose_template(index, query), pdf, asked, tmp_path / "api")

    assert direct["pieces"] and direct["hits"], "the run found nothing"
    assert served["pieces"] == direct["pieces"]
    assert served["hits"] == direct["hits"]
    assert served["document_ids"] == direct["document_ids"]
    assert served["index_id"] == direct["index_id"]
    assert served["ask_ids"] == direct["ask_ids"]


def test_release_checks_run_three_representative_pairs():
    assert parity_pairs({}) == [("text", "balanced"), ("tables", "precision"), ("scanned", "exact")]
    assert set(parity_pairs({})) <= set(NO_KEY_PAIRS)


def test_template_parity_all_runs_every_pair_that_needs_no_key():
    assert parity_pairs({"TEMPLATE_PARITY": "all"}) == NO_KEY_PAIRS

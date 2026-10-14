"""GET /api/templates, and every template pair runs under the hosted demo's rules."""

from __future__ import annotations

from itertools import product

import pytest

from pandion import Pipeline
from playground import templates
from playground.backend.policy import PlaygroundPolicy


def test_templates_lists_both_families_with_their_metadata_and_pipeline_parts(client):
    r = client.get("/api/templates")

    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"documents", "questions"}
    for family, listed in body.items():
        files = templates.load(family)
        assert [t["id"] for t in listed] == list(files)
        for t in listed:
            about = files[t["id"]]["template"]
            parts = {k: v for k, v in files[t["id"]].items() if k != "template"}
            assert {k: t[k] for k in about} == about
            assert t["pipeline"] == parts
    tables = next(t for t in body["documents"] if t["id"] == "tables")
    assert tables["name"] == "Reports with tables" and tables["sample"] == "table-of-figures"


PAIRS = list(product(templates.load("documents"), templates.load("questions")))


@pytest.mark.parametrize(("document", "question"), PAIRS)
def test_every_pair_passes_the_demos_run_check(document, question, tmp_path, monkeypatch):
    """No custom endpoint, no changed prompt or revision, no setting over a cap."""
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    config = Pipeline.from_dict(templates.compose(document, question, path=str(tmp_path))).to_dict()

    PlaygroundPolicy().check_run(config, request=None)

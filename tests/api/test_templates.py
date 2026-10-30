"""GET /api/templates, and every template pair runs under the hosted demo's rules."""

from __future__ import annotations

from itertools import product
from pathlib import Path

import pytest

import pandion
from playground.backend.policy import PlaygroundPolicy

ROOT = Path(__file__).resolve().parents[2]
LISTED = pandion.list_templates()


def test_templates_serves_pandions_templates(client):
    r = client.get("/api/templates")

    assert r.status_code == 200
    assert r.json() == LISTED
    tables = next(t for t in r.json()["index"] if t["id"] == "tables")
    assert tables["name"] == "Reports with tables" and tables["sample"] == "table-of-figures"
    manuals = next(t for t in r.json()["index"] if t["id"] == "manuals")
    assert manuals["sample"] == "station-manual"


def test_every_index_template_names_a_bundled_sample():
    for t in LISTED["index"]:
        if t["id"] == "web":
            assert "sample" not in t
            continue
        assert (ROOT / "samples" / t["sample"] / "sample.json").is_file(), t["id"]


PAIRS = list(product([t["id"] for t in LISTED["index"]], [t["id"] for t in LISTED["query"]]))


@pytest.mark.parametrize(("index", "query"), PAIRS)
def test_every_pair_passes_the_demos_run_check(index, query, tmp_path, monkeypatch):
    """No custom endpoint, no changed prompt or revision, no setting over a cap."""
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    config = pandion.Pipeline.from_dict(pandion.compose_template(index, query, path=str(tmp_path))).to_dict()

    PlaygroundPolicy().check_run(config, request=None)

"""TEMPORARY: print every question's rank on this platform, then fail so the log shows it."""

import json
from pathlib import Path

import pytest

from tests.test_sample_plants import TEXT_SAMPLES, Runner, _questions

CANDIDATES = json.loads((Path(__file__).parent / "_rank_candidates.json").read_text(encoding="utf-8"))


def _rank(payload):
    return payload["rank"] if payload["hit"] else (f"({payload['found_at']})" if payload["found_at"] else "-")


@pytest.mark.models
@pytest.mark.parametrize("name", TEXT_SAMPLES)
def test_dump_blocks(name, tmp_path, monkeypatch):
    from core.artifacts import ArtifactType
    from plugins.chunk import DocView

    runner = Runner(name, tmp_path, monkeypatch)
    result = runner.run(runner.graph(through="chunk"))
    view = DocView.of(runner.load(result, "parse", ArtifactType.PARSED_DOC))
    lines = [f"BLOCK {name} total={len(view.rendered)} chars={len(view.text)} pieces={len(runner.pieces(result))}"]
    for e in view.rendered:
        lines.append(f"BLOCK {name} p{e.page} {e.type} {len(e.text)} {e.text[:70]!r}")
    raise AssertionError("\n" + "\n".join(lines))


@pytest.mark.models
@pytest.mark.parametrize("name", TEXT_SAMPLES)
def test_dump_ranks(name, tmp_path, monkeypatch):
    runner = Runner(name, tmp_path, monkeypatch)
    lines = []
    for q in _questions(name) + CANDIDATES[name]:
        d, _ = runner.ask(q)
        r, _ = runner.ask(q, rerank=True)
        p, _ = runner.ask(q, retrieve={"query_expansion": "prf"})
        lines.append(f"RANK {name} {q['id']}: default={_rank(d)} rerank={_rank(r)} prf={_rank(p)}")
    print("\n".join(lines))
    raise AssertionError("\n" + "\n".join(lines))

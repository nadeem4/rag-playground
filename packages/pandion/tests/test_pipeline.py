"""Pipeline.from_file(...).index.run(paths): a whole index from one config file.

Two small PDFs, the fake embedder (no download), and the store under the
config's `path`. The second run of the same files does nothing new: every step
is a cache hit.
"""

from __future__ import annotations

import json
from pathlib import Path

import lancedb
import pytest

from pandion import Pipeline
from pandion.payloads import ChunkSet, ParsedDoc
from pdfs import SAMPLE_PAGES, build_pdf

CONFIG = """\
path: ./index
models:
  device: cpu
index:
  parse:
    use: pdfium
  clean:
    - use: dedupe_blocks
  chunk:
    use: recursive_character
    chunk_size: 70
    chunk_overlap: 10
  embed:
    use: fake-deterministic
  store:
    use: lancedb
"""


@pytest.fixture
def setup(tmp_path: Path) -> tuple[Path, Path]:
    """A pipeline file and a folder of two PDFs, one of them in a subfolder."""
    config = tmp_path / "pipeline.yaml"
    config.write_text(CONFIG, encoding="utf-8")
    docs = tmp_path / "docs"
    (docs / "guides").mkdir(parents=True)
    (docs / "report.pdf").write_bytes(build_pdf(SAMPLE_PAGES))
    (docs / "guides" / "short.pdf").write_bytes(build_pdf([["Paris is the capital of France."]]))
    return config, docs


def test_index_run_indexes_every_file_in_a_folder(setup):
    config, docs = setup

    report = Pipeline.from_file(config).index.run(docs)

    assert report.ok
    assert sorted(report.documents) == ["guides/short.pdf", "report.pdf"]
    stages = report.documents["report.pdf"].stages
    assert list(stages) == ["source", "parse", "clean.1", "chunk"]
    assert isinstance(stages["parse"].output, ParsedDoc)
    assert isinstance(stages["chunk"].output, ChunkSet)
    assert stages["clean.1"].transform == "dedupe_blocks"
    assert all(s.status == "executed" and s.artifact_id for s in stages.values())

    index_dir = report.index.output
    rows = lancedb.connect(index_dir).open_table("chunks").to_arrow().to_pylist()
    chunks = [c for d in report.documents.values() for c in d.stages["chunk"].output.chunks]
    assert sorted(r["id"] for r in rows) == sorted(c.id for c in chunks)
    descriptor = json.loads((index_dir / "descriptor.json").read_text(encoding="utf-8"))
    assert descriptor["embedding_model"] == "fake-deterministic"


def test_everything_is_kept_under_the_config_path(setup):
    config, docs = setup

    Pipeline.from_file(config).index.run(docs)

    root = config.parent / "index"
    assert sorted(p.name for p in root.iterdir()) == ["artifacts", "embeddings", "sources"]
    assert len([p for p in (root / "sources").iterdir() if p.suffix == ".pdf"]) == 2


def test_the_second_run_is_all_cache_hits(setup):
    config, docs = setup
    pipeline = Pipeline.from_file(config)
    first = pipeline.index.run(docs)

    second = Pipeline.from_file(config).index.run(docs)

    statuses = [s.status for d in second.documents.values() for s in d.stages.values()]
    assert statuses and set(statuses) == {"cached"}
    assert second.index.status == "cached"
    assert second.index.artifact_id == first.index.artifact_id


def test_a_list_of_files_is_indexed_by_file_name(setup):
    config, docs = setup

    report = Pipeline.from_file(config).index.run([docs / "report.pdf", docs / "guides" / "short.pdf"])

    assert sorted(report.documents) == ["report.pdf", "short.pdf"]


def test_the_same_document_id_twice_is_an_error(setup, tmp_path):
    config, docs = setup
    other = tmp_path / "other"
    other.mkdir()
    (other / "report.pdf").write_bytes(build_pdf([["Another report."]]))

    with pytest.raises(ValueError, match="report.pdf"):
        Pipeline.from_file(config).index.run([docs / "report.pdf", other / "report.pdf"])


def test_no_files_is_an_error(setup, tmp_path):
    config, _ = setup
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(ValueError, match="no files"):
        Pipeline.from_file(config).index.run(empty)


def test_a_failed_step_is_reported_not_raised(setup, tmp_path):
    config, docs = setup
    (docs / "notes.pdf").write_bytes(b"not a pdf at all")

    report = Pipeline.from_file(config).index.run(docs)

    assert not report.ok
    parse = report.documents["notes.pdf"].stages["parse"]
    assert parse.status == "failed" and parse.error and parse.output is None
    assert report.documents["notes.pdf"].stages["chunk"].status == "skipped"
    assert report.index.status == "skipped"

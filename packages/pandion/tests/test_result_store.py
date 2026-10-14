"""ResultStore: the results under a pipeline's path, by id, without the pipeline.

A server that serves results by id needs only the folder. One small PDF, pdfium
and the fake embedder: nothing reaches the network."""

import shutil

import pytest

import pandion
from pandion import Pipeline, ResultStore
from pdfs import SAMPLE_PAGES, build_pdf

CONFIG = {
    "path": "./index",
    "index": {
        "parse": {"use": "pdfium"},
        "chunk": {"use": "recursive_character", "chunk_size": 70, "chunk_overlap": 10},
        "embed": {"use": "fake-deterministic"},
        "store": {"use": "lancedb"},
    },
}


@pytest.fixture
def indexed(tmp_path):
    pdf = tmp_path / "report.pdf"
    pdf.write_bytes(build_pdf(SAMPLE_PAGES))
    p = Pipeline.from_dict(CONFIG, base=tmp_path)
    return p, p.index.run(pdf)


def test_it_is_public():
    assert "ResultStore" in pandion.__all__


def test_a_result_is_read_by_id_without_the_pipeline(indexed):
    p, report = indexed
    chunk = report.documents["report.pdf"].stages["chunk"]
    store = ResultStore(p.config.path)
    assert store.get(chunk.artifact_id) == p.result(chunk.artifact_id)
    info = store.info(chunk.artifact_id)
    assert info["id"] == chunk.artifact_id
    assert info["type"] == "chunk_set"
    assert info["meta"]["transform"] == "recursive_character"


def test_an_index_result_carries_its_descriptor_in_its_meta(indexed):
    p, report = indexed
    info = ResultStore(p.config.path).info(report.index.artifact_id)
    assert info["type"] == "index"
    assert "dense" in info["meta"]["index_descriptor"]["backends"]


@pytest.mark.parametrize("bad", ["../../etc", "F" * 64, "a" * 63, 7])
def test_an_id_that_is_not_a_result_id_is_refused_before_any_path_is_built(tmp_path, bad):
    with pytest.raises(KeyError, match="is not a result id"):
        ResultStore(tmp_path).get(bad)
    with pytest.raises(KeyError, match="is not a result id"):
        ResultStore(tmp_path).info(bad)


def test_an_unknown_id_names_the_folder(tmp_path):
    with pytest.raises(KeyError, match="No stored result has the id"):
        ResultStore(tmp_path).info("0" * 64)


def test_clear_removes_the_results_and_the_embedding_cache_but_not_the_documents(indexed):
    p, report = indexed
    out = ResultStore(p.config.path).clear()
    assert out["results"] >= 3 and out["bytes"] > 0 and out["complete"] is True
    assert not (p.config.path / "artifacts").exists()
    assert not (p.config.path / "embeddings").exists()
    assert (p.config.path / "sources").is_dir()
    with pytest.raises(KeyError):
        ResultStore(p.config.path).info(report.index.artifact_id)


def test_clearing_an_empty_folder_is_not_an_error(tmp_path):
    assert ResultStore(tmp_path).clear() == {"results": 0, "bytes": 0, "complete": True}


def test_clear_tries_again_while_a_file_is_held(indexed, monkeypatch):
    p, _ = indexed
    real = shutil.rmtree
    calls: list[object] = []

    def held_once(path, ignore_errors=False):
        calls.append(path)
        if len(calls) == 1:
            return  # the first attempt removes nothing, as when Windows holds a file
        real(path, ignore_errors=ignore_errors)

    monkeypatch.setattr("pandion.results.shutil.rmtree", held_once)
    monkeypatch.setattr(ResultStore, "RETRY_DELAY_S", 0)
    assert ResultStore(p.config.path).clear()["complete"] is True
    assert len(calls) > 2

"""pandion models pull downloads the public weights a pipeline needs, ahead of time."""

import pytest
import yaml

from pandion import cli, models
from pandion.embeddings import Qwen3Embedding06B
from pandion.plugins.rerank import cross_encoder

BASE = {
    "path": "./index",
    "index": {
        "parse": {"use": "pdfium"},
        "chunk": {"use": "recursive_character"},
        "embed": {"use": "fake-deterministic"},
        "store": {"use": "lancedb"},
    },
    "retrieve": {"search": {"use": "dense"}},
    "answer": {"use": "search"},
}


def write(tmp_path, embed="fake-deterministic", rerank=None, parse="pdfium", cache_dir=None):
    data = {**BASE, "path": str(tmp_path / "index")}
    data["index"] = {**BASE["index"], "embed": {"use": embed}, "parse": {"use": parse}}
    if rerank:
        data["retrieve"] = {"search": {"use": "dense"}, "rerank": rerank}
    if cache_dir:
        data["models"] = {"cache_dir": str(cache_dir)}
    file = tmp_path / "pipeline.yaml"
    file.write_text(yaml.safe_dump(data))
    return str(file)


@pytest.fixture
def calls(monkeypatch):
    seen = []
    monkeypatch.setattr(models, "download", lambda model_id, revision, settings: seen.append((model_id, revision, settings.cache_dir)))
    return seen


def test_pull_downloads_each_local_model_once(tmp_path, calls, capsys):
    rerank = [{"use": "cross_encoder", "model": "BAAI/bge-reranker-base"}, {"use": "cross_encoder", "model": "BAAI/bge-reranker-base"}]
    code = cli.main(["models", "pull", write(tmp_path, embed="qwen3-embedding-0.6b", rerank=rerank)])
    out = capsys.readouterr().out
    assert code == 0
    assert [c[0] for c in calls] == ["Qwen/Qwen3-Embedding-0.6B", "BAAI/bge-reranker-base"]
    assert out.count("Qwen/Qwen3-Embedding-0.6B") == 1 and "BAAI/bge-reranker-base" in out


def test_pull_with_no_local_model_says_so_and_exits_0(tmp_path, calls, capsys):
    code = cli.main(["models", "pull", write(tmp_path)])
    assert code == 0 and "This pipeline uses no local model." in capsys.readouterr().out
    assert calls == []


def test_pull_uses_the_pinned_revision(tmp_path, calls):
    rerank = {"use": "cross_encoder", "model": "BAAI/bge-reranker-v2-m3"}
    cli.main(["models", "pull", write(tmp_path, embed="qwen3-embedding-0.6b", rerank=rerank)])
    assert dict((m, r) for m, r, _ in calls) == {
        "Qwen/Qwen3-Embedding-0.6B": Qwen3Embedding06B.revision,
        "BAAI/bge-reranker-v2-m3": cross_encoder.PINNED["BAAI/bge-reranker-v2-m3"],
    }


def test_pull_writes_into_the_cache_dir_flag(tmp_path, calls):
    flag = tmp_path / "weights"
    cli.main(["models", "pull", write(tmp_path, embed="bge-small-en-v1.5", cache_dir=tmp_path / "other"), "--cache-dir", str(flag)])
    assert [c[2] for c in calls] == [flag]


def test_pull_uses_the_files_cache_dir_without_the_flag(tmp_path, calls):
    cli.main(["models", "pull", write(tmp_path, embed="bge-small-en-v1.5", cache_dir=tmp_path / "other")])
    assert [c[2] for c in calls] == [(tmp_path / "other")]


def write_docling(tmp_path, block):
    data = {**BASE, "path": str(tmp_path / "index")}
    data["index"] = {**BASE["index"], "parse": {"use": "docling", **block}}
    file = tmp_path / "pipeline.yaml"
    file.write_text(yaml.safe_dump(data))
    return str(file)


def test_pull_fetches_the_docling_models_with_the_blocks_options(tmp_path, monkeypatch, calls):
    loaded = []
    monkeypatch.setattr(models, "preload_parser", lambda use="docling", config=None, images=False: loaded.append((use, config, images)))
    code = cli.main(["models", "pull", write_docling(tmp_path, {"do_ocr": False})])
    assert code == 0 and calls == []
    assert len(loaded) == 1 and loaded[0][0] == "docling" and loaded[0][1] == {"do_ocr": False} and loaded[0][2] is True


def test_preload_parser_hands_the_block_to_docling(monkeypatch):
    from pandion.plugins.parse import docling

    seen = []
    monkeypatch.setattr(docling, "preload", lambda config=None, images=False: seen.append((config, images)))
    models.preload_parser("docling", {"do_ocr": False}, images=True)
    assert seen[0][0].do_ocr is False and seen[0][1] is True


def test_a_missing_extra_is_not_turned_into_network_advice(tmp_path, monkeypatch, capsys):
    def missing(model_id, revision, settings):
        raise ImportError("needs huggingface_hub, install pandion[local]")

    monkeypatch.setattr(models, "download", missing)
    code = cli.main(["models", "pull", write(tmp_path, embed="bge-small-en-v1.5")])
    err = capsys.readouterr().err
    assert code == 1 and "pandion[local]" in err and "network" not in err


def test_pull_failure_exits_1_with_one_sentence(tmp_path, monkeypatch, capsys):
    def boom(model_id, revision, settings):
        raise RuntimeError("network down\nsecond line")

    monkeypatch.setattr(models, "download", boom)
    code = cli.main(["models", "pull", write(tmp_path, embed="bge-small-en-v1.5")])
    err = capsys.readouterr().err
    assert code == 1
    assert "BAAI/bge-small-en-v1.5" in err and len(err.strip().splitlines()) == 1


def test_pull_never_prints_a_token(tmp_path, monkeypatch, calls, capsys):
    monkeypatch.setenv("HF_TOKEN", "secret-token")

    def boom(model_id, revision, settings):
        raise RuntimeError("401 for token secret-token")

    monkeypatch.setattr(models, "download", boom)
    cli.main(["models", "pull", write(tmp_path, embed="bge-small-en-v1.5")])
    out = capsys.readouterr()
    assert "secret-token" not in out.out + out.err

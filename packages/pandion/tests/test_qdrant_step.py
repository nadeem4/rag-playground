"""The `qdrant` index step: the same pipeline, with Qdrant (embedded) as the store."""

import json
from pathlib import Path

import pytest

pytest.importorskip("qdrant_client")

from pandion import Pipeline
from pandion.config import ConfigError, from_dict, to_dict
from pandion.errors import MissingExtra
from pandion.manifest import MANIFEST
from pandion.plugins.index import qdrant_store
from pandion.plugins.index.qdrant_store import QdrantIndex, QdrantIndexConfig
from pandion.ports import RunContext
from pdfs import build_pdf

CONFIG = """\
path: ./index
models:
  device: cpu
index:
  parse: {{use: pdfium}}
  chunk: {{use: recursive_character, chunk_size: 70, chunk_overlap: 10}}
  embed: {{use: fake-deterministic}}
  store: {{use: {store}}}
retrieve:
  search: {{use: {search}, top_k: 10}}
answer: {{use: search}}
access:
  default: [staff]
  folders:
    - {{match: "hr/**", roles: [hr]}}
"""

QUESTION = "salaries office opens month morning"


@pytest.fixture
def docs(tmp_path: Path) -> Path:
    docs = tmp_path / "docs"
    (docs / "hr").mkdir(parents=True)
    (docs / "hr" / "pay.pdf").write_bytes(build_pdf([["Salaries are paid on the last day of the month."]]))
    (docs / "handbook.pdf").write_bytes(build_pdf([["The office opens at nine every morning."]]))
    return docs


def synced(tmp_path, docs, store="qdrant", search="dense") -> Pipeline:
    config = tmp_path / "pipeline.yaml"
    config.write_text(CONFIG.format(store=store, search=search), encoding="utf-8")
    Pipeline.from_file(config).index.sync(docs)
    return Pipeline.from_file(config)


def found(result, folder: Path) -> set[str]:
    manifest = json.loads((folder / "index" / MANIFEST).read_text(encoding="utf-8"))["documents"]
    by_sha = {e["content_hash"]: doc_id for doc_id, e in manifest.items()}
    return {by_sha[h.chunk.doc_id] for h in result.stages["search"].output.hits}


def test_the_qdrant_step_indexes_and_dense_search_finds_the_piece(tmp_path, docs):
    p = synced(tmp_path, docs)
    result = p.retrieve("When is salary paid on the last day", roles=["hr"])
    assert found(result, tmp_path) == {"hr/pay.pdf"}


@pytest.mark.parametrize("search", ["bm25", "hybrid_rrf"])
def test_bm25_and_hybrid_work_on_qdrant(tmp_path, docs, search):
    p = synced(tmp_path, docs, search=search)
    assert found(p.retrieve(QUESTION, roles=["hr", "staff"]), tmp_path) == {"hr/pay.pdf", "handbook.pdf"}


@pytest.mark.parametrize("store", ["lancedb", "qdrant"])
@pytest.mark.parametrize("search", ["dense", "bm25", "hybrid_rrf"])
def test_roles_filter_works_on_qdrant(tmp_path, docs, store, search):
    p = synced(tmp_path, docs, store=store, search=search)
    assert found(p.retrieve(QUESTION, roles=["staff"]), tmp_path) == {"handbook.pdf"}
    assert found(p.retrieve(QUESTION, roles=["hr"]), tmp_path) == {"hr/pay.pdf"}
    assert found(p.retrieve(QUESTION, roles=[]), tmp_path) == set()


def _file(tmp_path, store_block: str):
    return {
        "path": str(tmp_path / "idx"),
        "index": {
            "parse": {"use": "pdfium"}, "chunk": {"use": "recursive_character"},
            "embed": {"use": "fake-deterministic"}, "store": store_block,
        },
        "retrieve": {"search": {"use": "dense"}},
    }


def test_a_pipeline_file_with_store_use_qdrant_loads_and_round_trips_to_dict(tmp_path):
    data = _file(tmp_path, {"use": "qdrant", "metric": "dot", "settings": {"url": "http://q:6333", "api_key_env": "K", "prefix": "bot"}})
    config = from_dict(data, base=tmp_path)
    assert config.index.store_use == "qdrant"
    again = to_dict(config)
    assert again["index"]["store"]["settings"] == {"url": "http://q:6333", "api_key_env": "K", "prefix": "bot"}
    assert from_dict(again, base=tmp_path).index.store == config.index.store


def test_the_settings_block_refuses_an_unknown_key_with_a_sentence(tmp_path):
    data = _file(tmp_path, {"use": "qdrant", "settings": {"colour": "red"}})
    with pytest.raises(ConfigError):
        from_dict(data, base=tmp_path)


def test_the_qdrant_step_without_the_extra_says_which_extra_to_install(monkeypatch, tmp_path):
    def missing(module, *, extra, step):
        raise MissingExtra(f'{step} needs {module}. Install it with: pip install "pandion[{extra}]"')

    monkeypatch.setattr(qdrant_store, "require", missing)
    ctx = RunContext(output_dir=tmp_path, emit=lambda e: None, tmp=tmp_path)
    with pytest.raises(MissingExtra, match=r"pandion\[qdrant\]"):
        QdrantIndex().apply({"chunks": []}, QdrantIndexConfig(embedder="fake-deterministic"), ctx)


def test_the_binding_holds_the_env_name_not_the_key(monkeypatch, tmp_path):
    monkeypatch.setenv("MY_KEY", "sekret-value")
    config = QdrantIndexConfig(
        embedder="fake-deterministic",
        settings={"url": "http://q:6333", "api_key_env": "MY_KEY", "prefix": "bot"},
    )
    ctx = RunContext(output_dir=tmp_path, emit=lambda e: None, tmp=tmp_path, extras={"index_location": str(tmp_path)})
    _, kept = QdrantIndex()._settings(config, ctx)
    assert kept == {"url": "http://q:6333", "api_key_env": "MY_KEY", "prefix": "bot", "fts": True}
    assert "sekret-value" not in json.dumps(kept)


def test_an_embedded_step_keeps_no_folder_in_the_binding(tmp_path):
    ctx = RunContext(output_dir=tmp_path, emit=lambda e: None, tmp=tmp_path, extras={"index_location": str(tmp_path)})
    settings, kept = QdrantIndex()._settings(QdrantIndexConfig(embedder="fake-deterministic"), ctx)
    assert settings["location"] == str(tmp_path) and "location" not in kept


@pytest.mark.parametrize("store", ["lancedb", "qdrant"])
def test_no_keyword_index_with_bm25_is_refused_at_load(tmp_path, store):
    data = _file(tmp_path, {"use": store, "build_fts": False})
    data["retrieve"] = {"search": {"use": "bm25"}}
    with pytest.raises(ConfigError, match="text search"):
        from_dict(data, base=tmp_path)
    data["retrieve"] = {"search": {"use": "dense"}}
    from_dict(data, base=tmp_path)


def test_the_qdrant_step_without_a_keyword_index_has_no_text_search(tmp_path, docs):
    config = tmp_path / "pipeline.yaml"
    config.write_text(CONFIG.format(store="qdrant", search="dense").replace("{use: qdrant}", "{use: qdrant, build_fts: false}"), encoding="utf-8")
    p = Pipeline.from_file(config)
    p.index.sync(docs)
    assert found(p.retrieve(QUESTION, roles=["hr", "staff"]), tmp_path) == {"hr/pay.pdf", "handbook.pdf"}


def test_a_store_without_text_search_is_refused_with_bm25_at_load(monkeypatch, tmp_path):
    from pandion.index_qdrant import QdrantStore

    real = QdrantStore.capabilities
    monkeypatch.setattr(QdrantStore, "capabilities", lambda self: real(self).model_copy(update={"lexical": None}))
    data = _file(tmp_path, {"use": "qdrant"})
    data["retrieve"] = {"search": {"use": "bm25"}}
    with pytest.raises(ConfigError, match="no text search"):
        from_dict(data, base=tmp_path)
    data["retrieve"] = {"search": {"use": "hybrid_rrf"}}
    with pytest.raises(ConfigError, match="no text search"):
        from_dict(data, base=tmp_path)
    data["retrieve"] = {"search": {"use": "dense"}}
    from_dict(data, base=tmp_path)

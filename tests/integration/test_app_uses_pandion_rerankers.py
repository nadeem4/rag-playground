"""The app reranks with the pandion package, not with a copy of its own.

The `mmr`, `cross_encoder` and `llm_rerank` steps moved into pandion. These
tests prove the app runs on them: the registry holds the package's classes, the
old module is gone, and the warm-up loads the cross-encoder through the public
`preload_reranker` with the app's model settings.
"""

from __future__ import annotations

import importlib.util
import logging
from types import SimpleNamespace

import pytest

from playground.backend import warmup
from playground.backend.deps import APP_MODELS
from pandion.ports import Stage
from pandion.registry import registry

RERANKERS = ["mmr", "cross_encoder", "llm_rerank"]
MINILM = "cross-encoder/ms-marco-MiniLM-L-6-v2"


@pytest.mark.parametrize("name", RERANKERS)
def test_the_app_registry_holds_the_package_reranker(name):
    assert registry.get(Stage.RERANK, name).__module__ == f"pandion.plugins.rerank.{name}"


def test_the_app_has_no_reranker_of_its_own():
    modules = {cls.__module__ for cls in registry.all_for(Stage.RERANK).values()}
    assert modules and all(m.startswith("pandion.") for m in modules)


@pytest.mark.parametrize("module", ["plugins.rerank", "plugins.rerank.mmr"])
def test_the_old_module_is_gone(module):
    try:
        spec = importlib.util.find_spec(module)
    except ModuleNotFoundError:  # its parent package is gone too
        spec = None
    assert spec is None


# -- warm-up ---------------------------------------------------------------------


def test_warm_up_loads_the_default_cross_encoder_on_the_cpu(monkeypatch):
    import pandion.plugins.rerank.cross_encoder as ce

    loaded: list = []
    monkeypatch.setattr(ce, "_load", lambda model_id, settings=None: loaded.append((model_id, settings)))
    monkeypatch.delenv("RAG_PLAYGROUND_DEMO", raising=False)
    warmup._warm_reranker()
    assert loaded == [(MINILM, APP_MODELS)]
    assert APP_MODELS.device == "cpu"


def test_the_demo_also_warms_the_best_precision_cross_encoder(monkeypatch):
    """Best precision, Vague questions and Chat answer rerank with bge-reranker-base."""
    import pandion.plugins.rerank.cross_encoder as ce

    loaded: list = []
    monkeypatch.setattr(ce, "_load", lambda model_id, settings=None: loaded.append(model_id))
    monkeypatch.setenv("RAG_PLAYGROUND_DEMO", "1")
    warmup._warm_reranker()
    assert loaded == [MINILM, "BAAI/bge-reranker-base"]


def test_a_failed_cross_encoder_download_is_logged_not_raised(monkeypatch, caplog):
    import pandion.plugins.rerank.cross_encoder as ce

    def boom(model_id, settings=None):
        raise OSError("no network")

    monkeypatch.setattr(ce, "_load", boom)
    with caplog.at_level(logging.ERROR):
        warmup._warm_reranker()
    assert "no network" in caplog.text


def test_the_warm_up_loads_the_reranker_after_the_others(monkeypatch):
    import pandion.embeddings as embeddings
    import pandion.plugins.parse.docling as docling_plugin

    calls: list[str] = []
    monkeypatch.setattr(
        docling_plugin,
        "_converter",
        lambda config: SimpleNamespace(initialize_pipeline=lambda fmt: calls.append("docling")),
    )
    monkeypatch.setattr(embeddings, "_load_model", lambda *args: calls.append("qwen"))
    monkeypatch.setattr(warmup, "_warm_reranker", lambda: calls.append("reranker"))
    warmup._warm()
    assert calls == ["docling", "qwen", "reranker"]


def test_the_reranker_warms_even_when_the_index_models_fail(monkeypatch, caplog):
    import pandion.plugins.parse.docling as docling_plugin

    def broken(config):
        raise RuntimeError("docling broke")

    calls: list[str] = []
    monkeypatch.setattr(docling_plugin, "_converter", broken)
    monkeypatch.setattr(warmup, "_warm_reranker", lambda: calls.append("reranker"))
    with caplog.at_level(logging.ERROR):
        warmup._warm()
    assert calls == ["reranker"]
    assert "docling broke" in caplog.text

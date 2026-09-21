"""Root conftest: populate the registry before anything is collected.

`tests/contract/test_contract_fast.py` parametrizes over the global registry at
**collection** time, and pytest collects `tests/contract` before
`tests/plugins`. Without this file the registry is still empty when that module
is imported, every parametrized case degenerates to a single "got empty
parameter set" skip, and the contract suite silently tests nothing — which is
strictly worse than having no contract suite, because every new plugin would
look covered.

A root conftest is imported before collection of any test module, so calling
`discover()` here is what makes the parametrization real.
"""

from __future__ import annotations

from plugins import discover

discover()


import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _isolated_embedding_cache(tmp_path_factory, monkeypatch):
    """Every test gets its own embedding cache, never the repo's `artifacts/`."""
    monkeypatch.setenv(
        "RAG_PLAYGROUND_EMBED_CACHE", str(tmp_path_factory.mktemp("embcache"))
    )


@pytest.fixture(autouse=True)
def _no_model_downloads_outside_models_tests(request, monkeypatch):
    """The default suite must never download or load a real embedding model.

    A test that reaches a real model without `@pytest.mark.models` fails here
    with the reason, instead of silently pulling a gigabyte.
    """
    if request.node.get_closest_marker("models"):
        return

    def refuse(model_id: str, revision: str):
        raise AssertionError(
            f"test tried to load {model_id}@{revision} without "
            "@pytest.mark.models; pass embedder='fake-deterministic'"
        )

    monkeypatch.setattr("providers.embeddings._load_model", refuse)

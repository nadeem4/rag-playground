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


def pytest_configure(config):
    # Registered here, not in pyproject.toml, which this workstream may not edit.
    config.addinivalue_line(
        "markers",
        "live_api: calls the real Anthropic API; needs ANTHROPIC_API_KEY "
        "(deselected by default; select with -m live_api)",
    )


def pytest_collection_modifyitems(config, items):
    """Deselect `live_api` tests unless the `-m` expression names the marker.

    A real API call costs money and needs a key, so it must be asked for by
    name: `pytest -m live_api`. The default run never sees these tests.
    """
    if "live_api" in (config.option.markexpr or ""):
        return
    kept = [item for item in items if not item.get_closest_marker("live_api")]
    if len(kept) != len(items):
        config.hook.pytest_deselected(
            items=[item for item in items if item.get_closest_marker("live_api")]
        )
        items[:] = kept


@pytest.fixture(autouse=True)
def _no_anthropic_calls_outside_live_api_tests(request, monkeypatch):
    """The default suite must never reach the Anthropic API.

    `plugins.use_case.chat.make_client` is the one place a real client is
    built. Replacing it here means a test that forgets to install a fake fails
    with the reason instead of spending tokens; a test that installs its own
    fake patches over this one.
    """
    if request.node.get_closest_marker("live_api"):
        return

    def refuse(api_key: str):
        raise AssertionError(
            "test tried to build a real Anthropic client without "
            "@pytest.mark.live_api; monkeypatch plugins.use_case.chat.make_client"
        )

    monkeypatch.setattr("plugins.use_case.chat.make_client", refuse)

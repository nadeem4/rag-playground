"""Anyone can add an embedder, and the index and the config accept it by name."""

import pytest

from pandion import embeddings
from pandion.config import ConfigError, from_dict
from pandion.extend import Embedder, get_embedder, register


class LetterCounts(Embedder):
    name = "test-letter-counts"
    model_id = "local/letter-counts"
    revision = "1"
    native_dim = 26
    max_seq_len = 10_000

    def _embed(self, texts, kind):
        return [[t.lower().count(chr(97 + i)) / max(len(t), 1) for i in range(26)] for t in texts]


@pytest.fixture(autouse=True)
def letter_counts():
    """Register the test embedder for each test and take it out afterwards."""
    assert register(LetterCounts) is LetterCounts
    yield
    embeddings._EMBEDDERS.pop(LetterCounts.name, None)


CONFIG = {
    "path": "./index",
    "index": {
        "parse": {"use": "pdfium"},
        "chunk": {"use": "recursive_character"},
        "embed": {"use": "test-letter-counts"},
        "store": {"use": "lancedb"},
    },
}


def test_a_registered_embedder_is_found_by_name():
    assert get_embedder("test-letter-counts").native_dim == 26


def test_the_config_accepts_a_registered_embedder(tmp_path):
    assert from_dict(CONFIG, base=tmp_path).index.store["embedder"] == "test-letter-counts"


def test_an_unknown_embedder_is_refused_with_the_known_names(tmp_path):
    bad = {**CONFIG, "index": {**CONFIG["index"], "embed": {"use": "nope-xyz"}}}
    with pytest.raises(ConfigError, match=r"nope-xyz.*test-letter-counts"):
        from_dict(bad, base=tmp_path)


def test_registering_an_embedder_name_twice_is_refused():
    # Again inherits name = "test-letter-counts", which makes it a duplicate.
    with pytest.raises(ValueError, match="already"):
        @register
        class Again(LetterCounts):
            pass


def test_register_refuses_something_else():
    class Plain:
        pass

    with pytest.raises(TypeError, match="Transform or an Embedder"):
        register(Plain)


def test_the_index_settings_form_still_lists_the_embedders_as_choices():
    from pandion.plugins import discover
    from pandion.ports import Stage
    from pandion.registry import registry
    discover()
    schema = registry.get(Stage.INDEX, "lancedb").config_model.model_json_schema()
    prop = schema["properties"]["embedder"]
    assert "qwen3-embedding-0.6b" in prop["enum"] and "test-letter-counts" in prop["enum"]
    # Every choice has a label, and the built-in labels are unchanged.
    assert set(prop["x-labels"]) == set(prop["enum"])
    assert prop["x-labels"]["qwen3-embedding-0.6b"] == "Qwen3 Embedding 0.6B"
    assert prop["x-labels"]["test-letter-counts"] == "test-letter-counts"


def test_the_built_in_embedder_field_schema_is_unchanged():
    from pandion.plugins.index.lancedb_store import LanceDbIndexConfig
    embeddings._EMBEDDERS.pop(LetterCounts.name)
    prop = LanceDbIndexConfig.model_json_schema()["properties"]["embedder"]
    assert prop == {
        "default": "qwen3-embedding-0.6b",
        "description": "The model that turns each piece into a vector. The first run downloads it.",
        "enum": ["qwen3-embedding-0.6b", "bge-small-en-v1.5", "fake-deterministic"],
        "title": "Embedding model",
        "type": "string",
        "x-labels": {
            "bge-small-en-v1.5": "BGE small, English",
            "fake-deterministic": "Fake, for tests",
            "qwen3-embedding-0.6b": "Qwen3 Embedding 0.6B",
        },
    }

"""A retriever that cannot read the chosen store is refused when the file is read."""

import pytest
from pydantic import BaseModel

from pandion.config import ConfigError, from_dict
from pandion.extend import ArtifactType, PortSpec, Stage, Transform, register
from pandion.plugins.index.lancedb_store import LanceDbIndex
from pandion.plugins.retrieve.bm25 import Bm25Retriever
from pandion.plugins.retrieve.dense import DenseRetriever
from pandion.plugins.retrieve.hybrid_rrf import HybridRrfRetriever
from pandion.registry import registry


class StoreSettings(BaseModel):
    embedder: str = "fake-deterministic"


class DenseOnlyStore(Transform[StoreSettings]):
    name = "test_dense_only_store"
    stage = Stage.INDEX
    inputs = {"chunks": PortSpec(ArtifactType.CHUNK_SET, variadic=True)}
    output = ArtifactType.INDEX
    config_model = StoreSettings
    provides = {"backends": ["dense"]}
    summary = "A dense store that is not LanceDB."

    def apply(self, inputs, config, ctx):
        raise NotImplementedError


class SearchSettings(BaseModel):
    top_k: int = 5


class DenseOnlyRetriever(Transform[SearchSettings]):
    """The retriever a new store brings with it."""

    name = "test_dense_only_search"
    stage = Stage.RETRIEVE
    inputs = {
        "index": PortSpec(ArtifactType.INDEX),
        "query": PortSpec(ArtifactType.QUERY, ambient=True),
    }
    output = ArtifactType.RETRIEVAL_RESULT
    requires = {"index": {"backends": ["dense"]}}
    config_model = SearchSettings
    summary = "Reads the dense-only store."

    def apply(self, inputs, config, ctx):
        raise NotImplementedError


@pytest.fixture(autouse=True, scope="module")
def _strategies():
    """Register the test strategies for this file only, so no other test sees them."""
    from pandion.plugins import discover

    discover()
    register(DenseOnlyStore)
    register(DenseOnlyRetriever)
    yield
    for cls in (DenseOnlyStore, DenseOnlyRetriever):
        registry._by_stage[cls.stage].pop(cls.name, None)


def _config(store, search):
    return {
        "path": "./i",
        "index": {"parse": {"use": "pdfium"}, "chunk": {"use": "recursive_character"},
                  "embed": {"use": "fake-deterministic"}, "store": {"use": store}},
        "retrieve": {"search": {"use": search}},
    }


def test_bm25_on_a_dense_only_store_is_refused_at_load(tmp_path):
    with pytest.raises(ConfigError, match=r"retrieve.search uses 'bm25'.*test_dense_only_store"):
        from_dict(_config("test_dense_only_store", "bm25"), base=tmp_path)


def test_dense_on_a_store_that_is_not_lancedb_is_refused_at_load(tmp_path):
    # It has a dense backend, but the built-in dense retriever opens a LanceDB table.
    with pytest.raises(ConfigError) as caught:
        from_dict(_config("test_dense_only_store", "dense"), base=tmp_path)
    assert str(caught.value) == (
        "retrieve.search uses 'dense', which needs a store with backends dense and "
        "format lancedb, but index.store uses 'test_dense_only_store', which has "
        "backends dense."
    )
    assert (caught.value.step, caught.value.use) == ("retrieve.search", "dense")


def test_the_store_s_own_retriever_on_it_is_fine(tmp_path):
    config = from_dict(_config("test_dense_only_store", "test_dense_only_search"), base=tmp_path)
    assert config.retrieve.search[0] == "test_dense_only_search"


@pytest.mark.parametrize("search", ["dense", "bm25", "hybrid_rrf"])
def test_every_built_in_retriever_reads_lancedb(tmp_path, search):
    assert from_dict(_config("lancedb", search), base=tmp_path).retrieve.search[0] == search


def test_lancedb_says_its_format_and_the_built_in_retrievers_need_it():
    assert LanceDbIndex.provides["format"] == ["lancedb"]
    for cls in (DenseRetriever, Bm25Retriever, HybridRrfRetriever):
        assert cls.requires["index"]["format"] == ["lancedb"]


def test_no_retrieve_section_means_no_check(tmp_path):
    data = _config("test_dense_only_store", "bm25")
    del data["retrieve"]
    assert from_dict(data, base=tmp_path).retrieve is None

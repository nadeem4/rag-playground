"""Shared fake transforms for engine tests.

Every fake here is model-free and plugin-free: the engine must be provable without
importing a single RAG library.
"""

from pathlib import Path

import pytest
from pydantic import BaseModel

from pandion.artifacts import ArtifactType
from pandion.ports import PortSpec, Stage
from pandion.registry import Registry
from pandion.transform import Transform


class EmptyCfg(BaseModel):
    pass


class TextCfg(BaseModel):
    text: str = ""


def _make(name, stage, inputs, output, cfg=EmptyCfg, fn=None, **attrs):
    """Build a concrete Transform subclass without a class statement."""
    ns = {
        "name": name,
        "stage": stage,
        "inputs": inputs,
        "output": output,
        "config_model": cfg,
        "summary": "A test transform.",
        "apply": fn or (lambda self, inputs, config, ctx: {"n": name}),
        **attrs,
    }
    return type(f"Fake_{name}", (Transform,), ns)


@pytest.fixture
def reg():
    """A registry of model-free fakes covering every stage under test."""
    r = Registry()
    r.register(_make("upload", Stage.SOURCE, {}, ArtifactType.RAW_FILE, TextCfg))
    r.register(_make("text", Stage.QUERY, {}, ArtifactType.QUERY, TextCfg))
    r.register(
        _make(
            "fake_parse",
            Stage.PARSE,
            {"file": PortSpec(ArtifactType.RAW_FILE)},
            ArtifactType.PARSED_DOC,
        )
    )
    r.register(
        _make(
            "strip",
            Stage.CLEAN,
            {"doc": PortSpec(ArtifactType.PARSED_DOC)},
            ArtifactType.PARSED_DOC,
        )
    )
    r.register(
        _make(
            "fixed",
            Stage.CHUNK,
            {"doc": PortSpec(ArtifactType.PARSED_DOC)},
            ArtifactType.CHUNK_SET,
        )
    )
    r.register(
        _make(
            "rewrite",
            Stage.QUERY_TRANSFORM,
            {"query": PortSpec(ArtifactType.QUERY)},
            ArtifactType.QUERY,
        )
    )
    r.register(
        _make(
            "fake_index",
            Stage.INDEX,
            {"chunks": PortSpec(ArtifactType.CHUNK_SET, variadic=True)},
            ArtifactType.INDEX,
            provides={"backends": ["dense"]},
        )
    )
    r.register(
        _make(
            "fake_fts_index",
            Stage.INDEX,
            {"chunks": PortSpec(ArtifactType.CHUNK_SET, variadic=True)},
            ArtifactType.INDEX,
            provides={"backends": ["fts"]},
        )
    )
    r.register(
        _make(
            "dense",
            Stage.RETRIEVE,
            {
                "index": PortSpec(ArtifactType.INDEX),
                "query": PortSpec(ArtifactType.QUERY, ambient=True),
            },
            ArtifactType.RETRIEVAL_RESULT,
            requires={"index": {"backends": ["dense"]}},
        )
    )
    r.register(
        _make(
            "bm25",
            Stage.RETRIEVE,
            {
                "index": PortSpec(ArtifactType.INDEX),
                "query": PortSpec(ArtifactType.QUERY, ambient=True),
            },
            ArtifactType.RETRIEVAL_RESULT,
            requires={"index": {"backends": ["fts"]}},
        )
    )
    r.register(
        _make(
            "ambient_bm25",
            Stage.RETRIEVE,
            {
                "index": PortSpec(ArtifactType.INDEX, ambient=True),
                "query": PortSpec(ArtifactType.QUERY, ambient=True),
            },
            ArtifactType.RETRIEVAL_RESULT,
            requires={"index": {"backends": ["fts"]}},
        )
    )
    r.register(
        _make(
            "mmr",
            Stage.RERANK,
            {
                "result": PortSpec(ArtifactType.RETRIEVAL_RESULT),
                "query": PortSpec(ArtifactType.QUERY, ambient=True),
                "index": PortSpec(ArtifactType.INDEX, ambient=True),
            },
            ArtifactType.RETRIEVAL_RESULT,
        )
    )
    r.register(
        _make(
            "search",
            Stage.USE_CASE,
            {"result": PortSpec(ArtifactType.RETRIEVAL_RESULT)},
            ArtifactType.OUTPUT,
        )
    )
    return r


@pytest.fixture
def sample_pdf(tmp_path: Path) -> Path:
    """A three-page PDF whose text is `SAMPLE_PAGES`."""
    from pdfs import SAMPLE_PAGES, build_pdf

    path = tmp_path / "sample.pdf"
    path.write_bytes(build_pdf(SAMPLE_PAGES))
    return path

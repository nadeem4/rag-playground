"""Executor events name their stage and carry the caller's trace id."""

from __future__ import annotations

import json

import pytest
from pydantic import BaseModel

from pandion.artifacts import ArtifactType
from pandion.executor import run
from pandion.graph import Edge, Graph, Node
from pandion.ports import PortSpec, Stage
from pandion.registry import Registry
from pandion.storage import Store
from pandion.transform import Transform


class Cfg(BaseModel):
    tag: str = "a"


def _registry() -> Registry:
    r = Registry()

    class Src(Transform[Cfg]):
        summary = "A test transform."
        name = "upload"
        stage = Stage.SOURCE
        inputs = {}
        output = ArtifactType.RAW_FILE
        config_model = Cfg

        def apply(self, inputs, config, ctx):
            ctx.emit({"event": "custom", "note": "from the transform"})
            return {"tag": config.tag}

    class Parse(Transform[Cfg]):
        summary = "A test transform."
        name = "fake_parse"
        stage = Stage.PARSE
        inputs = {"file": PortSpec(ArtifactType.RAW_FILE)}
        output = ArtifactType.PARSED_DOC
        config_model = Cfg

        def apply(self, inputs, config, ctx):
            raise RuntimeError("kaboom")

    class Chunk(Transform[Cfg]):
        summary = "A test transform."
        name = "fixed"
        stage = Stage.CHUNK
        inputs = {"doc": PortSpec(ArtifactType.PARSED_DOC)}
        output = ArtifactType.CHUNK_SET
        config_model = Cfg

        def apply(self, inputs, config, ctx):
            return {"chunks": []}

    for cls in (Src, Parse, Chunk):
        r.register(cls)
    return r


def _graph(with_parse: bool = True) -> Graph:
    if not with_parse:
        return Graph(nodes=[Node("s", Stage.SOURCE, "upload", {})], edges=[])
    return Graph(
        nodes=[
            Node("s", Stage.SOURCE, "upload", {}),
            Node("p", Stage.PARSE, "fake_parse", {}),
            Node("c", Stage.CHUNK, "fixed", {}),
        ],
        edges=[Edge("s", "p", "file"), Edge("p", "c", "doc")],
    )


@pytest.fixture
def store(tmp_path):
    return Store(tmp_path / "artifacts")


def _events(store, graph, **kw):
    out: list[dict] = []
    run(graph, _registry(), store, on_event=out.append, **kw)
    return out


def test_node_events_name_their_stage(store):
    ev = _events(store, _graph())
    by = {(e["event"], e["node_id"]): e for e in ev if "node_id" in e}
    assert by[("node_started", "s")]["stage"] == "source"
    assert by[("node_finished", "s")]["stage"] == "source"
    assert by[("node_skipped", "c")]["stage"] == "chunk"


def test_a_failed_node_event_has_stage_and_trace_id(store):
    ev = _events(store, _graph(), trace_id="t-1")
    failed = next(e for e in ev if e["event"] == "node_failed")
    assert failed["stage"] == "parse"
    assert failed["trace_id"] == "t-1"


def test_a_cached_node_event_has_stage(store):
    run(_graph(False), _registry(), store)
    ev = _events(store, _graph(False))
    fin = next(e for e in ev if e["event"] == "node_finished")
    assert fin["cache_hit"] is True
    assert fin["stage"] == "source"


def test_every_event_carries_the_trace_id_when_given(store):
    ev = _events(store, _graph(), trace_id="t-2")
    assert ev and all(e["trace_id"] == "t-2" for e in ev)


def test_events_have_no_trace_id_key_when_none_given(store):
    ev = _events(store, _graph())
    assert ev and all("trace_id" not in e for e in ev)


def test_trace_id_reaches_events_from_a_transforms_own_emit(store):
    ev = _events(store, _graph(False), trace_id="t-3")
    custom = next(e for e in ev if e["event"] == "custom")
    assert custom["trace_id"] == "t-3"


def test_events_still_serialise_to_json(store):
    for e in _events(store, _graph(), trace_id="t-4"):
        json.dumps(e)

"""Executor behaviour: order, memoization, targets, overrides, failure isolation.

The fake transforms are defined here rather than in `conftest.py` because these
tests assert on *call counts*, which needs a module-level recorder the graph
tests have no use for.
"""

from __future__ import annotations

import json

import pytest
from pydantic import BaseModel

from core.artifacts import ArtifactType
from core.executor import NodeStatus, run
from core.graph import Edge, Graph, Node
from core.ports import PortSpec, Stage
from core.registry import Registry
from core.storage import Store
from core.transform import Transform


class Cfg(BaseModel):
    tag: str = "a"


CALLS: list[str] = []


def counting_registry() -> Registry:
    """A registry of fakes that record every `apply` call in `CALLS`."""
    CALLS.clear()
    r = Registry()

    class Src(Transform[Cfg]):
        name = "upload"
        stage = Stage.SOURCE
        inputs = {}
        output = ArtifactType.RAW_FILE
        config_model = Cfg

        def apply(self, inputs, config, ctx):
            CALLS.append("upload")
            return {"tag": config.tag}

    class Parse(Transform[Cfg]):
        name = "fake_parse"
        stage = Stage.PARSE
        inputs = {"file": PortSpec(ArtifactType.RAW_FILE)}
        output = ArtifactType.PARSED_DOC
        config_model = Cfg

        def apply(self, inputs, config, ctx):
            CALLS.append("parse")
            return {"from": inputs["file"]["tag"]}

    class Chunk(Transform[Cfg]):
        name = "fixed"
        stage = Stage.CHUNK
        inputs = {"doc": PortSpec(ArtifactType.PARSED_DOC)}
        output = ArtifactType.CHUNK_SET
        config_model = Cfg

        def apply(self, inputs, config, ctx):
            CALLS.append("chunk")
            return {"chunks": [config.tag]}

    class Boom(Transform[Cfg]):
        name = "boom"
        stage = Stage.CHUNK
        inputs = {"doc": PortSpec(ArtifactType.PARSED_DOC)}
        output = ArtifactType.CHUNK_SET
        config_model = Cfg

        def apply(self, inputs, config, ctx):
            CALLS.append("boom")
            raise RuntimeError("kaboom")

    class Index(Transform[Cfg]):
        """An INDEX payload is a callable that writes into a directory."""

        name = "fake_index"
        stage = Stage.INDEX
        inputs = {"chunks": PortSpec(ArtifactType.CHUNK_SET, variadic=True)}
        output = ArtifactType.INDEX
        config_model = Cfg

        def apply(self, inputs, config, ctx):
            CALLS.append("index")

            def build(d):
                (d / "table.txt").write_text(config.tag, encoding="utf-8")

            return build

    for cls in (Src, Parse, Chunk, Boom, Index):
        r.register(cls)
    return r


def g_linear(chunk_transform: str = "fixed") -> Graph:
    return Graph(
        nodes=[
            Node("s", Stage.SOURCE, "upload", {}),
            Node("p", Stage.PARSE, "fake_parse", {}),
            Node("c", Stage.CHUNK, chunk_transform, {}),
        ],
        edges=[Edge("s", "p", "file"), Edge("p", "c", "doc")],
    )


@pytest.fixture
def store(tmp_path):
    return Store(tmp_path / "artifacts")


def test_runs_in_topological_order(store):
    run(g_linear(), counting_registry(), store)
    assert CALLS == ["upload", "parse", "chunk"]


def test_second_run_is_all_cached(store):
    reg = counting_registry()
    run(g_linear(), reg, store)
    CALLS.clear()
    res = run(g_linear(), reg, store)
    assert CALLS == []
    assert all(n.status is NodeStatus.CACHED for n in res.nodes.values())


def test_force_bypasses_cache(store):
    reg = counting_registry()
    run(g_linear(), reg, store)
    CALLS.clear()
    run(g_linear(), reg, store, force=True)
    assert CALLS == ["upload", "parse", "chunk"]


def test_config_change_invalidates_only_downstream(store):
    reg = counting_registry()
    run(g_linear(), reg, store)
    CALLS.clear()
    g = g_linear()
    g.nodes = [
        Node("c", Stage.CHUNK, "fixed", {"tag": "z"}) if n.id == "c" else n
        for n in g.nodes
    ]
    run(g, reg, store)
    assert CALLS == ["chunk"]


def test_targets_runs_target_and_ancestors_only(store):
    res = run(g_linear(), counting_registry(), store, targets={"p"})
    assert CALLS == ["upload", "parse"]
    assert res.nodes["c"].status is NodeStatus.PRUNED


def test_overrides_replace_config(store):
    res = run(
        g_linear(), counting_registry(), store, overrides={"c": {"tag": "overridden"}}
    )
    aid = res.nodes["c"].artifact.id
    assert store.load(aid, ArtifactType.CHUNK_SET) == {"chunks": ["overridden"]}


def test_override_on_pruned_node_emits_warning(store):
    events = []
    run(
        g_linear(),
        counting_registry(),
        store,
        targets={"p"},
        overrides={"c": {"tag": "x"}},
        on_event=events.append,
    )
    assert any(e["event"] == "warning" and "c" in e["message"] for e in events)


def test_failure_isolates_node_and_skips_descendants(store):
    g = Graph(
        nodes=[
            Node("s", Stage.SOURCE, "upload", {}),
            Node("p", Stage.PARSE, "fake_parse", {}),
            Node("b", Stage.CHUNK, "boom", {}),
            Node("c", Stage.CHUNK, "fixed", {}),
        ],
        edges=[
            Edge("s", "p", "file"),
            Edge("p", "b", "doc"),
            Edge("p", "c", "doc"),
        ],
    )
    res = run(g, counting_registry(), store)
    assert res.nodes["b"].status is NodeStatus.FAILED
    assert "kaboom" in res.nodes["b"].error
    assert res.nodes["c"].status is NodeStatus.EXECUTED  # sibling still ran
    assert res.ok is False


def test_descendants_of_a_failure_are_skipped(store):
    g = Graph(
        nodes=[
            Node("s", Stage.SOURCE, "upload", {}),
            Node("p", Stage.PARSE, "fake_parse", {}),
            Node("b", Stage.CHUNK, "boom", {}),
            Node("ix", Stage.INDEX, "fake_index", {}),
        ],
        edges=[
            Edge("s", "p", "file"),
            Edge("p", "b", "doc"),
            Edge("b", "ix", "chunks"),
        ],
    )
    res = run(g, counting_registry(), store)
    assert res.nodes["b"].status is NodeStatus.FAILED
    assert res.nodes["ix"].status is NodeStatus.SKIPPED
    assert "index" not in CALLS


def test_failure_leaves_no_partial_artifact_and_retries(store):
    reg = counting_registry()
    res = run(g_linear("boom"), reg, store)
    assert res.nodes["c"].artifact is None
    assert store.has("0" * 64) is False
    CALLS.clear()
    run(g_linear("boom"), reg, store)
    assert "boom" in CALLS  # retried, not cached as a failure


def test_duplicate_nodes_execute_once(store):
    g = Graph(
        nodes=[
            Node("s", Stage.SOURCE, "upload", {}),
            Node("p", Stage.PARSE, "fake_parse", {}),
            Node("c1", Stage.CHUNK, "fixed", {}),
            Node("c2", Stage.CHUNK, "fixed", {}),
        ],
        edges=[
            Edge("s", "p", "file"),
            Edge("p", "c1", "doc"),
            Edge("p", "c2", "doc"),
        ],
    )
    run(g, counting_registry(), store)
    assert CALLS.count("chunk") == 1


def test_events_are_emitted_in_order(store):
    events = []
    run(g_linear(), counting_registry(), store, on_event=events.append)
    kinds = [e["event"] for e in events]
    assert kinds[0] == "run_started" and kinds[-1] == "run_finished"
    assert kinds.count("node_started") == 3
    assert kinds.count("node_finished") == 3


def test_events_are_json_serializable(store):
    events = []
    run(g_linear("boom"), counting_registry(), store, on_event=events.append)
    json.dumps(events)  # tracebacks must not break SSE framing

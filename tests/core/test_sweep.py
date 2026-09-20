"""Sweep: one node, N (transform, config) variants, one shared upstream.

Varying the *transform* is the headline feature — comparing two parser
implementations is a transform change, not a config change, and a config-only
sweep cannot express it.
"""

from __future__ import annotations

from core.executor import NodeStatus, sweep
from core.graph import Edge, Graph, Node
from core.ports import Stage
from tests.core.test_executor import (  # noqa: F401
    CALLS,
    counting_registry,
    g_linear,
    store,
)


def g_with_index() -> Graph:
    return Graph(
        nodes=[
            Node("s", Stage.SOURCE, "upload", {}),
            Node("p", Stage.PARSE, "fake_parse", {}),
            Node("c", Stage.CHUNK, "fixed", {}),
            Node("ix", Stage.INDEX, "fake_index", {}),
        ],
        edges=[
            Edge("s", "p", "file"),
            Edge("p", "c", "doc"),
            Edge("c", "ix", "chunks"),
        ],
    )


def test_sweep_varies_transform_not_just_config(store):
    res = sweep(
        g_linear(),
        counting_registry(),
        store,
        node_id="c",
        variants=[
            {"transform": "fixed", "config": {}},
            {"transform": "boom", "config": {}},
        ],
    )
    assert len(res.runs) == 2
    assert res.runs[0].nodes["c"].status is NodeStatus.EXECUTED
    assert res.runs[1].nodes["c"].status is NodeStatus.FAILED


def test_sweep_reuses_upstream_across_variants(store):
    """The whole point: parse once, chunk three times."""
    sweep(
        g_linear(),
        counting_registry(),
        store,
        node_id="c",
        variants=[
            {"transform": "fixed", "config": {"tag": "a"}},
            {"transform": "fixed", "config": {"tag": "b"}},
            {"transform": "fixed", "config": {"tag": "c"}},
        ],
    )
    assert CALLS.count("parse") == 1
    assert CALLS.count("chunk") == 3


def test_sweep_stops_at_the_node_by_default(store):
    res = sweep(
        g_with_index(),
        counting_registry(),
        store,
        node_id="c",
        variants=[{"transform": "fixed", "config": {}}],
    )
    assert res.runs[0].nodes["c"].status is NodeStatus.EXECUTED
    assert res.runs[0].nodes["ix"].status is NodeStatus.PRUNED
    assert "index" not in CALLS


def test_through_runs_further_downstream(store):
    res = sweep(
        g_with_index(),
        counting_registry(),
        store,
        node_id="c",
        through="ix",
        variants=[
            {"transform": "fixed", "config": {"tag": "a"}},
            {"transform": "fixed", "config": {"tag": "b"}},
        ],
    )
    assert res.runs[0].nodes["ix"].status is NodeStatus.EXECUTED
    assert res.runs[1].nodes["ix"].status is NodeStatus.EXECUTED
    # Two distinct chunk sets must give two distinct indexes.
    assert res.runs[0].nodes["ix"].artifact.id != res.runs[1].nodes["ix"].artifact.id
    assert CALLS.count("index") == 2
    assert CALLS.count("parse") == 1


def test_one_failing_variant_does_not_abort_the_others(store):
    res = sweep(
        g_linear(),
        counting_registry(),
        store,
        node_id="c",
        variants=[
            {"transform": "boom", "config": {}},
            {"transform": "fixed", "config": {}},
        ],
    )
    assert res.runs[0].ok is False
    assert res.runs[1].ok is True


def test_sweep_records_its_variants(store):
    variants = [
        {"transform": "fixed", "config": {"tag": "a"}},
        {"transform": "fixed", "config": {"tag": "b"}},
    ]
    res = sweep(
        g_linear(), counting_registry(), store, node_id="c", variants=variants
    )
    assert res.variants == variants


def test_sweep_emits_a_variant_event_per_variant(store):
    events = []
    sweep(
        g_linear(),
        counting_registry(),
        store,
        node_id="c",
        variants=[
            {"transform": "fixed", "config": {"tag": "a"}},
            {"transform": "fixed", "config": {"tag": "b"}},
        ],
        on_event=events.append,
    )
    kinds = [e["event"] for e in events]
    assert kinds.count("variant_started") == 2
    assert kinds.count("variant_finished") == 2

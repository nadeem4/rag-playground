import pytest

from core.graph import Edge, Graph, GraphValidationError, Node
from core.ports import Stage


def n(nid, stage, transform, **config):
    return Node(id=nid, stage=stage, transform=transform, config=config)


def linear():
    return Graph(
        nodes=[
            n("s", Stage.SOURCE, "upload"),
            n("p", Stage.PARSE, "fake_parse"),
            n("c", Stage.CHUNK, "fixed"),
        ],
        edges=[Edge("s", "p", "file"), Edge("p", "c", "doc")],
    )


def test_topological_order(reg):
    assert linear().validate(reg).order == ["s", "p", "c"]


def test_stacked_cleaners_preserve_order(reg):
    g = Graph(
        nodes=[
            n("s", Stage.SOURCE, "upload"),
            n("p", Stage.PARSE, "fake_parse"),
            n("c1", Stage.CLEAN, "strip"),
            n("c2", Stage.CLEAN, "strip"),
            n("ch", Stage.CHUNK, "fixed"),
        ],
        edges=[
            Edge("s", "p", "file"),
            Edge("p", "c1", "doc"),
            Edge("c1", "c2", "doc"),
            Edge("c2", "ch", "doc"),
        ],
    )
    assert g.validate(reg).order == ["s", "p", "c1", "c2", "ch"]


def test_cycle_is_rejected(reg):
    g = Graph(
        nodes=[n("a", Stage.CLEAN, "strip"), n("b", Stage.CLEAN, "strip")],
        edges=[Edge("a", "b", "doc"), Edge("b", "a", "doc")],
    )
    with pytest.raises(GraphValidationError, match="cycle"):
        g.validate(reg)


def test_duplicate_node_id_rejected(reg):
    g = Graph(
        nodes=[n("x", Stage.SOURCE, "upload"), n("x", Stage.SOURCE, "upload")],
        edges=[],
    )
    with pytest.raises(GraphValidationError, match="duplicate"):
        g.validate(reg)


def test_edge_to_missing_node_rejected(reg):
    g = Graph(
        nodes=[n("s", Stage.SOURCE, "upload")],
        edges=[Edge("s", "ghost", "file")],
    )
    with pytest.raises(GraphValidationError, match="unknown node"):
        g.validate(reg)


def test_unknown_port_rejected(reg):
    g = Graph(
        nodes=[n("s", Stage.SOURCE, "upload"), n("p", Stage.PARSE, "fake_parse")],
        edges=[Edge("s", "p", "wrong_port")],
    )
    with pytest.raises(GraphValidationError, match="unknown port"):
        g.validate(reg)


def test_type_mismatched_edge_rejected(reg):
    """A chunk_set cannot feed a port expecting parsed_doc."""
    g = Graph(
        nodes=[
            n("s", Stage.SOURCE, "upload"),
            n("p", Stage.PARSE, "fake_parse"),
            n("c", Stage.CHUNK, "fixed"),
            n("c2", Stage.CHUNK, "fixed"),
        ],
        edges=[
            Edge("s", "p", "file"),
            Edge("p", "c", "doc"),
            Edge("c", "c2", "doc"),
        ],
    )
    with pytest.raises(GraphValidationError, match="type"):
        g.validate(reg)


def test_unconnected_required_port_rejected(reg):
    g = Graph(nodes=[n("p", Stage.PARSE, "fake_parse")], edges=[])
    with pytest.raises(GraphValidationError, match="required port"):
        g.validate(reg)


def test_unknown_transform_rejected(reg):
    g = Graph(nodes=[n("p", Stage.PARSE, "nonexistent")], edges=[])
    with pytest.raises(GraphValidationError, match="nonexistent"):
        g.validate(reg)


def test_variadic_port_accepts_many(reg):
    g = Graph(
        nodes=[
            n("s1", Stage.SOURCE, "upload"),
            n("s2", Stage.SOURCE, "upload"),
            n("p1", Stage.PARSE, "fake_parse"),
            n("p2", Stage.PARSE, "fake_parse"),
            n("c1", Stage.CHUNK, "fixed"),
            n("c2", Stage.CHUNK, "fixed"),
            n("ix", Stage.INDEX, "fake_index"),
        ],
        edges=[
            Edge("s1", "p1", "file"),
            Edge("s2", "p2", "file"),
            Edge("p1", "c1", "doc"),
            Edge("p2", "c2", "doc"),
            Edge("c1", "ix", "chunks"),
            Edge("c2", "ix", "chunks"),
        ],
    )
    assert g.validate(reg).bindings["ix"]["chunks"] == ["c1", "c2"]


def test_variadic_port_preserves_edge_order(reg):
    """Edge declaration order is the fan-in order; reversing it must show."""
    g = Graph(
        nodes=[
            n("s1", Stage.SOURCE, "upload"),
            n("s2", Stage.SOURCE, "upload"),
            n("p1", Stage.PARSE, "fake_parse"),
            n("p2", Stage.PARSE, "fake_parse"),
            n("c1", Stage.CHUNK, "fixed"),
            n("c2", Stage.CHUNK, "fixed"),
            n("ix", Stage.INDEX, "fake_index"),
        ],
        edges=[
            Edge("s1", "p1", "file"),
            Edge("s2", "p2", "file"),
            Edge("p1", "c1", "doc"),
            Edge("p2", "c2", "doc"),
            Edge("c2", "ix", "chunks"),
            Edge("c1", "ix", "chunks"),
        ],
    )
    assert g.validate(reg).bindings["ix"]["chunks"] == ["c2", "c1"]


def test_non_variadic_port_rejects_two_edges(reg):
    g = Graph(
        nodes=[
            n("s", Stage.SOURCE, "upload"),
            n("p1", Stage.PARSE, "fake_parse"),
            n("p2", Stage.PARSE, "fake_parse"),
            n("c", Stage.CHUNK, "fixed"),
        ],
        edges=[
            Edge("s", "p1", "file"),
            Edge("s", "p2", "file"),
            Edge("p1", "c", "doc"),
            Edge("p2", "c", "doc"),
        ],
    )
    with pytest.raises(GraphValidationError, match="single-valued port"):
        g.validate(reg)


def test_fanout_is_allowed(reg):
    """One output feeding two downstream nodes — required for sweeps."""
    g = Graph(
        nodes=[
            n("s", Stage.SOURCE, "upload"),
            n("p", Stage.PARSE, "fake_parse"),
            n("c1", Stage.CHUNK, "fixed"),
            n("c2", Stage.CHUNK, "fixed"),
        ],
        edges=[
            Edge("s", "p", "file"),
            Edge("p", "c1", "doc"),
            Edge("p", "c2", "doc"),
        ],
    )
    r = g.validate(reg)
    assert r.bindings["c1"]["doc"] == "p" and r.bindings["c2"]["doc"] == "p"


def full_pipeline():
    return Graph(
        nodes=[
            n("s", Stage.SOURCE, "upload"),
            n("p", Stage.PARSE, "fake_parse"),
            n("c", Stage.CHUNK, "fixed"),
            n("ix", Stage.INDEX, "fake_index"),
            n("q", Stage.QUERY, "text", text="hello"),
            n("r", Stage.RETRIEVE, "dense"),
            n("rr", Stage.RERANK, "mmr"),
            n("u", Stage.USE_CASE, "search"),
        ],
        edges=[
            Edge("s", "p", "file"),
            Edge("p", "c", "doc"),
            Edge("c", "ix", "chunks"),
            Edge("ix", "r", "index"),
            Edge("r", "rr", "result"),
            Edge("rr", "u", "result"),
        ],
    )


def test_ambient_port_resolves_to_nearest_ancestor(reg):
    """`query` is never wired explicitly; rerank and retrieve both find it."""
    r = full_pipeline().validate(reg)
    assert r.bindings["r"]["query"] == "q"
    assert r.bindings["rr"]["query"] == "q"


def test_ambient_port_with_no_producer_is_rejected(reg):
    g = Graph(
        nodes=[
            n("s", Stage.SOURCE, "upload"),
            n("p", Stage.PARSE, "fake_parse"),
            n("c", Stage.CHUNK, "fixed"),
            n("ix", Stage.INDEX, "fake_index"),
            n("r", Stage.RETRIEVE, "dense"),
        ],
        edges=[
            Edge("s", "p", "file"),
            Edge("p", "c", "doc"),
            Edge("c", "ix", "chunks"),
            Edge("ix", "r", "index"),
        ],
    )
    with pytest.raises(GraphValidationError, match="ambient"):
        g.validate(reg)


def _index_side():
    """The corpus half of a pipeline: `ix` is a usable index node."""
    return (
        [
            n("s", Stage.SOURCE, "upload"),
            n("p", Stage.PARSE, "fake_parse"),
            n("c", Stage.CHUNK, "fixed"),
            n("ix", Stage.INDEX, "fake_index"),
        ],
        [Edge("s", "p", "file"), Edge("p", "c", "doc"), Edge("c", "ix", "chunks")],
    )


def test_ambient_binds_to_terminal_query_transform(reg):
    """With `q -> qt1 -> qt2`, retrieve must read the *end* of the chain."""
    nodes, edges = _index_side()
    g = Graph(
        nodes=nodes
        + [
            n("q", Stage.QUERY, "text", text="hello"),
            n("qt1", Stage.QUERY_TRANSFORM, "rewrite"),
            n("qt2", Stage.QUERY_TRANSFORM, "rewrite"),
            n("r", Stage.RETRIEVE, "dense"),
        ],
        edges=edges
        + [
            Edge("q", "qt1", "query"),
            Edge("qt1", "qt2", "query"),
            Edge("ix", "r", "index"),
        ],
    )
    r = g.validate(reg)
    assert r.bindings["r"]["query"] == "qt2"
    assert "qt2" in r.parents["r"]


def test_ambient_with_two_terminal_producers_is_ambiguous(reg):
    """Two unwired query nodes: guessing one would be a silent mis-binding."""
    nodes, edges = _index_side()
    g = Graph(
        nodes=nodes
        + [
            n("q1", Stage.QUERY, "text", text="a"),
            n("q2", Stage.QUERY, "text", text="b"),
            n("r", Stage.RETRIEVE, "dense"),
        ],
        edges=edges + [Edge("ix", "r", "index")],
    )
    with pytest.raises(GraphValidationError, match="ambiguous") as exc:
        g.validate(reg)
    msg = str(exc.value)
    assert "q1" in msg and "q2" in msg


def _order_independence_graph(reversed_nodes: bool):
    """Same logical graph, node list declared in two different orders.

    The query chain is exactly as deep as the retrieve node, so any resolution
    that leans on `static_order`'s insertion-order tie-break returns a
    different answer for the two declaration orders.
    """
    nodes, edges = _index_side()
    nodes = nodes + [
        n("q", Stage.QUERY, "text", text="hello"),
        n("qt1", Stage.QUERY_TRANSFORM, "rewrite"),
        n("qt2", Stage.QUERY_TRANSFORM, "rewrite"),
        n("qt3", Stage.QUERY_TRANSFORM, "rewrite"),
        n("qt4", Stage.QUERY_TRANSFORM, "rewrite"),
        n("r", Stage.RETRIEVE, "dense"),
    ]
    edges = edges + [
        Edge("q", "qt1", "query"),
        Edge("qt1", "qt2", "query"),
        Edge("qt2", "qt3", "query"),
        Edge("qt3", "qt4", "query"),
        Edge("ix", "r", "index"),
    ]
    return Graph(nodes=list(reversed(nodes)) if reversed_nodes else nodes, edges=edges)


def test_ambient_resolution_is_independent_of_node_declaration_order(reg):
    """Bindings feed the recipe hash, so they must not depend on node order."""
    a = _order_independence_graph(reversed_nodes=False).validate(reg)
    b = _order_independence_graph(reversed_nodes=True).validate(reg)
    assert a.bindings["r"]["query"] == b.bindings["r"]["query"] == "qt4"
    assert a.bindings == b.bindings


def test_explicit_edge_overrides_ambient_resolution(reg):
    """An explicit wire wins even when ambient would pick a different node."""
    nodes, edges = _index_side()
    g = Graph(
        nodes=nodes
        + [
            n("q", Stage.QUERY, "text", text="hello"),
            n("qt1", Stage.QUERY_TRANSFORM, "rewrite"),
            n("r", Stage.RETRIEVE, "dense"),
            n("rr", Stage.RERANK, "mmr"),
        ],
        edges=edges
        + [
            Edge("q", "qt1", "query"),
            Edge("ix", "r", "index"),
            Edge("r", "rr", "result"),
            Edge("q", "rr", "query"),  # explicit, against the ambient answer
        ],
    )
    res = g.validate(reg)
    assert res.bindings["rr"]["query"] == "q"
    assert res.bindings["r"]["query"] == "qt1"


def test_capability_mismatch_is_rejected(reg):
    """bm25 requires an fts backend; fake_index provides only dense."""
    g = full_pipeline()
    g.nodes = [
        Node("r", Stage.RETRIEVE, "bm25", {}) if x.id == "r" else x for x in g.nodes
    ]
    with pytest.raises(GraphValidationError, match="capability"):
        g.validate(reg)


def test_ancestors_includes_the_targets_themselves(reg):
    r = full_pipeline().validate(reg)
    assert r.ancestors({"c"}) == {"s", "p", "c"}
    assert "rr" not in r.ancestors({"r"})
    assert r.ancestors({"r"}) == {"s", "p", "c", "ix", "q", "r"}

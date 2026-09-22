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
        summary = "A test transform."
        name = "upload"
        stage = Stage.SOURCE
        inputs = {}
        output = ArtifactType.RAW_FILE
        config_model = Cfg

        def apply(self, inputs, config, ctx):
            CALLS.append("upload")
            return {"tag": config.tag}

    class Parse(Transform[Cfg]):
        summary = "A test transform."
        name = "fake_parse"
        stage = Stage.PARSE
        inputs = {"file": PortSpec(ArtifactType.RAW_FILE)}
        output = ArtifactType.PARSED_DOC
        config_model = Cfg

        def apply(self, inputs, config, ctx):
            CALLS.append("parse")
            return {"from": inputs["file"]["tag"]}

    class Chunk(Transform[Cfg]):
        summary = "A test transform."
        name = "fixed"
        stage = Stage.CHUNK
        inputs = {"doc": PortSpec(ArtifactType.PARSED_DOC)}
        output = ArtifactType.CHUNK_SET
        config_model = Cfg

        def apply(self, inputs, config, ctx):
            CALLS.append("chunk")
            return {"chunks": [config.tag]}

    class Boom(Transform[Cfg]):
        summary = "A test transform."
        name = "boom"
        stage = Stage.CHUNK
        inputs = {"doc": PortSpec(ArtifactType.PARSED_DOC)}
        output = ArtifactType.CHUNK_SET
        config_model = Cfg

        def apply(self, inputs, config, ctx):
            CALLS.append("boom")
            raise RuntimeError("kaboom")

    class Index(Transform[Cfg]):
        summary = "A test transform."
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


# --------------------------------------------------------------------------
# fingerprint sees the validated config
#
# A transform's model identity is a function of its config: which embedder was
# selected. Config hashing already separates two embedder *names*, so the case
# that matters is a **revision bump on a non-default embedder** — a change the
# config hash cannot see. `REVISIONS` below stands in for the provider registry.
# --------------------------------------------------------------------------


REVISIONS: dict[str, str] = {"default_model": "r1", "other_model": "r1"}

#: Every config `fingerprint` was handed, in call order. `None` means the
#: executor called `fingerprint()` with no argument.
SEEN_CONFIGS: list[object] = []


class ModelCfg(BaseModel):
    model: str = "default_model"


def fingerprint_registry() -> Registry:
    """A source transform whose fingerprint depends on its configured model."""
    CALLS.clear()
    SEEN_CONFIGS.clear()
    r = Registry()

    class Fp(Transform[ModelCfg]):
        summary = "A test transform."
        name = "fp_source"
        stage = Stage.SOURCE
        inputs = {}
        output = ArtifactType.RAW_FILE
        config_model = ModelCfg

        def fingerprint(self, config=None):
            SEEN_CONFIGS.append(config)
            cfg = config or self.config_model()
            return f"{cfg.model}@{REVISIONS[cfg.model]}"

        def apply(self, inputs, config, ctx):
            CALLS.append("fp_source")
            return {"model": config.model}

    class Plain(Transform[Cfg]):
        summary = "A test transform."
        """Keeps the inherited no-arg `fingerprint()`."""

        name = "plain_source"
        stage = Stage.SOURCE
        inputs = {}
        output = ArtifactType.RAW_FILE
        config_model = Cfg

        def apply(self, inputs, config, ctx):
            CALLS.append("plain_source")
            return {"tag": config.tag}

    for cls in (Fp, Plain):
        r.register(cls)
    return r


def g_one(transform: str, config: dict | None = None) -> Graph:
    return Graph(nodes=[Node("s", Stage.SOURCE, transform, config or {})], edges=[])


def test_fingerprint_receives_the_validated_config(store):
    run(g_one("fp_source", {"model": "other_model"}), fingerprint_registry(), store)
    assert SEEN_CONFIGS, "fingerprint was never called"
    assert isinstance(SEEN_CONFIGS[0], ModelCfg)
    assert SEEN_CONFIGS[0].model == "other_model"


def test_revision_bump_on_a_non_default_model_changes_the_artifact_id(store):
    """The uncovered case: config is identical, only the revision moved.

    Without the config reaching `fingerprint`, the executor folds in the
    *default* model's revision and the id does not move — a cache hit on an
    index built by a different model.
    """
    reg = fingerprint_registry()
    g = g_one("fp_source", {"model": "other_model"})
    before = run(g, reg, store).nodes["s"].artifact.id

    REVISIONS["other_model"] = "r2"
    try:
        after = run(g, reg, store).nodes["s"].artifact.id
    finally:
        REVISIONS["other_model"] = "r1"

    assert after != before


def test_fingerprint_varying_with_config_separates_artifact_ids(store):
    reg = fingerprint_registry()
    a = run(g_one("fp_source", {"model": "default_model"}), reg, store)
    b = run(g_one("fp_source", {"model": "other_model"}), reg, store)
    assert a.nodes["s"].artifact.id != b.nodes["s"].artifact.id


def test_default_no_arg_fingerprint_still_runs(store):
    res = run(g_one("plain_source"), fingerprint_registry(), store)
    assert res.nodes["s"].status is NodeStatus.EXECUTED
    assert CALLS == ["plain_source"]


def test_fingerprint_remains_callable_with_no_arguments():
    """The contract suite calls `fingerprint()` bare on every transform."""

    class Bare(Transform[Cfg]):
        summary = "A test transform."
        name = "bare"
        stage = Stage.SOURCE
        inputs = {}
        output = ArtifactType.RAW_FILE
        config_model = Cfg

        def apply(self, inputs, config, ctx):
            return {}

    assert Bare().fingerprint() == "none"


# --------------------------------------------------------------------------
# transform-supplied artifact meta
#
# Built-in keys win: the spread goes first and `transform`/`node_id` are
# written after it, so a plugin cannot spoof either one.
# --------------------------------------------------------------------------


def meta_registry(offered: dict | None) -> Registry:
    CALLS.clear()
    r = Registry()

    class MetaSrc(Transform[Cfg]):
        summary = "A test transform."
        name = "meta_source"
        stage = Stage.SOURCE
        inputs = {}
        output = ArtifactType.RAW_FILE
        config_model = Cfg

        def apply(self, inputs, config, ctx):
            CALLS.append("meta_source")
            if offered is not None:
                ctx.extras["meta"] = dict(offered)
            return {"tag": config.tag}

    r.register(MetaSrc)
    return r


def test_transform_supplied_meta_reaches_the_artifact(store):
    reg = meta_registry({"index_descriptor": {"backends": ["dense"]}})
    res = run(g_one("meta_source"), reg, store)
    aid = res.nodes["s"].artifact.id
    assert res.nodes["s"].artifact.meta["index_descriptor"] == {"backends": ["dense"]}
    assert store.get_meta(aid).meta["index_descriptor"] == {"backends": ["dense"]}


def test_transform_offering_nothing_still_gets_the_builtin_meta(store):
    res = run(g_one("meta_source"), meta_registry(None), store)
    assert res.nodes["s"].artifact.meta == {
        "transform": "meta_source",
        "node_id": "s",
    }


def test_transform_cannot_overwrite_builtin_meta_keys(store):
    reg = meta_registry({"transform": "spoofed", "node_id": "spoofed"})
    res = run(g_one("meta_source"), reg, store)
    meta = res.nodes["s"].artifact.meta
    assert meta["transform"] == "meta_source"
    assert meta["node_id"] == "s"


def test_meta_survives_a_cache_hit(store):
    reg = meta_registry({"index_descriptor": {"backends": ["dense"]}})
    g = g_one("meta_source")
    first = run(g, reg, store)
    CALLS.clear()
    second = run(g, reg, store)
    assert CALLS == []
    assert second.nodes["s"].status is NodeStatus.CACHED
    assert second.nodes["s"].artifact.meta == first.nodes["s"].artifact.meta


# ---------------------------------------------------------------------------
# Non-cacheable: never reused, but always persisted (the latest run wins)
# ---------------------------------------------------------------------------


def volatile_registry() -> Registry:
    CALLS.clear()
    r = Registry()

    class Volatile(Transform[Cfg]):
        summary = "A test transform."
        name = "volatile"
        stage = Stage.SOURCE
        inputs = {}
        output = ArtifactType.RAW_FILE
        config_model = Cfg
        cacheable = False

        def apply(self, inputs, config, ctx):
            CALLS.append("volatile")
            return {"call": len(CALLS)}

    r.register(Volatile)
    return r


def test_non_cacheable_output_is_stored(store):
    res = run(g_one("volatile"), volatile_registry(), store)
    aid = res.nodes["s"].artifact.id
    assert store.has(aid)
    assert store.load(aid, ArtifactType.RAW_FILE) == {"call": 1}


def test_non_cacheable_recomputes_and_replaces_the_stored_payload(store):
    reg = volatile_registry()
    first = run(g_one("volatile"), reg, store)
    second = run(g_one("volatile"), reg, store)
    aid = second.nodes["s"].artifact.id
    assert aid == first.nodes["s"].artifact.id
    assert CALLS == ["volatile", "volatile"]
    assert second.nodes["s"].status is NodeStatus.EXECUTED
    assert store.load(aid, ArtifactType.RAW_FILE) == {"call": 2}


# ---------------------------------------------------------------------------
# Cancellation: checked between nodes, never mid-node
# ---------------------------------------------------------------------------


def test_cancel_before_start_runs_nothing(store):
    events = []
    res = run(
        g_linear(), counting_registry(), store, cancelled=lambda: True,
        on_event=events.append,
    )
    assert CALLS == []
    assert all(n.status is NodeStatus.SKIPPED for n in res.nodes.values())
    cancel = [e for e in events if e["event"] == "run_cancelled"]
    assert len(cancel) == 1 and cancel[0]["skipped"] == ["s", "p", "c"]
    assert events[-1]["event"] == "run_finished"
    assert events[-1]["cancelled"] is True


def test_cancel_between_nodes_stops_subsequent_nodes(store):
    # Flip the flag once the parse node has *finished*: the chunker must not run.
    flag = {"on": False}

    def on_event(e):
        if e["event"] == "node_finished" and e["node_id"] == "p":
            flag["on"] = True

    res = run(
        g_linear(), counting_registry(), store,
        cancelled=lambda: flag["on"], on_event=on_event,
    )
    assert CALLS == ["upload", "parse"]
    assert res.nodes["p"].status is NodeStatus.EXECUTED
    assert res.nodes["c"].status is NodeStatus.SKIPPED


def test_cancel_does_not_touch_pruned_nodes(store):
    events = []
    res = run(
        g_linear(), counting_registry(), store, targets={"p"},
        cancelled=lambda: True, on_event=events.append,
    )
    assert res.nodes["c"].status is NodeStatus.PRUNED
    assert next(e for e in events if e["event"] == "run_cancelled")["skipped"] == [
        "s", "p",
    ]


def test_uncancelled_run_reports_cancelled_false(store):
    events = []
    run(g_linear(), counting_registry(), store, on_event=events.append)
    assert events[-1] == {**events[-1], "event": "run_finished", "cancelled": False}
    assert not any(e["event"] == "run_cancelled" for e in events)


def test_sweep_threads_cancel_and_stops_later_variants(store):
    from core.executor import sweep

    flag = {"on": False}

    def on_event(e):
        if e["event"] == "variant_finished" and e["index"] == 0:
            flag["on"] = True

    res = sweep(
        g_linear(), counting_registry(), store, node_id="c",
        variants=[
            {"transform": "fixed", "config": {"tag": "x"}},
            {"transform": "fixed", "config": {"tag": "y"}},
        ],
        cancelled=lambda: flag["on"], on_event=on_event,
    )
    assert len(res.runs) == 1
    assert CALLS == ["upload", "parse", "chunk"]

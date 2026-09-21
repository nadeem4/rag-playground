"""`context_extras`: per-run values handed to every transform via `ctx.extras`.

The channel exists for credentials, so the hard rule tested here is that only
`extras["meta"]` is ever copied into artifact meta; anything else a caller puts
in, a `credentials` entry above all, never reaches meta or the store.
"""

from __future__ import annotations

from pydantic import BaseModel

from core.artifacts import ArtifactType
from core.executor import run, sweep
from core.graph import Edge, Graph, Node
from core.ports import PortSpec, Stage
from core.registry import Registry
from core.storage import Store
from core.transform import Transform

FAKE_KEY = "sk-ant-test-DO-NOT-LEAK-0123456789"


class Cfg(BaseModel):
    tag: str = "a"


def recording_registry(seen: list[dict]) -> Registry:
    r = Registry()

    class Src(Transform[Cfg]):
        name = "src"
        stage = Stage.SOURCE
        inputs = {}
        output = ArtifactType.RAW_FILE
        config_model = Cfg

        def apply(self, inputs, config, ctx):
            seen.append(dict(ctx.extras))
            ctx.extras["meta"] = {"offered": "yes"}
            return {"tag": config.tag}

    class Parse(Transform[Cfg]):
        name = "parse"
        stage = Stage.PARSE
        inputs = {"file": PortSpec(ArtifactType.RAW_FILE)}
        output = ArtifactType.PARSED_DOC
        config_model = Cfg

        def apply(self, inputs, config, ctx):
            seen.append(dict(ctx.extras))
            return {"from": inputs["file"]["tag"], "cfg": config.tag}

    r.register(Src)
    r.register(Parse)
    return r


def graph() -> Graph:
    return Graph(
        nodes=[Node("s", Stage.SOURCE, "src", {}), Node("p", Stage.PARSE, "parse", {})],
        edges=[Edge("s", "p", "file")],
    )


def creds() -> dict:
    return {"credentials": {"anthropic_api_key": FAKE_KEY}}


def all_bytes(root) -> bytes:
    return b"".join(p.read_bytes() for p in root.rglob("*") if p.is_file())


def test_context_extras_reach_every_node(tmp_path):
    seen: list[dict] = []
    run(graph(), recording_registry(seen), Store(tmp_path), context_extras=creds())
    assert len(seen) == 2
    assert all(s["credentials"] == {"anthropic_api_key": FAKE_KEY} for s in seen)


def test_default_extras_stay_empty(tmp_path):
    seen: list[dict] = []
    run(graph(), recording_registry(seen), Store(tmp_path))
    assert seen == [{}, {}]


def test_a_nodes_meta_does_not_bleed_into_the_next_node(tmp_path):
    seen: list[dict] = []
    run(graph(), recording_registry(seen), Store(tmp_path), context_extras=creds())
    assert "meta" not in seen[1]


def test_credentials_never_reach_meta_or_the_store(tmp_path):
    store = Store(tmp_path / "artifacts")
    res = run(graph(), recording_registry([]), store, context_extras=creds())
    assert res.ok
    for n in res.nodes.values():
        assert "credentials" not in n.artifact.meta
        assert FAKE_KEY not in repr(n.artifact)
    assert res.nodes["s"].artifact.meta["offered"] == "yes"  # meta still flows
    assert FAKE_KEY.encode() not in all_bytes(tmp_path)


def test_credentials_do_not_change_artifact_ids(tmp_path):
    a = run(graph(), recording_registry([]), Store(tmp_path / "a"))
    b = run(graph(), recording_registry([]), Store(tmp_path / "b"), context_extras=creds())
    assert {k: v.artifact.id for k, v in a.nodes.items()} == {
        k: v.artifact.id for k, v in b.nodes.items()
    }


def test_sweep_threads_context_extras_into_every_variant(tmp_path):
    seen: list[dict] = []
    res = sweep(
        graph(),
        recording_registry(seen),
        Store(tmp_path),
        node_id="p",
        variants=[
            {"transform": "parse", "config": {"tag": "x"}},
            {"transform": "parse", "config": {"tag": "y"}},
        ],
        context_extras=creds(),
    )
    assert all(r.ok for r in res.runs)
    # src once (then cached), p twice
    assert len(seen) == 3
    assert all(s["credentials"]["anthropic_api_key"] == FAKE_KEY for s in seen)
    assert FAKE_KEY.encode() not in all_bytes(tmp_path)

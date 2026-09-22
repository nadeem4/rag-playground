"""Runs over HTTP: background execution, SSE framing, replay, cancel, isolation."""

from __future__ import annotations

import threading
import time

import pytest
from pydantic import BaseModel

from core.artifacts import ArtifactType
from core.ports import PortSpec, Stage
from core.registry import Registry
from core.transform import Transform
from tests.api.conftest import ingest_graph, make_client, read_sse, upload_pdf


def kinds(events):
    return [e["event"] for e in events]


def start(client, graph, **extra) -> str:
    r = client.post("/api/runs", json={"graph": graph, **extra})
    assert r.status_code == 202, r.text
    return r.json()["run_id"]


def wait_done(client, run_id, timeout=20.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        snap = client.get(f"/api/runs/{run_id}").json()
        if snap["status"] != "running":
            return snap
        time.sleep(0.02)
    raise AssertionError("run did not finish")


# ---------------------------------------------------------------------------
# real plugins
# ---------------------------------------------------------------------------


def test_real_run_reaches_run_finished(client):
    src = upload_pdf(client)
    run_id = start(client, ingest_graph(src["sha"], src["filename"]))
    events = read_sse(client, run_id)

    assert kinds(events)[0] == "run_started"
    assert kinds(events)[-2:] == ["run_finished", "stream_end"]
    assert events[-2]["ok"] is True
    assert events[-1] == {**events[-1], "status": "finished", "ok": True}
    finished = [e for e in events if e["event"] == "node_finished"]
    assert [e["node_id"] for e in finished] == ["src", "parse", "chunk"]
    assert all(e["cache_hit"] is False for e in finished)
    # ids are the log positions, consecutive from zero
    assert [e["_id"] for e in events] == list(range(len(events)))


def test_sse_headers(client):
    src = upload_pdf(client)
    run_id = start(client, ingest_graph(src["sha"], src["filename"]))
    with client.stream("GET", f"/api/runs/{run_id}/events") as r:
        assert r.headers["cache-control"] == "no-cache"
        assert r.headers["connection"] == "keep-alive"
        assert r.headers["x-accel-buffering"] == "no"
        for _ in r.iter_lines():
            pass


def test_subscribe_after_completion_replays_full_log(client):
    src = upload_pdf(client)
    run_id = start(client, ingest_graph(src["sha"], src["filename"]))
    snap = wait_done(client, run_id)

    events = read_sse(client, run_id)
    assert kinds(events)[0] == "run_started"
    assert kinds(events)[-1] == "stream_end"
    assert len(events) == len(snap["events"])
    assert [e["_id"] for e in events] == list(range(len(events)))
    assert read_sse(client, run_id) == events  # and again, identically


def test_last_event_id_resumes_after_that_event(client):
    src = upload_pdf(client)
    run_id = start(client, ingest_graph(src["sha"], src["filename"]))
    full = read_sse(client, run_id)
    tail = read_sse(client, run_id, headers={"Last-Event-ID": "2"})
    assert tail == full[3:]


def test_last_event_id_query_param_resumes_like_the_header(client):
    # EventSource cannot set Last-Event-ID on a new connection; the query
    # parameter is how a manual reconnect resumes.
    src = upload_pdf(client)
    run_id = start(client, ingest_graph(src["sha"], src["filename"]))
    full = read_sse(client, run_id)
    tail = read_sse(client, run_id, params={"last_event_id": "2"})
    assert tail == full[3:]
    assert tail[0]["_id"] == 3


def test_last_event_id_header_wins_over_query_param(client):
    # A browser's own auto-reconnect sends the header; it is the more recent.
    src = upload_pdf(client)
    run_id = start(client, ingest_graph(src["sha"], src["filename"]))
    full = read_sse(client, run_id)
    tail = read_sse(
        client, run_id, headers={"Last-Event-ID": "4"}, params={"last_event_id": "1"}
    )
    assert tail == full[5:]


def test_snapshot(client):
    src = upload_pdf(client)
    run_id = start(client, ingest_graph(src["sha"], src["filename"]))
    snap = wait_done(client, run_id)
    assert snap["run_id"] == run_id
    assert snap["kind"] == "run"
    assert snap["status"] == "finished"
    assert snap["ok"] is True
    assert snap["cancel_requested"] is False
    assert snap["last_event_id"] == len(snap["events"]) - 1
    assert snap["events"][-1]["event"] == "stream_end"


def test_unknown_run_is_404(client):
    assert client.get("/api/runs/nope").status_code == 404
    assert client.get("/api/runs/nope/events").status_code == 404
    assert client.post("/api/runs/nope/cancel").status_code == 404


def test_failing_node_yields_json_safe_traceback_and_run_finishes(client):
    run_id = start(client, ingest_graph("0" * 64, "missing.pdf"))
    events = read_sse(client, run_id)

    failed = [e for e in events if e["event"] == "node_failed"]
    assert len(failed) == 1 and failed[0]["node_id"] == "src"
    assert "Traceback" in failed[0]["error"] and "\n" in failed[0]["error"]
    skipped = {e["node_id"] for e in events if e["event"] == "node_skipped"}
    assert skipped == {"parse", "chunk"}
    assert kinds(events)[-2:] == ["run_finished", "stream_end"]
    assert events[-2]["ok"] is False
    assert events[-1]["status"] == "finished" and events[-1]["ok"] is False


def test_second_identical_run_reports_cache_hits(client):
    src = upload_pdf(client)
    g = ingest_graph(src["sha"], src["filename"])
    read_sse(client, start(client, g))
    events = read_sse(client, start(client, g))
    finished = [e for e in events if e["event"] == "node_finished"]
    assert len(finished) == 3 and all(e["cache_hit"] for e in finished)


def test_force_bypasses_cache(client):
    src = upload_pdf(client)
    g = ingest_graph(src["sha"], src["filename"])
    read_sse(client, start(client, g))
    events = read_sse(client, start(client, g, force=True))
    assert not any(e.get("cache_hit") for e in events)


def test_targets_prunes(client):
    src = upload_pdf(client)
    g = ingest_graph(src["sha"], src["filename"])
    events = read_sse(client, start(client, g, targets=["parse"]))
    assert [e["node_id"] for e in events if e["event"] == "node_finished"] == [
        "src",
        "parse",
    ]


def test_unknown_target_is_400(client):
    g = ingest_graph("x", "x.pdf")
    r = client.post("/api/runs", json={"graph": g, "targets": ["zz"]})
    assert r.status_code == 400


def test_invalid_graph_is_400(client):
    g = ingest_graph("x", "x.pdf")
    g["edges"].append({"src": "chunk", "dst": "parse", "port": "doc"})
    assert client.post("/api/runs", json={"graph": g}).status_code == 400


def test_unknown_transform_is_400(client):
    g = ingest_graph("x", "x.pdf", chunker="nope")
    assert client.post("/api/runs", json={"graph": g}).status_code == 400


def test_invalid_config_is_422_before_running(client):
    g = ingest_graph("x", "x.pdf", chunk_cfg={"chunk_size": 0})
    r = client.post("/api/runs", json={"graph": g})
    assert r.status_code == 422
    assert "chunk" in r.text


def test_sweep_over_two_chunkers_streams_both_variants(client):
    src = upload_pdf(client)
    r = client.post(
        "/api/sweeps",
        json={
            "graph": ingest_graph(src["sha"], src["filename"]),
            "node_id": "chunk",
            "variants": [
                {"transform": "recursive_character", "config": {"chunk_size": 50}},
                {"transform": "token_based", "config": {"max_tokens": 16, "overlap": 0}},
            ],
        },
    )
    assert r.status_code == 202, r.text
    run_id = r.json()["run_id"]
    events = read_sse(client, run_id)

    started = [e for e in events if e["event"] == "variant_started"]
    assert [e["variant"]["transform"] for e in started] == [
        "recursive_character",
        "token_based",
    ]
    assert [e["ok"] for e in events if e["event"] == "variant_finished"] == [True, True]
    parse = [
        e for e in events if e["event"] == "node_finished" and e["node_id"] == "parse"
    ]
    assert [e["cache_hit"] for e in parse] == [False, True]  # parsed once
    chunk = [
        e for e in events if e["event"] == "node_finished" and e["node_id"] == "chunk"
    ]
    assert len({e["artifact_id"] for e in chunk}) == 2
    assert events[-1] == {**events[-1], "event": "stream_end", "status": "finished"}
    assert client.get(f"/api/runs/{run_id}").json()["kind"] == "sweep"


def test_sweep_bad_request_is_400(client):
    g = ingest_graph("x", "x.pdf")
    bad_node = {"graph": g, "node_id": "zz", "variants": [{"transform": "token_based"}]}
    bad_t = {"graph": g, "node_id": "chunk", "variants": [{"transform": "nope"}]}
    no_variants = {"graph": g, "node_id": "chunk", "variants": []}
    assert client.post("/api/sweeps", json=bad_node).status_code == 400
    assert client.post("/api/sweeps", json=bad_t).status_code == 400
    assert client.post("/api/sweeps", json=no_variants).status_code == 422


# ---------------------------------------------------------------------------
# fake plugins: deterministic control over timing
# ---------------------------------------------------------------------------


class Cfg(BaseModel):
    tag: str = "a"


def gated_registry(gates, entered) -> Registry:
    """The source node blocks until `gates[tag]` is set, signalling `entered[tag]`."""
    r = Registry()

    class Src(Transform[Cfg]):
        summary = "A test transform."
        name = "gate"
        stage = Stage.SOURCE
        inputs = {}
        output = ArtifactType.RAW_FILE
        config_model = Cfg

        def apply(self, inputs, config, ctx):
            entered[config.tag].set()
            assert gates[config.tag].wait(10)
            return {"tag": config.tag}

    class Parse(Transform[Cfg]):
        summary = "A test transform."
        name = "p"
        stage = Stage.PARSE
        inputs = {"file": PortSpec(ArtifactType.RAW_FILE)}
        output = ArtifactType.PARSED_DOC
        config_model = Cfg

        def apply(self, inputs, config, ctx):
            return {"from": inputs["file"]["tag"]}

    class Chunk(Transform[Cfg]):
        summary = "A test transform."
        name = "c"
        stage = Stage.CHUNK
        inputs = {"doc": PortSpec(ArtifactType.PARSED_DOC)}
        output = ArtifactType.CHUNK_SET
        config_model = Cfg

        def apply(self, inputs, config, ctx):
            return {"chunks": [inputs["doc"]["from"]]}

    for cls in (Src, Parse, Chunk):
        r.register(cls)
    return r


def gated_graph(prefix: str, tag: str) -> dict:
    s, p, c = f"{prefix}s", f"{prefix}p", f"{prefix}c"
    return {
        "nodes": [
            {"id": s, "stage": "source", "transform": "gate", "config": {"tag": tag}},
            {"id": p, "stage": "parse", "transform": "p", "config": {}},
            {"id": c, "stage": "chunk", "transform": "c", "config": {}},
        ],
        "edges": [
            {"src": s, "dst": p, "port": "file"},
            {"src": p, "dst": c, "port": "doc"},
        ],
    }


@pytest.fixture
def gates():
    gate = {t: threading.Event() for t in ("a", "b")}
    entered = {t: threading.Event() for t in ("a", "b")}
    return gate, entered


def test_cancel_stops_subsequent_nodes(dirs, gates):
    gate, entered = gates
    with make_client(dirs, gated_registry(gate, entered)) as client:
        run_id = start(client, gated_graph("", "a"))
        assert entered["a"].wait(10)  # the source node is mid-apply

        r = client.post(f"/api/runs/{run_id}/cancel")
        assert r.status_code == 202
        assert "between nodes" in r.json()["detail"]
        gate["a"].set()

        events = read_sse(client, run_id)
        finished = [e["node_id"] for e in events if e["event"] == "node_finished"]
        assert finished == ["s"]
        assert not any(
            e["event"] == "node_started" and e["node_id"] != "s" for e in events
        )
        cancelled = next(e for e in events if e["event"] == "run_cancelled")
        assert cancelled["skipped"] == ["p", "c"]
        assert events[-2] == {**events[-2], "event": "run_finished", "cancelled": True}
        assert events[-1] == {
            **events[-1],
            "event": "stream_end",
            "status": "cancelled",
        }
        assert client.get(f"/api/runs/{run_id}").json()["status"] == "cancelled"


def test_cancel_after_finish_is_409(dirs, gates):
    gate, entered = gates
    gate["a"].set()
    with make_client(dirs, gated_registry(gate, entered)) as client:
        run_id = start(client, gated_graph("", "a"))
        read_sse(client, run_id)
        assert client.post(f"/api/runs/{run_id}/cancel").status_code == 409


def test_two_concurrent_runs_do_not_interleave(dirs, gates):
    gate, entered = gates
    with make_client(dirs, gated_registry(gate, entered)) as client:
        a = start(client, gated_graph("a_", "a"))
        b = start(client, gated_graph("b_", "b"))
        # Both are genuinely in flight at once before either may proceed.
        assert entered["a"].wait(10) and entered["b"].wait(10)
        gate["b"].set()
        gate["a"].set()

        ea, eb = read_sse(client, a), read_sse(client, b)
        for events, prefix in ((ea, "a_"), (eb, "b_")):
            ids = [e["node_id"] for e in events if "node_id" in e]
            assert ids and all(i.startswith(prefix) for i in ids)
            assert [e["_id"] for e in events] == list(range(len(events)))
            assert kinds(events)[-2:] == ["run_finished", "stream_end"]


def test_idle_stream_sends_heartbeat(dirs, gates, monkeypatch):
    # TestClient buffers a streamed body, so the gate is released by a timer
    # rather than by the reader: pings accumulate while the node is blocked.
    monkeypatch.setattr("api.routes.runs.HEARTBEAT_S", 0.05)
    gate, entered = gates
    with make_client(dirs, gated_registry(gate, entered)) as client:
        run_id = start(client, gated_graph("", "a"))
        assert entered["a"].wait(10)
        threading.Timer(0.5, gate["a"].set).start()
        with client.stream("GET", f"/api/runs/{run_id}/events") as r:
            lines = list(r.iter_lines())
        assert ": ping" in lines
        assert '"stream_end"' in lines[-2] or '"stream_end"' in lines[-1]

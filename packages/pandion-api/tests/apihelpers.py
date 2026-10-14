"""Helpers for pandion-api's tests: an app on a temp folder, an upload, an SSE reader."""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from pandion import ModelSettings
from pandion_api import ApiSettings, Policy, create_app
from pdfs import SAMPLE_PAGES, build_pdf

#: A pipeline that needs no model download and no network.
PIPELINE: dict = {
    "index": {
        "parse": {"use": "pdfium"},
        "chunk": {"use": "recursive_character", "chunk_size": 70, "chunk_overlap": 10},
        "embed": {"use": "fake-deterministic"},
        "store": {"use": "lancedb"},
    },
    "retrieve": {"search": {"use": "dense", "top_k": 3}},
    "answer": {"use": "search"},
}


def settings(tmp_path: Path, **changes) -> ApiSettings:
    return ApiSettings(data_dir=tmp_path / "data", models=ModelSettings(device="cpu"), **changes)


def make_client(tmp_path: Path, policy: Policy | None = None) -> TestClient:
    return TestClient(create_app(settings(tmp_path), policy))


def upload(client: TestClient, name: str = "report.pdf", data: bytes | None = None, headers=None) -> dict:
    r = client.post(
        "/documents",
        files={"file": (name, data if data is not None else build_pdf(SAMPLE_PAGES), "application/pdf")},
        headers=headers or {},
    )
    assert r.status_code == 200, r.text
    return r.json()


def read_events(client: TestClient, run_id: str) -> list[dict]:
    """A run's stream to its end, each event with its `_id`."""
    out: list[dict] = []
    current: dict = {}
    with client.stream("GET", f"/runs/{run_id}/events") as r:
        assert r.status_code == 200
        for line in r.iter_lines():
            if line.startswith("id: "):
                current["_id"] = int(line[4:])
            elif line.startswith("data: "):
                current.update(json.loads(line[6:]))
            elif line == "" and current:
                out.append(current)
                current = {}
    if current:
        out.append(current)
    return out


def finish(client: TestClient, r) -> tuple[dict, list[dict]]:
    """For a 202 run: its events to the end, then its state with the result."""
    assert r.status_code == 202, r.text
    run_id = r.json()["run_id"]
    events = read_events(client, run_id)
    return client.get(f"/runs/{run_id}").json(), events

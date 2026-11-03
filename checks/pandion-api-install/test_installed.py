"""Checks the installed pandion-api wheel, run by run_check.py in a new environment.
"""

from __future__ import annotations

from importlib.metadata import version

from fastapi.testclient import TestClient

import pandion_api
from pandion import ModelSettings
from pandion_api import ApiSettings, Policy, create_app

YAML = """\
index:
  parse: {use: pdfium}
  chunk: {use: recursive_character, chunk_size: 400}
  embed: {use: fake-deterministic}
  store: {use: lancedb}
retrieve:
  search: {use: dense, top_k: 3}
answer: {use: search}
"""


def test_the_module_version_is_the_wheels():
    assert pandion_api.__version__ == version("pandion-api")


def test_a_serve_app_builds_and_answers_health(tmp_path):
    pipeline = tmp_path / "pipeline.yaml"
    pipeline.write_text(YAML, encoding="utf-8")
    settings = ApiSettings(data_dir=tmp_path / "data", models=ModelSettings(device="cpu"))
    app = create_app(settings, Policy.anonymous(), mode="serve", pipeline=pipeline)
    assert TestClient(app).get("/health").status_code == 200

"""Pipeline.from_dict and to_dict: the pipeline file's content as a plain dict,
for an app that keeps pipelines as JSON."""

import json
from pathlib import Path

import pytest
import yaml

import pandion
import pandion.config
from pandion import Pipeline

DATA = {
    "path": "./index",
    "models": {"device": "cpu"},
    "index": {
        "parse": {"use": "pdfium"},
        "clean": [{"use": "dedupe_blocks"}],
        "chunk": {"use": "recursive_character", "chunk_size": 70, "chunk_overlap": 10},
        "embed": {"use": "fake-deterministic"},
        "store": {"use": "lancedb"},
    },
    "retrieve": {"search": {"use": "hybrid_rrf", "top_k": 5}},
    "answer": {"use": "search"},
}


def test_from_dict_gives_the_same_pipeline_as_the_same_file(tmp_path):
    file = tmp_path / "pipeline.yaml"
    file.write_text(yaml.safe_dump(DATA), encoding="utf-8")
    assert Pipeline.from_dict(DATA, base=tmp_path).config == Pipeline.from_yaml(file).config


def test_to_dict_round_trips(tmp_path):
    p = Pipeline.from_dict(DATA, base=tmp_path)
    assert Pipeline.from_dict(p.to_dict(), base=tmp_path).config == p.config


def test_to_dict_is_plain_json(tmp_path):
    data = Pipeline.from_dict(DATA, base=tmp_path).to_dict()
    assert json.loads(json.dumps(data)) == data
    assert data["index"]["chunk"] == {"use": "recursive_character", "chunk_size": 70, "chunk_overlap": 10}


def test_a_relative_path_is_read_from_base(tmp_path):
    assert Pipeline.from_dict(DATA, base=tmp_path).config.path == tmp_path / "index"


def test_without_base_a_relative_path_is_read_from_the_current_folder(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert Pipeline.from_dict(DATA).config.path == Path("index")


def test_a_problem_is_a_public_config_error():
    assert pandion.ConfigError is pandion.config.ConfigError
    assert "ConfigError" in pandion.__all__
    with pytest.raises(pandion.ConfigError, match="no index section"):
        Pipeline.from_dict({"path": "./index"})

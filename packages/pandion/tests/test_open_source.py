"""A custom source decides where documents come from."""

import hashlib
from pathlib import Path

import pytest
from pydantic import BaseModel

from pandion import Pipeline
from pandion.config import ConfigError, from_dict, to_dict
from pandion.extend import (
    ArtifactType, Element, ParsedDoc, PortSpec, RunContext, Stage, Transform, raw_file, register,
)
from pandion.registry import registry
from pandion.sources import Sources


class FromTextSettings(BaseModel):
    location: str = ""
    prefix: str = ""


class InlineText(Transform[FromTextSettings]):
    name = "test_inline_text"
    stage = Stage.SOURCE
    output = ArtifactType.RAW_FILE
    config_model = FromTextSettings
    summary = "Treats the location itself as a tiny text document."

    def apply(self, inputs, config, ctx):
        return raw_file(ctx, (config.prefix + config.location).encode("utf-8"), "inline.txt")


class NoLocation(BaseModel):
    pass


class BadSource(Transform[NoLocation]):
    name = "test_bad_source"
    stage = Stage.SOURCE
    output = ArtifactType.RAW_FILE
    config_model = NoLocation
    summary = "Has no location setting."

    def apply(self, inputs, config, ctx):
        return raw_file(ctx, b"", "empty.txt")


class NoSettings(BaseModel):
    pass


class LinesParser(Transform[NoSettings]):
    name = "test_lines_parser"
    stage = Stage.PARSE
    inputs = {"file": PortSpec(ArtifactType.RAW_FILE)}
    output = ArtifactType.PARSED_DOC
    config_model = NoSettings
    summary = "One block per line of a text file."

    def apply(self, inputs, config, ctx):
        lines = [t for t in Path(inputs["file"]["path"]).read_text(encoding="utf-8").splitlines() if t.strip()]
        return ParsedDoc(elements=[Element(id=f"l{i}", type="paragraph", text=t, order=i)
                                   for i, t in enumerate(lines)])


@pytest.fixture(autouse=True, scope="module")
def _strategies():
    """Register the test strategies for this file only, so no other test sees them."""
    from pandion.plugins import discover

    discover()
    register(InlineText)
    register(BadSource)
    register(LinesParser)
    yield
    for cls in (InlineText, BadSource, LinesParser):
        registry._by_stage[cls.stage].pop(cls.name, None)


def _config(source):
    return {"path": "./index", "index": {
        "source": source, "parse": {"use": "test_lines_parser"},
        "chunk": {"use": "recursive_character"}, "embed": {"use": "fake-deterministic"},
        "store": {"use": "lancedb"}}}


def test_each_item_becomes_a_document_read_by_the_source(tmp_path):
    p = Pipeline._of(from_dict(_config({"use": "test_inline_text", "prefix": "Note: "}), base=tmp_path))
    report = p.index.run(["Paris is the capital of France.", "Rome is the capital of Italy."])
    assert sorted(report.documents) == ["Paris is the capital of France.", "Rome is the capital of Italy."]
    parsed = report.documents["Paris is the capital of France."].stages["parse"].output
    assert parsed.elements[0].text == "Note: Paris is the capital of France."


def test_a_source_without_a_location_setting_is_refused(tmp_path):
    with pytest.raises(ConfigError, match="no location field") as caught:
        from_dict(_config({"use": "test_bad_source"}), base=tmp_path)
    assert (caught.value.step, caught.value.use) == ("index.source", "test_bad_source")


def test_the_default_source_is_not_written_back(tmp_path):
    c = from_dict({**_config({"use": "upload"})}, base=tmp_path)
    assert "source" not in to_dict(c)["index"]


def test_a_custom_source_round_trips(tmp_path):
    c = from_dict(_config({"use": "test_inline_text", "prefix": "N: "}), base=tmp_path)
    assert from_dict(to_dict(c), base=tmp_path) == c


def test_sync_refuses_a_custom_source(tmp_path):
    p = Pipeline._of(from_dict(_config({"use": "test_inline_text"}), base=tmp_path))
    with pytest.raises(ValueError, match="sync works with local files"):
        p.index.sync(["Paris"])


def test_raw_file_stores_the_bytes_and_returns_what_upload_returns(tmp_path):
    sources = Sources(tmp_path / "sources")
    ctx = RunContext(output_dir=tmp_path / "out", emit=lambda e: None, tmp=tmp_path / "tmp",
                     extras={"sources": sources})
    record = raw_file(ctx, b"hello", "note.txt")
    sha = hashlib.sha256(b"hello").hexdigest()
    assert record == {"sha": sha, "filename": "note.txt",
                      "path": str(sources.path(sha, "note.txt")), "mime": "text/plain"}
    assert Path(record["path"]).read_bytes() == b"hello"
    assert raw_file(ctx, b"hello", "again.txt")["sha"] == sha


def test_raw_file_without_sources_says_so(tmp_path):
    ctx = RunContext(output_dir=tmp_path / "out", emit=lambda e: None, tmp=tmp_path / "tmp", extras={})
    with pytest.raises(ValueError, match="did not say where source files are kept"):
        raw_file(ctx, b"x", "x.txt")


def test_a_source_in_code_gives_the_same_config_as_the_file(tmp_path):
    in_code = Pipeline(path=tmp_path / "index", source={"use": "test_inline_text", "prefix": "N: "},
                       parse="test_lines_parser", chunk="recursive_character",
                       embed="fake-deterministic", store="lancedb")
    from_file = from_dict(_config({"use": "test_inline_text", "prefix": "N: "}), base=tmp_path)
    assert in_code.config == from_file
    assert in_code.index.config.index.source == from_file.index.source

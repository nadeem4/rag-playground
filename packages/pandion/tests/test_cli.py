"""`pandion install pipeline.yaml` installs the extras the file needs."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from pandion import cli

CONFIG = """\
path: ./index
index:
  parse:
    use: {parser}
  chunk:
    use: recursive_character
  embed:
    use: {embedder}
  store:
    use: lancedb
"""


def write(tmp_path: Path, parser: str = "docling", embedder: str = "qwen3-embedding-0.6b") -> Path:
    path = tmp_path / "pipeline.yaml"
    path.write_text(CONFIG.format(parser=parser, embedder=embedder), encoding="utf-8")
    return path


def test_print_shows_the_pip_command_for_the_extras(tmp_path, capsys):
    code = cli.main(["install", str(write(tmp_path)), "--print"])

    assert code == 0
    expected = f'"{sys.executable}" -m pip install "pandion[docling,lancedb,local]"'
    assert capsys.readouterr().out.strip() == expected


def test_the_fake_embedder_and_pdfium_need_no_model_extra(tmp_path, capsys):
    cli.main(["install", str(write(tmp_path, "pdfium", "fake-deterministic")), "--print"])
    assert capsys.readouterr().out.strip().endswith('"pandion[lancedb,pdfium]"')


def test_install_runs_pip_with_this_python(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(cli.subprocess, "call", lambda command: calls.append(command) or 0)

    assert cli.main(["install", str(write(tmp_path))]) == 0
    assert calls == [[sys.executable, "-m", "pip", "install", "pandion[docling,lancedb,local]"]]


def test_a_broken_file_says_what_is_wrong(tmp_path, capsys):
    path = tmp_path / "pipeline.yaml"
    path.write_text("path: ./index\n", encoding="utf-8")

    assert cli.main(["install", str(path), "--print"]) == 2
    assert "no index" in capsys.readouterr().err


@pytest.mark.parametrize(
    "retrieve,extras",
    [
        ("  search: {use: bm25}\n", ["lancedb", "pdfium"]),
        ("  search: {use: dense}\n  rerank: [{use: mmr}, {use: cross_encoder}]\n", ["lancedb", "local", "pdfium"]),
        ("  rewrite: {use: llm_rewrite}\n  search: {use: dense}\n", ["anthropic", "lancedb", "pdfium"]),
        ("  search: {use: dense}\n  rerank: {use: llm_rerank, model: openrouter}\n", ["lancedb", "openai", "pdfium"]),
    ],
)
def test_the_retrieve_steps_add_their_extras(tmp_path, retrieve, extras):
    path = write(tmp_path, parser="pdfium", embedder="fake-deterministic")
    path.write_text(path.read_text(encoding="utf-8") + "retrieve:\n" + retrieve, encoding="utf-8")

    assert cli.extras_for(cli.load(path)) == extras


@pytest.fixture
def needs_extra():
    """A parse strategy and an embedder that name their own extras, removed after."""
    from pydantic import BaseModel

    from pandion.extend import ArtifactType, PortSpec, Stage, Transform, register
    from pandion.plugins import discover
    from pandion.registry import registry

    class NoSettings(BaseModel):
        pass

    class NeedsExtra(Transform[NoSettings]):
        name = "test_needs_extra"
        extra = "my-extra"
        stage = Stage.PARSE
        inputs = {"file": PortSpec(ArtifactType.RAW_FILE)}
        output = ArtifactType.PARSED_DOC
        config_model = NoSettings
        summary = "Needs an extra."

        def apply(self, inputs, config, ctx):
            raise NotImplementedError

    discover()
    register(NeedsExtra)
    yield NeedsExtra
    registry._by_stage[Stage.PARSE].pop(NeedsExtra.name, None)


def test_a_custom_strategy_names_the_extra_it_needs(tmp_path, needs_extra):
    path = write(tmp_path, parser="test_needs_extra", embedder="fake-deterministic")

    assert cli.extras_for(cli.load(path)) == ["lancedb", "my-extra"]


def test_extra_is_not_part_of_a_result_id():
    from pandion.embeddings import get_embedder
    from pandion.plugins.parse.pdfium import PdfiumParse

    assert PdfiumParse().fingerprint() == "none"
    assert "local" not in get_embedder("qwen3-embedding-0.6b").fingerprint()


@pytest.mark.parametrize(
    "key,change",
    [
        ("index.parse", lambda c: setattr(c.index, "parse", ("nope", {}))),
        ("index.store", lambda c: setattr(c.index, "store_use", "nope")),
        ("retrieve.search", lambda c: setattr(c.retrieve, "search", ("nope", {}))),
    ],
)
def test_an_unknown_strategy_name_is_a_plain_sentence(tmp_path, key, change):
    path = write(tmp_path, parser="pdfium", embedder="fake-deterministic")
    path.write_text(path.read_text(encoding="utf-8") + "retrieve:\n  search: {use: dense}\n", encoding="utf-8")
    config = cli.load(path)
    change(config)

    with pytest.raises(cli.ConfigError) as caught:
        cli.extras_for(config)
    assert str(caught.value) == f"{key} uses 'nope', which is not registered, so its extra is unknown."


@pytest.fixture
def source_needs_extra():
    from pydantic import BaseModel

    from pandion.extend import ArtifactType, Stage, Transform, raw_file, register
    from pandion.plugins import discover
    from pandion.registry import registry

    class Settings(BaseModel):
        location: str = ""

    class SrcNeedsExtra(Transform[Settings]):
        name = "test_src_needs_extra"
        extra = "src-extra"
        stage = Stage.SOURCE
        output = ArtifactType.RAW_FILE
        config_model = Settings
        summary = "A source that needs an extra."

        def apply(self, inputs, config, ctx):
            return raw_file(ctx, b"", "x.txt")

    discover()
    register(SrcNeedsExtra)
    yield
    registry._by_stage[Stage.SOURCE].pop(SrcNeedsExtra.name, None)


def test_a_custom_source_names_its_extra(tmp_path, source_needs_extra):
    path = write(tmp_path, parser="pdfium", embedder="fake-deterministic")
    text = path.read_text(encoding="utf-8").replace(
        "index:\n", "index:\n  source:\n    use: test_src_needs_extra\n", 1)
    path.write_text(text, encoding="utf-8")

    assert "src-extra" in cli.extras_for(cli.load(path))

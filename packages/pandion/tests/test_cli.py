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

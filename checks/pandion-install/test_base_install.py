"""Checks the base pandion install, with no extras, run by run_check.py.

It needs PANDION_CHECK_VENV, the new environment's folder, and
PANDION_CHECK_SAMPLES, the sample PDFs joined with os.pathsep.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

import pandion
from pandion import Pipeline
from pandion.errors import MissingExtra
from pandion.payloads import Element, ParsedDoc
from pandion.plugins.index.lancedb_store import LanceDbIndex, LanceDbIndexConfig
from pandion.ports import RunContext

VENV = Path(os.environ["PANDION_CHECK_VENV"]).resolve()
FILES = [Path(p) for p in os.environ["PANDION_CHECK_SAMPLES"].split(os.pathsep)]

YAML = """\
path: ./index
index:
  parse: {use: pdfium}
  chunk: {use: recursive_character, chunk_size: 400}
  embed: {use: fake-deterministic}
  store: {use: lancedb}
retrieve:
  search: {use: hybrid_rrf}
"""

PDFIUM = 'The pdfium parser needs pypdfium2. Install it with: pip install "pandion[pdfium]"'
LANCEDB = 'The lancedb index needs pyarrow. Install it with: pip install "pandion[lancedb]"'


def test_pandion_comes_from_the_new_environment():
    assert Path(pandion.__file__).resolve().is_relative_to(VENV)


def test_no_extra_is_installed():
    for module in ("pypdfium2", "lancedb", "torch", "docling"):
        with pytest.raises(ModuleNotFoundError):
            __import__(module)


def test_plugins_are_found():
    pandion.plugins.discover()


def test_cleaners_and_chunkers_run():
    doc = ParsedDoc(
        elements=[
            Element(id="h", type="heading", text="Chunking", order=0, level=1),
            Element(id="a", type="paragraph", text="Small pieces are easier to find.", order=1),
            Element(id="b", type="paragraph", text="Small pieces are easier to find.", order=2),
        ],
        page_count=1,
    )
    cleaned = pandion.clean(doc, steps=[{"use": "dedupe_blocks"}])
    assert len(cleaned.output.elements) == 2
    chunks = pandion.chunk(cleaned, use="recursive_character", chunk_size=400)
    assert chunks.output.chunks and "Small pieces" in chunks.output.chunks[0].text


def test_the_pdfium_parser_says_which_extra_to_install():
    with pytest.raises(MissingExtra) as caught:
        pandion.parse(FILES[0], use="pdfium")
    assert str(caught.value) == PDFIUM


def test_an_index_run_stops_at_the_parser_and_says_which_extra_to_install(tmp_path):
    (tmp_path / "pipeline.yaml").write_text(YAML, encoding="utf-8")
    report = Pipeline.from_yaml(tmp_path / "pipeline.yaml").index.run(FILES[0])
    (doc,) = report.documents.values()
    assert doc.stages["parse"].status == "failed"
    assert doc.stages["parse"].error.strip().endswith(PDFIUM)
    assert report.index.status == "skipped"


def test_the_lancedb_index_step_says_which_extra_to_install(tmp_path):
    # A run never reaches this step without a parser extra, so call the step itself.
    ctx = RunContext(output_dir=tmp_path, emit=lambda e: None, tmp=tmp_path)
    with pytest.raises(MissingExtra) as caught:
        LanceDbIndex().apply({"chunks": []}, LanceDbIndexConfig(embedder="fake-deterministic"), ctx)
    assert str(caught.value) == LANCEDB


def test_pandion_install_prints_the_extras_a_file_needs(tmp_path):
    (tmp_path / "pipeline.yaml").write_text(YAML, encoding="utf-8")
    pandion_exe = VENV / ("Scripts/pandion.exe" if os.name == "nt" else "bin/pandion")
    out = subprocess.run(
        [str(pandion_exe), "install", "pipeline.yaml", "--print"],
        cwd=tmp_path, capture_output=True, text=True, check=True,
    ).stdout
    assert out.strip().endswith('-m pip install "pandion[lancedb,pdfium]"')

"""Checks the first-run model download, run by `run_check.py --with-models`.

It runs in the environment with the `local` extra and downloads the smallest
real embedder, bge-small-en-v1.5, into a folder of its own.
"""

from __future__ import annotations

import os
import subprocess
import sys

import pytest

from pandion import ModelSettings
from pandion.embeddings import get_embedder
from pandion.models import ModelNotDownloaded

MODEL = "bge-small-en-v1.5"
EMBED = """\
import sys
from pandion import ModelSettings
from pandion.embeddings import get_embedder
settings = ModelSettings(cache_dir=sys.argv[1], download=sys.argv[2], device="cpu")
print(len(get_embedder("bge-small-en-v1.5", settings).embed(["How big should a chunk be?"])[0]))
"""


def embed(folder, download, **env) -> str:
    """Embed one text in a new process, so no model is already loaded."""
    return subprocess.run(
        [sys.executable, "-c", EMBED, str(folder), download],
        env={**os.environ, **env}, capture_output=True, text=True, check=True,
    ).stdout.strip()


def test_download_never_with_an_empty_folder_names_the_model_and_the_folder(tmp_path):
    settings = ModelSettings(cache_dir=tmp_path, download="never", device="cpu")
    with pytest.raises(ModelNotDownloaded) as caught:
        get_embedder(MODEL, settings).embed(["a question"])
    message = str(caught.value)
    assert "BAAI/bge-small-en-v1.5" in message and str(tmp_path) in message
    assert "download: never is set" in message
    assert not any(tmp_path.iterdir())


def test_download_auto_fetches_once_and_the_second_run_needs_no_network(tmp_path):
    assert embed(tmp_path, "auto") == "384"
    assert (tmp_path / "models--BAAI--bge-small-en-v1.5").is_dir()
    offline = {"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"}
    assert embed(tmp_path, "auto", **offline) == "384"
    assert embed(tmp_path, "never", **offline) == "384"

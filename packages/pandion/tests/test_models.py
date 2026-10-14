"""Model settings: where models are kept, whether they may download, and the device.

No test here loads a real model. The loader is replaced with a recorder, and
the `download: never` check runs against an empty folder, which needs no
network and no torch.
"""

from __future__ import annotations

import sys
import types

import pytest

from pandion import embeddings
from pandion.embeddings import get_embedder
from pandion.models import ModelNotDownloaded, ModelSettings, preload_embedder, resolve_device

BGE = embeddings.BgeSmallEnV15


@pytest.fixture
def loads(monkeypatch) -> list[tuple]:
    """Every call to the model loader, instead of loading anything."""
    calls: list[tuple] = []

    class Model:
        def encode(self, texts, **kwargs):
            import numpy as np

            out = np.zeros((len(texts), BGE.native_dim))
            out[:, 0] = 1.0
            return out

    def record(*args):
        calls.append(args)
        return Model()

    monkeypatch.setattr(embeddings, "_load_model", record)
    return calls


def test_the_defaults_download_on_first_use_and_pick_the_device():
    settings = ModelSettings()
    assert (settings.cache_dir, settings.download, settings.device) == (None, "auto", "auto")


def test_an_unknown_setting_is_an_error():
    with pytest.raises(ValueError, match="device"):
        ModelSettings(device="tpu")
    with pytest.raises(ValueError, match="dowload"):
        ModelSettings(dowload="never")


def test_a_named_device_is_used_as_it_is():
    assert resolve_device("cpu") == "cpu"
    assert resolve_device("cuda") == "cuda"


@pytest.mark.parametrize(
    "cuda,mps,expected", [(True, True, "cuda"), (False, True, "mps"), (False, False, "cpu")]
)
def test_auto_picks_cuda_then_mps_then_cpu(monkeypatch, cuda, mps, expected):
    torch = types.SimpleNamespace(
        cuda=types.SimpleNamespace(is_available=lambda: cuda),
        backends=types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: mps)),
    )
    monkeypatch.setitem(sys.modules, "torch", torch)
    assert resolve_device("auto") == expected


def test_preload_embedder_loads_the_model_with_the_settings(loads, tmp_path):
    settings = ModelSettings(cache_dir=tmp_path, device="cpu")

    preload_embedder("bge-small-en-v1.5", settings)

    assert loads == [(BGE.model_id, BGE.revision, BGE.dtype, settings)]


def test_preload_embedder_of_the_fake_loads_nothing(loads):
    preload_embedder("fake-deterministic")
    assert loads == []


def test_an_embedder_loads_with_the_settings_it_was_given(loads):
    settings = ModelSettings(device="cpu")

    get_embedder("bge-small-en-v1.5", settings).embed(["hello"])

    assert loads == [(BGE.model_id, BGE.revision, BGE.dtype, settings)]


def test_download_never_names_the_model_the_revision_and_the_folder(tmp_path):
    settings = ModelSettings(cache_dir=tmp_path, download="never", device="cpu")

    with pytest.raises(ModelNotDownloaded) as caught:
        preload_embedder("bge-small-en-v1.5", settings)

    message = str(caught.value)
    assert BGE.model_id in message
    assert BGE.revision in message
    assert str(tmp_path) in message
    assert "download: never" in message


def test_public_endpoints_only_is_off_by_default_and_can_be_set():
    from pandion import ModelSettings

    assert ModelSettings().public_endpoints_only is False
    assert ModelSettings(public_endpoints_only=True).public_endpoints_only is True

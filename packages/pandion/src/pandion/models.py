"""Model settings: where local models are kept, whether they may download, and the device.

These are run-time settings, never part of a recipe hash. The model id and its
revision already are (through the embedder's fingerprint and the embedding
cache key), and the folder a model is kept in does not change a vector. A run
hands them to the steps that load a model as `context_extras={"models":
ModelSettings(...)}`.

- `cache_dir` is the folder models are downloaded into. Empty means the
  Hugging Face default, which `HF_HOME` moves.
- `download: auto` downloads a model the first time it is used. `never` only
  loads a model already in the folder, and says which one is missing.
- `device: auto` picks cuda, then mps, then cpu.
- `public_endpoints_only: true` is for a server strangers share: a custom model
  endpoint must then be a public https address, and so must a URL given as a
  document (`pandion.fetch`).
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict

from pandion.errors import require


class ModelNotDownloaded(FileNotFoundError):
    """`download: never` is set and the model is not in the folder."""


class ModelSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cache_dir: Path | None = None
    download: Literal["auto", "never"] = "auto"
    device: Literal["auto", "cpu", "cuda", "mps"] = "auto"
    #: On a server strangers share: a step that calls a custom model endpoint
    #: accepts only a public https address (see pandion.endpoints). Never part
    #: of a result id.
    public_endpoints_only: bool = False


def resolve_device(device: str) -> str:
    """The device to load on: a named one as it is, or for `auto` the best one there is."""
    if device != "auto":
        return device
    torch = require("torch", extra="local", step="Choosing a device")
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def check_downloaded(model_id: str, revision: str, settings: ModelSettings) -> None:
    """With `download: never`, fail unless the model is already in the folder.

    Nothing is fetched: the check only looks in the folder.
    """
    if settings.download != "never":
        return
    hub = require("huggingface_hub", extra="local", step=f"The {model_id} model")
    folder = settings.cache_dir or Path(hub.constants.HF_HUB_CACHE)
    try:
        hub.snapshot_download(
            model_id, revision=revision, cache_dir=folder, local_files_only=True
        )
    except hub.errors.LocalEntryNotFoundError:
        raise ModelNotDownloaded(
            f"The model {model_id} at revision {revision} is not in {folder}, and "
            "download: never is set, so it was not downloaded. Download it once "
            "with download: auto, or copy it into that folder."
        ) from None


def preload_embedder(name: str, settings: ModelSettings | None = None) -> None:
    """Load the embedder called `name` now, so its first use does not wait.

    A model is loaded once per process, so a later run reuses it. The fake
    embedder has no model, so preloading it does nothing.
    """
    from pandion import embeddings

    embedder = embeddings.get_embedder(name, settings)
    if isinstance(embedder, embeddings.SentenceTransformerEmbedder):
        embeddings._load_model(
            embedder.model_id, embedder.revision, embedder.dtype, embedder.models
        )


def preload_reranker(
    model: str | None = None, settings: ModelSettings | None = None
) -> None:
    """Load a cross-encoder reranker now, so its first use does not wait.

    `model` is one of the cross_encoder step's models; None means the step's
    default. A model is loaded once per process, so a later run reuses it.
    """
    from pandion.plugins.rerank import cross_encoder

    cross_encoder._load(model or cross_encoder.CrossEncoderConfig().model, settings)


def preload_parser(use: str = "docling") -> None:
    """Load the `use` parser's models now, so its first run does not wait for them.
    A parser with no models to load (pdfium) does nothing."""
    from pandion.plugins import discover
    from pandion.ports import Stage
    from pandion.registry import UnknownTransformError, registry

    discover()
    try:
        registry.get(Stage.PARSE, use)
    except UnknownTransformError as exc:
        raise KeyError(exc.args[0]) from None
    if use == "docling":
        from pandion.plugins.parse import docling

        docling.preload(docling.DoclingConfig())

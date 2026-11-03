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


def download(model_id: str, revision: str, settings: ModelSettings) -> None:
    """Fetch the model at its pinned revision into the settings' folder (the
    Hugging Face default when it names none)."""
    hub = require("huggingface_hub", extra="local", step=f"The {model_id} model")
    folder = settings.cache_dir or Path(hub.constants.HF_HUB_CACHE)
    hub.snapshot_download(model_id, revision=revision, cache_dir=folder)


def models_for(config: dict) -> list[tuple[str, str]]:
    """The local models a pipeline (in `Pipeline.to_dict()` shape) uses, as
    (model id, pinned revision), each once. The docling parser is listed as
    ("docling", ""): it fetches its own layout and table models."""
    from pandion import embeddings
    from pandion.plugins.rerank import cross_encoder

    found: list[tuple[str, str]] = []

    def add(pair: tuple[str, str]) -> None:
        if pair not in found:
            found.append(pair)

    def walk(node: object) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item)
        elif isinstance(node, dict):
            embed = node.get("embed")
            if isinstance(embed, dict) and embed.get("use") in embeddings.embedder_names():
                provider = embeddings.get_embedder(embed["use"])
                if isinstance(provider, embeddings.SentenceTransformerEmbedder):
                    add((provider.model_id, provider.revision))
            if node.get("use") == "cross_encoder":
                settings = cross_encoder.CrossEncoderConfig(**{k: v for k, v in node.items() if k != "use"})
                add((settings.model, settings.revision or cross_encoder.PINNED.get(settings.model, "main")))
            if node.get("use") == "docling":
                add(("docling", ""))
            for value in node.values():
                walk(value)

    walk(config)
    return found


def _docling_blocks(node: object) -> list[dict]:
    """Every `use: docling` block in a pipeline dict, without its `use`."""
    if isinstance(node, list):
        return [b for item in node for b in _docling_blocks(item)]
    if not isinstance(node, dict):
        return []
    own = [{k: v for k, v in node.items() if k != "use"}] if node.get("use") == "docling" else []
    return own + [b for value in node.values() for b in _docling_blocks(value)]


def pull_models(pipeline, cache_dir: Path | str | None = None, each=None) -> list[tuple[str, str]]:
    """Download the public models `pipeline` uses, ahead of its first run.

    Each goes to `cache_dir`, else the file's `models.cache_dir`, else the
    Hugging Face default (Docling keeps its own models under HF_HOME and
    ignores both). A pull fetches the whole model repository. `each(model_id, revision)` is called after every
    model. Returns the models fetched (none for a pipeline with no local
    model). A failed download raises RuntimeError with one sentence and no
    token in it."""
    settings = pipeline.config.models
    if cache_dir:
        settings = settings.model_copy(update={"cache_dir": Path(cache_dir)})
    wanted = models_for(pipeline.to_dict())
    for model_id, revision in wanted:
        try:
            if model_id == "docling":
                for block in _docling_blocks(pipeline.to_dict()):
                    preload_parser("docling", block, images=True)
            else:
                download(model_id, revision, settings)
        except ImportError:
            raise
        except Exception as exc:
            raise RuntimeError(
                f"could not download {model_id}: {type(exc).__name__}. Check the network and try again."
            ) from None
        if each:
            each(model_id, revision)
    return wanted


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


def preload_parser(use: str = "docling", config: dict | None = None, images: bool = False) -> None:
    """Load the `use` parser's models now, so its first run does not wait for them.
    A parser with no models to load (pdfium) does nothing. `config` is the
    parser's block from the pipeline file (without `use`); `images` also loads
    the models for image files (OCR)."""
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

        docling.preload(docling.DoclingConfig(**(config or {})), images)

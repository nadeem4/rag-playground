"""Warm up the first-run models in the background.

The sample document's default graph parses with Docling and indexes with the
Qwen3 embedder, and each takes a while to load the first time. `start()` loads
both in a daemon thread, so the models are likely ready by the time the user
presses Run. It runs at most once per process, never blocks the caller, and a
failure is only logged: the run itself loads the models again if it has to.

Tests replace `_warm`, so no test ever loads a real model.
"""

from __future__ import annotations

import logging
import threading

log = logging.getLogger(__name__)

_lock = threading.Lock()
#: The warm-up thread, once started. None means not started in this process.
_thread: threading.Thread | None = None


def _warm() -> None:
    from docling.datamodel.base_models import InputFormat

    from plugins.parse.docling import DoclingConfig, _converter
    from providers.embeddings import Qwen3Embedding06B, _load_model

    _converter(DoclingConfig()).initialize_pipeline(InputFormat.PDF)
    qwen = Qwen3Embedding06B
    _load_model(qwen.model_id, qwen.revision, qwen.dtype)


def _run() -> None:
    try:
        _warm()
    except Exception:
        log.exception("model warm-up failed")


def start() -> None:
    """Start the warm-up unless this process already has."""
    global _thread
    with _lock:
        if _thread is not None:
            return
        _thread = threading.Thread(target=_run, name="model-warm-up", daemon=True)
        _thread.start()

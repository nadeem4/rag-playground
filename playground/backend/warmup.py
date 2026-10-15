"""Warm up the first-run models in the background.

The sample document's default graph parses with Docling and indexes with the
Qwen3 embedder, and each takes a while to load the first time; so do the
cross-encoders the first time someone reranks. `start()` loads them all in a
daemon thread, so the models are likely ready by the time the user presses
Run. It runs at most once per process, never blocks the caller, and a
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
    # Each part fails on its own: a Docling or Qwen3 failure is logged and the
    # reranker still warms.
    try:
        _warm_index_models()
    except Exception:
        log.exception("model warm-up failed")
    _warm_reranker()


def _warm_index_models() -> None:
    from playground.backend.deps import APP_MODELS
    from pandion import preload_embedder, preload_parser

    preload_parser("docling")
    preload_embedder("qwen3-embedding-0.6b", APP_MODELS)


#: The cross-encoders to warm, in order: None is the step's default, then the
#: model the Best precision, Vague questions and Chat answer templates use.
RERANKER_MODELS: tuple[str | None, ...] = (None, "BAAI/bge-reranker-v2-m3")


def _warm_reranker() -> None:
    """Load the default cross-encoder, then the templates' one. Each fails on
    its own, and a failed download is logged, never raised: the reranker loads
    the model again when it first runs."""
    from playground.backend.deps import APP_MODELS
    from pandion import preload_reranker

    for model in RERANKER_MODELS:
        try:
            preload_reranker(model, settings=APP_MODELS)
        except Exception:
            log.exception("cross-encoder warm-up failed for %s", model or "the default model")


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

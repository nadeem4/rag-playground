"""What one stage produced, in a form a person or an app can inspect."""

from __future__ import annotations

import gc
import re
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pandion.storage import META, Store


@dataclass
class StageResult:
    """One stage's output, and how it was made.

    `status` is "executed", "cached" or "failed". `artifact_id` is the recipe
    hash the output is stored under; it is None when the stage ran on its own,
    without a store. `note` is the one sentence the stage left about this run,
    such as what a cleaner removed. `usage` is what a model step's call used in
    this run, `{"input_tokens", "output_tokens", "model"}`, where a count the
    server did not send is None. It is None for a step that calls no model and
    for a cached step, which used nothing this time.
    """

    stage: str
    transform: str
    output: Any
    status: str = "executed"
    artifact_id: str | None = None
    duration_ms: float = 0.0
    note: str | None = None
    error: str | None = None
    usage: dict[str, Any] | None = None


#: What a result id looks like: a sha256 in lowercase hex.
_RESULT_ID = re.compile(r"[0-9a-f]{64}")


class ResultStore:
    """The results a pipeline stored under its `path`, read, described and cleared by id.

    An app that serves results by id needs no pipeline for it, only the
    folder. The id is checked before any path is built from it, so an app may
    pass one it was sent.
    """

    #: clear() attempts, and the pause between them: Windows refuses to delete a
    #: folder while anything (a LanceDB file map) still holds a file in it.
    RETRIES = 5
    RETRY_DELAY_S = 0.2

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._store = Store(self.path / "artifacts")

    def _checked(self, result_id: Any) -> str:
        if not isinstance(result_id, str) or not _RESULT_ID.fullmatch(result_id):
            raise KeyError(f"{result_id!r} is not a result id: one is 64 lowercase hex characters.")
        if not self._store.has(result_id):
            raise _unknown(result_id)
        return result_id

    def info(self, result_id: str) -> dict[str, Any]:
        """The result's id, its type, and the meta its step left (plain JSON)."""
        result_id = self._checked(result_id)
        try:
            artifact = self._store.get_meta(result_id)
        except FileNotFoundError:  # cleared since it was checked
            raise _unknown(result_id) from None
        return {"id": artifact.id, "type": str(artifact.type), "meta": artifact.meta}

    def get(self, result_id: str) -> Any:
        """The stored result: a dict for every result but an index, whose result is its folder."""
        result_id = self._checked(result_id)
        try:
            artifact = self._store.get_meta(result_id)
            return self._store.load(artifact.id, artifact.type)
        except FileNotFoundError:  # cleared since it was checked
            raise _unknown(result_id) from None

    def clear(self) -> dict[str, Any]:
        """Remove every stored result and the embedding cache. The documents stay.

        Clearing while a run is writing under the same path is not supported:
        the run may fail, or leave some of its results behind.
        """
        roots = (self._store.root, self.path / "embeddings")
        results, size = _usage(roots)
        for _ in range(self.RETRIES):
            for root in roots:
                shutil.rmtree(root, ignore_errors=True)
            if not any(root.exists() for root in roots):
                break
            gc.collect()  # drop any unreferenced LanceDB handle before trying again
            time.sleep(self.RETRY_DELAY_S)
        left, left_size = _usage(roots)
        return {
            "results": results - left,
            "bytes": size - left_size,
            "complete": not any(root.exists() for root in roots),
        }


def _unknown(result_id: str) -> KeyError:
    """The id is well formed, but nothing is stored under it. The folder is not
    named: a server hands this sentence back to whoever sent the id."""
    return KeyError(f"No stored result has the id {result_id}.")


def _usage(roots: tuple[Path, ...]) -> tuple[int, int]:
    """(stored results, bytes) under `roots`."""
    files = [p for root in roots if root.exists() for p in root.rglob("*") if p.is_file()]
    return sum(1 for p in files if p.name == META), sum(p.stat().st_size for p in files)

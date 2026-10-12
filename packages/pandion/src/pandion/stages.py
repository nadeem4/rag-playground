"""Run one stage on its own, without a pipeline or a store.

These calls are for trying a stage: they run the strategy directly and cache
nothing. A pipeline runs the same strategies through the executor and the
store, which caches every step by its recipe hash.
"""

from __future__ import annotations

import hashlib
import mimetypes
import tempfile
import time
from pathlib import Path
from typing import Any

from pandion.payloads import ParsedDoc
from pandion.plugins import discover
from pandion.ports import RunContext, Stage
from pandion.registry import registry
from pandion.results import StageResult


def parse(source: str | Path, *, use: str, **config: Any) -> StageResult:
    """Parse one file with the parser named `use` and its settings.

    `config` holds the parser's settings by name, as in its config model, for
    example `pandion.parse("a.pdf", use="docling", do_ocr=True)`.
    """
    discover()
    cls = registry.get(Stage.PARSE, use)
    settings = cls.config_model(**config)
    path = Path(source)
    raw = {
        "sha": hashlib.sha256(path.read_bytes()).hexdigest(),
        "filename": path.name,
        "path": str(path),
        "mime": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
    }
    with tempfile.TemporaryDirectory(prefix="pandion-") as scratch:
        ctx = RunContext(output_dir=Path(scratch), emit=lambda e: None, tmp=Path(scratch))
        started = time.perf_counter()
        payload = cls().apply({"file": raw}, settings, ctx)
        duration_ms = (time.perf_counter() - started) * 1000
    return StageResult(
        stage=str(Stage.PARSE),
        transform=use,
        output=ParsedDoc(**payload),
        duration_ms=duration_ms,
        note=ctx.extras.get("meta", {}).get("note"),
    )

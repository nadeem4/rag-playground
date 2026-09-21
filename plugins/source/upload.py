"""Resolve a file out of the global, content-addressed `sources/` directory.

Sources are global, not per-project (spec §8): the same PDF indexed three ways
is one file on disk, addressed by its sha256. The config carries the sha rather
than a path, so a graph is portable and a node's artifact id changes exactly
when the bytes do.

**Where `sources/` lives** is a module-level global, not `ctx.extras`: extras
carry per-run values (credentials) that the executor copies into every node,
while the source directory is process-wide. A module global is the one knob
that both the API server and a test can turn
(`monkeypatch.setattr(upload, "SOURCES_DIR", tmp_path)`).
"""

from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Any, Mapping

from pydantic import BaseModel

from core.artifacts import ArtifactType
from core.ports import RunContext, Stage
from core.registry import register
from core.transform import Transform

#: The global source directory. Rebind this to relocate the store.
SOURCES_DIR: Path = Path("sources")

#: What a file with no recognised extension is called.
DEFAULT_MIME = "application/octet-stream"


class UploadConfig(BaseModel):
    sha: str = ""
    filename: str = ""


@register
class Upload(Transform[UploadConfig]):
    """`() -> raw_file`. The root of every ingestion graph."""

    name = "upload"
    stage = Stage.SOURCE
    inputs = {}
    output = ArtifactType.RAW_FILE
    config_model = UploadConfig

    def apply(
        self, inputs: Mapping[str, Any], config: UploadConfig, ctx: RunContext
    ) -> dict[str, Any]:
        if not config.sha:
            raise ValueError(
                "upload: `sha` is empty — nothing to resolve. Upload a file "
                "first; the sha is what identifies it."
            )

        # The extension is part of the stored name, so the original filename is
        # what tells us which file in `sources/` the sha refers to.
        path = SOURCES_DIR / f"{config.sha}{Path(config.filename).suffix}"
        if not path.is_file():
            raise FileNotFoundError(f"upload: no source at {path}")

        filename = config.filename or path.name
        return {
            "sha": config.sha,
            "filename": filename,
            "path": str(path),
            "mime": mimetypes.guess_type(filename)[0] or DEFAULT_MIME,
        }

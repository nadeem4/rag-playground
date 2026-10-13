"""Resolve a file out of a content-addressed sources folder.

The same PDF indexed three ways is one file on disk, addressed by its sha256
(`pandion.sources.Sources`). The config carries the sha rather than a path, so
a graph is portable and a node's artifact id changes exactly when the bytes do.

**Where the folder is** comes with the run, as
`context_extras={"sources": Sources(folder)}`. It is never part of the config,
so moving the folder moves no artifact id.
"""

from __future__ import annotations

from typing import Any, Mapping

from pydantic import BaseModel

from pandion.artifacts import ArtifactType
from pandion.ports import RunContext, Stage
from pandion.registry import register
from pandion.sources import file_record, run_sources
from pandion.transform import Explanation, Transform


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
    summary = (
        "Takes a file you uploaded. Files are stored once, named by a "
        "fingerprint of their bytes, so the same file used in several pipelines "
        "is a single copy on disk."
    )

    def explain(self, config: UploadConfig) -> Explanation:
        if not config.sha:
            # `apply` raises on an empty sha: say so before the run.
            return Explanation(
                settings="No file is chosen yet.",
                warning="Choose a file first; there is nothing to read yet.",
                blocking=True,
            )
        name = config.filename or "the file"
        return Explanation(
            settings=(
                f"Reads {name}, fingerprint {config.sha[:12]}. A file that differs "
                "by even one byte gets a new fingerprint, so every later step "
                "runs again for it, while the same file reuses earlier results."
            ),
        )

    def apply(
        self, inputs: Mapping[str, Any], config: UploadConfig, ctx: RunContext
    ) -> dict[str, Any]:
        if not config.sha:
            raise ValueError(
                "upload: `sha` is empty, so there is nothing to resolve. Upload a file "
                "first; the sha is what identifies it."
            )

        sources = run_sources(ctx, "upload")
        # The extension is part of the stored name, so the original filename is
        # what tells us which stored file the sha refers to.
        path = sources.path(config.sha, config.filename)
        if not path.is_file():
            raise FileNotFoundError(f"upload: no source at {path}")

        return file_record(config.sha, config.filename or path.name, path)

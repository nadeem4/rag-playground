"""Source files, kept once and named by a fingerprint of their bytes.

`Sources(folder)` is the folder. A file is stored as `<sha256><suffix>`, so the
same document used in several pipelines is one file on disk, and a pipeline
names a file by its sha rather than by a path. The `upload` step finds a file
here through the run's `context_extras={"sources": Sources(folder)}`.
"""

from __future__ import annotations

import hashlib
import mimetypes
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

#: What a file with no recognised extension is called.
DEFAULT_MIME = "application/octet-stream"


@dataclass(frozen=True)
class SourceFile:
    """One stored file: its fingerprint and the name it came with."""

    sha: str
    filename: str


class Sources:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)

    def path(self, sha: str, filename: str) -> Path:
        """Where the file with this fingerprint and name is kept."""
        return self.root / f"{sha}{Path(filename).suffix}"

    def add(self, path: str | Path) -> SourceFile:
        """Store the file at `path` under its own name."""
        path = Path(path)
        return self.add_bytes(path.read_bytes(), path.name)

    def add_bytes(self, data: bytes, filename: str) -> SourceFile:
        """Store `data` as a file called `filename`, unless it is already here.

        The bytes are written to a side file and renamed into place, so a
        reader never sees half a file.
        """
        sha = hashlib.sha256(data).hexdigest()
        dest = self.path(sha, filename)
        if not dest.is_file():
            self.root.mkdir(parents=True, exist_ok=True)
            part = dest.with_name(dest.name + ".part")
            part.write_bytes(data)
            os.replace(part, dest)
        return SourceFile(sha=sha, filename=filename)


def run_sources(ctx: Any, step: str) -> Sources:
    """The run's sources folder, or a plain error that names `step`."""
    sources = ctx.extras.get("sources") if ctx is not None else None
    if not isinstance(sources, Sources):
        raise ValueError(
            f"{step}: the run did not say where source files are kept. Pass "
            'context_extras={"sources": Sources(folder)} to the run.'
        )
    return sources


def file_record(
    sha: str, filename: str, path: Path, metadata: dict[str, str] | None = None
) -> dict[str, Any]:
    """What a source step returns: a raw file is a stored file, not its bytes.
    `metadata` is labels the source knows about the document; a route can read
    them with the `metadata` check."""
    record = {
        "sha": sha,
        "filename": filename,
        "path": str(path),
        "mime": mimetypes.guess_type(filename)[0] or DEFAULT_MIME,
    }
    if metadata:
        record["metadata"] = dict(metadata)
    return record


def raw_file(
    ctx: Any, data: bytes, filename: str, metadata: dict[str, str] | None = None
) -> dict[str, Any]:
    """Store `data` as a source file called `filename` and return what a
    source step returns, the same as the upload source: sha, filename, path
    and mime, plus `metadata` when given. A custom source ends with
    `return raw_file(ctx, data, filename)`."""
    sources = run_sources(ctx, "raw_file")
    stored = sources.add_bytes(data, filename)
    return file_record(stored.sha, filename, sources.path(stored.sha, filename), metadata)

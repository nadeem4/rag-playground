"""Source files, kept once and named by a fingerprint of their bytes.

`Sources(folder)` is the folder. A file is stored as `<sha256><suffix>`, so the
same document used in several pipelines is one file on disk, and a pipeline
names a file by its sha rather than by a path. The `upload` step finds a file
here through the run's `context_extras={"sources": Sources(folder)}`.
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path


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

"""Documents: each uploaded file once, by its fingerprint, with a record beside it.

A file is kept as `<sha256><suffix>` in the `sources/` folder under the
server's data folder, the name Pandion's own upload step looks for. Its record
(`sources/.meta/<sha>.json`) holds the name it came with, its size and its
content type, and any other key a site's Policy adds, such as who uploaded it;
a client is shown only the first four. A question set written for it lives in
`sources/questions/<sha>.json`.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

#: A document id is a sha256 in lowercase hex. Checked before an id reaches a
#: path, so a crafted one such as `../../x` never leaves the folder.
SHA = re.compile(r"^[0-9a-f]{64}\Z")
#: The 404 for a document that is not there, or not for this caller. It never
#: repeats the id the request sent.
NO_SUCH_DOCUMENT = "There is no document with that fingerprint."
META_DIR = ".meta"
QUESTIONS_DIR = "questions"
#: Held around every change to a record, here, in a Policy and in a site's own
#: clean-up, so two uploads of the same bytes, or an upload and a clean-up,
#: never lose what the other wrote.
SIDECAR_LOCK = threading.Lock()
#: The part of a request's file name that reaches a path: a plain suffix such
#: as `.pdf`. Anything else (a `:` that names a Windows stream, a space, a
#: separator) is dropped, and the file is kept under its sha alone.
SAFE_SUFFIX = re.compile(r"^\.[A-Za-z0-9_-]{1,16}$")

#: The refusal for a name ending in `.part`: a stored file with that suffix
#: would look like a half-written one, which every reader skips.
PART_REFUSED = "A file name ending in .part cannot be uploaded; rename it and try again."

_PUBLIC = ("sha", "filename", "size", "content_type")


def suffix(filename: str) -> str:
    """The suffix a file is stored with: its name's, when it is a plain one, else none."""
    found = Path(filename).suffix
    return found if SAFE_SUFFIX.match(found) else ""


def is_part(filename: str) -> bool:
    """Whether the name ends in `.part`, in any case (see PART_REFUSED)."""
    return filename.lower().endswith(".part")


def read_sidecar(path: Path) -> dict[str, Any]:
    """A record's JSON, or {} when it is missing, unreadable, or not an object."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


@dataclass(frozen=True)
class Document:
    sha: str
    filename: str
    size: int
    content_type: str
    #: Every other key in the record, for the site's Policy. Never shown.
    extra: dict[str, Any] = field(default_factory=dict)

    def record(self) -> dict[str, Any]:
        """What a client is shown."""
        return {"sha": self.sha, "filename": self.filename, "size": self.size, "content_type": self.content_type}

    @classmethod
    def of(cls, body: dict[str, Any]) -> Document | None:
        """The document a record describes, or None for one without a valid id and name."""
        sha, filename = body.get("sha"), body.get("filename")
        if not isinstance(sha, str) or not SHA.match(sha) or not isinstance(filename, str):
            return None
        size, content_type = body.get("size"), body.get("content_type")
        return cls(
            sha=sha,
            filename=filename,
            size=size if isinstance(size, int) else 0,
            content_type=content_type if isinstance(content_type, str) else "application/octet-stream",
            extra={k: v for k, v in body.items() if k not in _PUBLIC},
        )


class DocumentStore:
    lock = SIDECAR_LOCK

    def __init__(self, folder: str | Path) -> None:
        self.folder = Path(folder)

    def sidecar(self, sha: str) -> Path:
        return self.folder / META_DIR / f"{sha}.json"

    def questions(self, sha: str) -> Path:
        return self.folder / QUESTIONS_DIR / f"{sha}.json"

    def save(self, data: bytes, filename: str) -> str:
        """Keep `data` as `<sha><suffix of filename>`, unless a file with this sha
        is here already, under any suffix: the same bytes are never stored
        twice, whatever they are called. Only a plain suffix comes from the
        name (see `suffix`). The bytes go to a side file first and are renamed
        into place, so a reader never sees half a file. Returns the sha."""
        sha = hashlib.sha256(data).hexdigest()
        dest = self.folder / f"{sha}{suffix(filename)}"
        if self.file(sha) is None:
            self.folder.mkdir(parents=True, exist_ok=True)
            part = dest.with_name(dest.name + ".part")
            part.write_bytes(data)
            os.replace(part, dest)
        return sha

    def write(self, sha: str, filename: str, size: int, content_type: str) -> Document:
        """Write the record. Keys a site added stay. Call with `lock` held."""
        path = self.sidecar(sha)
        path.parent.mkdir(parents=True, exist_ok=True)
        body = {**read_sidecar(path), "sha": sha, "filename": filename, "size": size, "content_type": content_type}
        path.write_text(json.dumps(body), encoding="utf-8")
        return Document.of(body)

    def get(self, sha: str) -> Document | None:
        if not SHA.match(sha):
            return None
        return Document.of(read_sidecar(self.sidecar(sha)))

    def all(self) -> list[Document]:
        meta = self.folder / META_DIR
        if not meta.is_dir():
            return []
        found = (Document.of(read_sidecar(p)) for p in meta.glob("*.json"))
        return [d for d in found if d is not None]

    def file(self, sha: str) -> Path | None:
        """The stored file, or None. A seeded file with no record is found too."""
        if not SHA.match(sha) or not self.folder.is_dir():
            return None
        for p in sorted(self.folder.glob(f"{sha}*")):
            if p.is_file() and not p.name.endswith(".part"):
                return p
        return None

    def remove(self, sha: str) -> None:
        """Delete the file, its record and its question set. Call with `lock` held."""
        if not SHA.match(sha):
            return
        for p in self.folder.glob(f"{sha}*"):
            if p.is_file():
                p.unlink()
        self.sidecar(sha).unlink(missing_ok=True)
        self.questions(sha).unlink(missing_ok=True)

"""Where documents come from when a sync reads a source, not a folder.

A `Source` lists its documents (a stable id and a version for each, no bytes)
and reads one document's bytes on request. `IndexPipeline.sync` lists the
source, reads only the entries that are new or whose version changed, and
leaves the rest as they are. `Source` is a Stable contract.

`FilesSource` reads any location fsspec understands: a local folder, or
`gs://`, `s3://` and so on once the matching fsspec package is installed.
fsspec is imported only when the source is used, so importing this module
loads nothing heavy.
"""

from __future__ import annotations

import mimetypes
from dataclasses import dataclass, field
from typing import Any, ClassVar, Iterable, Protocol, runtime_checkable

from pandion.errors import require


@dataclass(frozen=True)
class SourceEntry:
    """One document a source holds: its id, a version that changes when the
    document does, and labels that a new document in the index starts with."""

    doc_id: str
    version: str
    metadata: dict[str, str] = field(default_factory=dict)


@runtime_checkable
class Source(Protocol):
    """Stable contract: a named place documents are listed from and read from."""

    name: ClassVar[str]

    def list(self) -> Iterable[SourceEntry]:
        """Every document, without its bytes."""
        ...

    def read(self, doc_id: str) -> bytes:
        """The bytes of one document."""
        ...


_SOURCES: dict[str, type] = {}


def register_source(cls: type) -> type:
    """Add a source by its `name`. A second source with the same name is refused."""
    old = _SOURCES.get(cls.name)
    if old is not None and old is not cls:
        raise ValueError(
            f"Two sources are named '{cls.name}': one in {old.__module__} and one in {cls.__module__}. "
            "Rename one of them."
        )
    _SOURCES[cls.name] = cls
    return cls


def source_names() -> tuple[str, ...]:
    return tuple(sorted(_SOURCES))


def source_class(name: str) -> type:
    if name not in _SOURCES:
        raise ValueError(f"There is no source named '{name}'. Choose one of: {', '.join(source_names())}.")
    return _SOURCES[name]


def get_source(name: str, **settings: Any) -> Source:
    """Build the source called `name` with `settings`."""
    return source_class(name)(**settings)


_VERSION_KEYS = ("ETag", "etag", "generation", "md5Hash")
_TIME_KEYS = ("mtime", "LastModified", "updated", "last_modified")


@register_source
class FilesSource:
    """Every file under a location fsspec can open, sorted by id.

    The id is the file's path relative to the location, with forward slashes.
    """

    name: ClassVar[str] = "files"

    def __init__(self, location: str, *, storage_options: dict[str, Any] | None = None) -> None:
        self.location = location
        self.storage_options = dict(storage_options or {})
        self._fs: Any = None
        self._root = ""

    def _open(self) -> tuple[Any, str]:
        if self._fs is None:
            core = require("fsspec.core", extra="files", step="the files source")
            self._fs, root = core.url_to_fs(self.location, **self.storage_options)
            self._root = str(root).replace("\\", "/").rstrip("/")
        return self._fs, self._root

    def list(self) -> Iterable[SourceEntry]:
        fs, root = self._open()
        if not fs.exists(root):
            raise ValueError(f"The location {self.location} does not exist. Check the path or address.")
        found = fs.find(root, detail=True)
        entries = []
        for path, info in found.items():
            doc_id = str(path).replace("\\", "/")[len(root):].lstrip("/")
            if not doc_id:
                continue
            entries.append(SourceEntry(doc_id, _version(info), _labels(doc_id, info)))
        return sorted(entries, key=lambda e: e.doc_id)

    def read(self, doc_id: str) -> bytes:
        fs, root = self._open()
        return fs.cat_file(f"{root}/{doc_id}")


def _version(info: dict[str, Any]) -> str:
    for key in _VERSION_KEYS:
        if info.get(key):
            return str(info[key])
    mtime = next((info[k] for k in _TIME_KEYS if info.get(k) is not None), "")
    return f"{mtime}:{info.get('size', '')}"


def _labels(doc_id: str, info: dict[str, Any]) -> dict[str, str]:
    content_type = mimetypes.guess_type(doc_id)[0] or "application/octet-stream"
    custom = info.get("metadata")
    extra = {k: v for k, v in custom.items() if isinstance(v, str)} if isinstance(custom, dict) else {}
    return {**extra, "path": doc_id, "content_type": content_type}

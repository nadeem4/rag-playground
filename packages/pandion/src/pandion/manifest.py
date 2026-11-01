"""The sync manifest: what the index under a pipeline's `path` was built from.

`manifest.json` holds a hash of the index settings, the artifact id of the
index, and for each document its content hash and the artifact id of its
pieces. `p.index.sync` reads it to say what was added, changed, removed or left
unchanged, and writes it again after a sync that worked.

```json
{
  "index_recipe": "<sha256 of the index settings>",
  "index_artifact": "<artifact id of the lancedb index>",
  "documents": {
    "guides/chunking.pdf": {
      "content_hash": "<sha256 of the bytes>", "chunk_set": "<artifact id>",
      "category": "reports", "reason": "Rule 1: path matches guides/**"
    },
    "https://example.com/guide": {
      "content_hash": "...", "chunk_set": "...", "category": "text",
      "reason": "Chosen when added", "metadata": {"team": "ops"}, "filename": "guide.html"
    }
  }
}
```

A document id is the file's path inside the synced folder with forward
slashes, so a manifest written on Windows reads the same on Linux. A URL
document's id is its URL, and its entry also has `filename`: the name the
fetched page was stored under, whose suffix came from its content type
(`pandion.fetch`). An entry has `filename` only when it differs from the last
part of the id, so the entries of local files are as before.

An entry synced from a `Source` also has `version`: the source's version of the document,
so the next sync can skip reading a document whose version is the same.

An entry also records the document's `category` and the `reason` for it, and
its `metadata` labels when it has any. A document keeps them until it is moved,
even when its bytes change or the route changes. An entry from before
categories has none of the three and counts as unsorted: the next sync sorts it.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any

from pandion.errors import FormatTooNew
from pandion.ids import canonical_json

MANIFEST = "manifest.json"


def recipe_hash(index_settings: Any) -> str:
    """A sha256 of the index settings (an `IndexConfig`), in canonical JSON.

    No enrich step is left out, so an index made before the enrich stage
    existed keeps its hash. An old file (one default category) hashes as it
    always did. With categories, each category's steps are hashed but not its
    name or template, and the route never is: sorting a document differently
    does not change how a category reads it."""
    index = index_settings
    steps = {"store": index.store, "store_use": index.store_use, "source": index.source}
    if index.enrich is not None:
        steps["enrich"] = index.enrich
    if index.legacy:
        default = index.default
        settings = {**steps, "parse": default.parse, "chunk": default.chunk, "clean": default.clean}
    else:
        categories = {
            key: {"parse": c.parse, "chunk": c.chunk, "clean": c.clean} for key, c in index.categories.items()
        }
        settings = {**steps, "categories": categories}
    return hashlib.sha256(canonical_json(settings).encode("utf-8")).hexdigest()


FORMAT_VERSION: int = 1


@dataclass
class Manifest:
    #: Older files are read as they are; a newer one is refused.
    format_version: int = FORMAT_VERSION
    index_recipe: str | None = None
    index_artifact: str | None = None
    #: document id -> {"content_hash", "chunk_set", "category", "reason", ...}
    documents: dict[str, dict[str, Any]] = field(default_factory=dict)

    @classmethod
    def load(cls, path: str | Path) -> Manifest:
        """The manifest at `path`, or an empty one if there is none yet."""
        path = Path(path)
        if not path.is_file():
            return cls()
        data = json.loads(path.read_text(encoding="utf-8"))
        version = data.get("format_version", 1)
        if version > FORMAT_VERSION:
            raise FormatTooNew(
                f"{path} was written by a newer Pandion (manifest format {version}; "
                f"this one reads up to {FORMAT_VERSION}). Upgrade pandion."
            )
        known = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in data.items() if k in known})

    def save(self, path: str | Path) -> None:
        """Write to a side file and rename it into place, so a reader never
        sees half a manifest."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        part = path.with_name(path.name + ".part")
        part.write_text(json.dumps(asdict(self), indent=2, sort_keys=True), encoding="utf-8")
        os.replace(part, path)

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
    "guides/chunking.pdf": {"content_hash": "<sha256 of the bytes>", "chunk_set": "<artifact id>"},
    "https://example.com/guide": {"content_hash": "...", "chunk_set": "...", "filename": "guide.html"}
  }
}
```

A document id is the file's path inside the synced folder with forward
slashes, so a manifest written on Windows reads the same on Linux. A URL
document's id is its URL, and its entry also has `filename`: the name the
fetched page was stored under, whose suffix came from its content type
(`pandion.fetch`). An entry has `filename` only when it differs from the last
part of the id, so the entries of local files are as before.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from pandion.ids import canonical_json

MANIFEST = "manifest.json"


def recipe_hash(index_settings: Any) -> str:
    """A sha256 of the index settings (an `IndexConfig`), in canonical JSON.

    No enrich step is left out, so an index made before the enrich stage
    existed keeps its hash."""
    settings = asdict(index_settings)
    if settings.get("enrich") is None:
        settings.pop("enrich", None)
    return hashlib.sha256(canonical_json(settings).encode("utf-8")).hexdigest()


@dataclass
class Manifest:
    index_recipe: str | None = None
    index_artifact: str | None = None
    #: document id -> {"content_hash": ..., "chunk_set": ...}
    documents: dict[str, dict[str, str]] = field(default_factory=dict)

    @classmethod
    def load(cls, path: str | Path) -> Manifest:
        """The manifest at `path`, or an empty one if there is none yet."""
        path = Path(path)
        if not path.is_file():
            return cls()
        return cls(**json.loads(path.read_text(encoding="utf-8")))

    def save(self, path: str | Path) -> None:
        """Write to a side file and rename it into place, so a reader never
        sees half a manifest."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        part = path.with_name(path.name + ".part")
        part.write_text(json.dumps(asdict(self), indent=2, sort_keys=True), encoding="utf-8")
        os.replace(part, path)

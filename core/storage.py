"""Content-addressed artifact store with a crash-safe commit protocol.

Every write goes to a private temp directory under the store root and is moved
into place only after it has completed. `meta.json` is written *last*, inside
that temp directory, and its presence at the final path is the sole signal that
an entry is committed.

That ordering is the whole design. A process killed mid-write leaves either a
`.tmp-*` directory (never consulted by `has()`) or, in the worst case, a
half-moved destination directory without `meta.json` — also not a hit. There is
no code path that produces a cache hit for an entry that was not finished.
"""

from __future__ import annotations

import json
import shutil
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator, Protocol

from core.artifacts import Artifact, ArtifactType
from core.ids import shard_path

META = "meta.json"


class Serializer(Protocol):
    """How a payload of a given artifact type is laid out inside its directory."""

    def write(self, payload: Any, d: Path) -> None: ...
    def read(self, d: Path) -> Any: ...


class JsonSerializer:
    """The default: one `payload.json` per artifact."""

    def write(self, payload: Any, d: Path) -> None:
        if hasattr(payload, "model_dump"):
            payload = payload.model_dump(mode="json")
        (d / "payload.json").write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8"
        )

    def read(self, d: Path) -> Any:
        return json.loads((d / "payload.json").read_text(encoding="utf-8"))


class DirectorySerializer:
    """For payloads written in place — indexes, image sets.

    `payload` is a callable taking the destination directory. Reading returns the
    directory itself; the caller opens it (e.g. a LanceDB connection). The store
    deliberately holds no handle on it, so the commit-time move never races an
    open file on Windows.
    """

    def write(self, payload: Callable[[Path], None], d: Path) -> None:
        payload(d)

    def read(self, d: Path) -> Path:
        return d


SERIALIZERS: dict[ArtifactType, Serializer] = {t: JsonSerializer() for t in ArtifactType}
SERIALIZERS[ArtifactType.INDEX] = DirectorySerializer()


def register_serializer(t: ArtifactType, ser: Serializer) -> None:
    SERIALIZERS[t] = ser


class Store:
    def __init__(self, root: Path) -> None:
        self.root = Path(root)

    def path_for(self, artifact_id: str) -> Path:
        ab, cd, sid = shard_path(artifact_id)
        return self.root / ab / cd / sid

    def has(self, artifact_id: str) -> bool:
        """meta.json is written LAST, so its presence alone means committed."""
        return (self.path_for(artifact_id) / META).is_file()

    @contextmanager
    def open_writer(self, artifact_id: str) -> Iterator[Path]:
        """Yield a scratch directory; move it into place only on a clean exit."""
        self.root.mkdir(parents=True, exist_ok=True)
        tmp = self.root / f".tmp-{uuid.uuid4().hex}"
        tmp.mkdir()
        try:
            yield tmp
        except BaseException:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
        dest = self.path_for(artifact_id)
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            # Replacing (a non-cacheable node re-ran). Uncommit first, so an old
            # entry that Windows will not fully delete is never served as a hit.
            (dest / META).unlink(missing_ok=True)
            shutil.rmtree(dest, ignore_errors=True)
            if dest.exists():
                # Moving onto a surviving directory would nest tmp inside it.
                shutil.rmtree(tmp, ignore_errors=True)
                raise OSError(f"could not replace artifact {artifact_id}: in use")
        shutil.move(str(tmp), str(dest))

    def put(self, artifact: Artifact, payload: Any) -> Artifact:
        ser = SERIALIZERS[artifact.type]
        with self.open_writer(artifact.id) as d:
            ser.write(payload, d)
            # meta.json LAST — it is the commit marker.
            (d / META).write_text(
                json.dumps(
                    {
                        "id": artifact.id,
                        "type": str(artifact.type),
                        "meta": artifact.meta,
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
        return artifact

    def get_meta(self, artifact_id: str) -> Artifact:
        raw = json.loads(
            (self.path_for(artifact_id) / META).read_text(encoding="utf-8")
        )
        return Artifact(
            id=raw["id"], type=ArtifactType(raw["type"]), meta=raw["meta"]
        )

    def load(self, artifact_id: str, t: ArtifactType) -> Any:
        return SERIALIZERS[t].read(self.path_for(artifact_id))

    def clear(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

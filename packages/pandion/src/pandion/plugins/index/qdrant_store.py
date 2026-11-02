"""A Qdrant index: the same step as `lancedb`, with the rows in Qdrant.

Embedded (a folder, the default) it needs no server; with a `url` it uses a
Qdrant server. The shared work is in `StoreIndex`; this file only says which
store, which extra and which settings. The key for a server is never a
setting: `api_key_env` names the environment variable that holds it.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import Field

from pandion.errors import require
from pandion.index_qdrant import QdrantSettings, QdrantStore
from pandion.index_store import IndexStore
from pandion.plugins.index.lancedb_store import StoreIndex, StoreIndexConfig, _here
from pandion.ports import RunContext
from pandion.registry import register


class QdrantIndexConfig(StoreIndexConfig):
    metric: Literal["cosine", "dot", "l2"] = Field(
        default="cosine",
        title="Distance",
        json_schema_extra={
            "x-labels": {
                "cosine": "Cosine: the angle between vectors",
                "dot": "Dot: the angle and the length",
                "l2": "L2: the straight-line distance",
            }
        },
        description=(
            "How closeness between vectors is measured: cosine compares their "
            "direction, dot their direction and length, l2 their straight-line distance."
        ),
    )
    settings: QdrantSettings = Field(
        default_factory=QdrantSettings,
        title="Qdrant",
        description=(
            "Where Qdrant is. Leave the url empty to keep the rows in a folder beside the "
            "pipeline, or give the url of a Qdrant server. The key is read from the "
            "environment variable named in api_key_env."
        ),
    )


@register
class QdrantIndex(StoreIndex):
    __abstract_transform__ = False
    name = "qdrant"
    extra = "qdrant"
    provides = {"backends": ["dense", "fts"], "format": ["store"]}
    config_model = QdrantIndexConfig
    summary = (
        "Turns every piece into a vector (a list of numbers that captures its "
        "meaning) with an embedding model, and stores it in Qdrant, in a folder "
        "or on a Qdrant server, with a keyword index over the same rows. Vector "
        "search and keyword search then read the same pieces, which is what lets "
        "hybrid search combine them fairly."
    )

    def _require(self) -> None:
        require("qdrant_client", extra="qdrant", step="The qdrant index")

    def _settings(self, config: QdrantIndexConfig, ctx: RunContext) -> tuple[dict[str, Any], dict[str, Any]]:
        mine = config.settings.model_dump()
        server = bool(mine["url"])
        # Memory would vanish before a retriever opened it, so "no place given" is the pipeline's folder.
        folder = not server and mine["location"] in ("", ":memory:")
        settings = {**mine, "location": _here(ctx)} if folder else dict(mine)
        kept = dict(settings)
        # The pipeline's own place is not kept (the folder may move); whoever opens it says.
        if server or (folder and ctx.extras.get("index_location")):
            kept.pop("location")
        return settings, kept

    def _make_store(self, settings: dict[str, Any]) -> IndexStore:
        return QdrantStore(QdrantSettings(**settings))

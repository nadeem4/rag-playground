"""The recipe hash — the load-bearing invariant of the whole system.

Every artifact's identity is derived from how it was made, never from what it
contains. That single rule buys caching, reproducibility, and stage independence
at once: running three chunkers against one parse is automatically three cache
misses downstream of one cache hit upstream.
"""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any, ClassVar

from pydantic import BaseModel, SerializerFunctionWrapHandler, model_serializer

from pandion.artifacts import ArtifactType


def _reject_nonfinite(obj: Any) -> None:
    """NaN and Infinity are not valid JSON and would produce unstable ids."""
    if isinstance(obj, float) and not math.isfinite(obj):
        raise ValueError(f"non-finite float is not canonicalizable: {obj!r}")
    if isinstance(obj, dict):
        for value in obj.values():
            _reject_nonfinite(value)
    elif isinstance(obj, (list, tuple)):
        for value in obj:
            _reject_nonfinite(value)


def canonical_json(obj: Any) -> str:
    """Stable JSON: sorted keys, no whitespace, no non-finite floats.

    Always canonicalize a *validated* Pydantic model's `model_dump(mode="json")`,
    never a raw request dict — otherwise "field omitted, server filled default"
    and "field sent at its default" produce two ids for one configuration.
    """
    _reject_nonfinite(obj)
    return json.dumps(
        obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    )


def compute_artifact_id(
    *,
    transform_name: str,
    transform_version: str,
    fingerprint: str,
    output_type: ArtifactType,
    config: dict[str, Any],
    inputs: dict[str, Any],
) -> str:
    """Hash the recipe.

    `inputs` is keyed by *port name*, deliberately. Hashing `sorted(input_ids)`
    instead would give a node with two same-typed inputs an identical id when its
    wires are swapped — silent cache corruption in the one subsystem whose entire
    value is being trustworthy.

    `fingerprint` covers model id, revision, and provider API version. Without it,
    swapping a checkpoint yields a cache *hit* on a different model.
    """
    parts = [
        transform_name,
        transform_version,
        fingerprint,
        str(output_type),
        canonical_json(config),
        canonical_json(inputs),
    ]
    return hashlib.sha256("\x00".join(parts).encode("utf-8")).hexdigest()


def short_id(artifact_id: str) -> str:
    """16 hex chars for use in paths.

    Windows MAX_PATH is 260 and a nested store directory gets close. 2**64 is
    ample collision resistance for a local bench.
    """
    return artifact_id[:16]


def shard_path(artifact_id: str) -> tuple[str, str, str]:
    """Two levels of sharding, so no directory holds tens of thousands of entries."""
    sid = short_id(artifact_id)
    return sid[0:2], sid[2:4], sid


class AddedSettings(BaseModel):
    """The settings model of a step that gained settings after its results were first stored.

    A setting named in `added` is left out of `model_dump()` while it holds
    its default. An artifact id hashes that dump, so every result stored
    before the setting existed keeps its id, and nobody's cache rebuilds;
    set to anything else, the setting is dumped and the id moves, as it must.
    Changing such a default later is a change to what the step does, so it
    needs a `version` bump, like any other.
    """

    added: ClassVar[tuple[str, ...]] = ()

    @model_serializer(mode="wrap")
    def _added_left_out_at_default(self, handler: SerializerFunctionWrapHandler) -> dict[str, Any]:
        data = handler(self)
        fields = type(self).model_fields
        for name in type(self).added:
            if name in data and getattr(self, name) == fields[name].default:
                del data[name]
        return data

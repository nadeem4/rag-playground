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
from typing import Any

from core.artifacts import ArtifactType


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

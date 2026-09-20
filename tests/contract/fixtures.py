"""Canonical minimal payloads, one per artifact type.

Every future plugin phase builds its slow-half contract tests on these: hand a
transform the smallest legal payload for each of its input ports and assert it
does not blow up. Keeping them here — rather than inline in each plugin's tests
— means one place to update when a payload shape changes.

An empty `index` cannot be synthesized without a backend (there is no such thing
as an index that is not *some* index), so INDEX opts out via `HAS_MINIMAL` and
index transforms are exercised only in the slow, model-marked half.
"""

from __future__ import annotations

from typing import Any

from core.artifacts import ArtifactType

#: Artifact types a minimal payload can be synthesized for. Everything else is
#: an explicit opt-out, not an oversight.
HAS_MINIMAL: set[ArtifactType] = {
    ArtifactType.RAW_FILE,
    ArtifactType.QUERY,
    ArtifactType.PARSED_DOC,
    ArtifactType.CHUNK_SET,
    ArtifactType.RETRIEVAL_RESULT,
    ArtifactType.OUTPUT,
    ArtifactType.QA_SET,
}

_MINIMAL: dict[ArtifactType, Any] = {
    ArtifactType.RAW_FILE: {
        "sha": "0" * 64,
        "filename": "empty.pdf",
        "mime": "application/pdf",
    },
    ArtifactType.QUERY: {
        "text": "",
        "variants": [],
        "embed_text": None,
        "filters": None,
        "history": [],
        "transform_trace": [],
    },
    ArtifactType.PARSED_DOC: {
        "elements": [],
        "page_count": 0,
        "source_id": "0" * 16,
        "filename": "empty.pdf",
        "doc_meta": {},
        "parser_meta": {},
    },
    ArtifactType.CHUNK_SET: {"chunks": [], "chunker_meta": {}},
    ArtifactType.RETRIEVAL_RESULT: {
        "hits": [],
        "query_id": "0" * 16,
        "fetch_k": 0,
        "total_candidates": 0,
        "timings_ms": {},
    },
    ArtifactType.OUTPUT: {"kind": "search", "payload": {}},
    ArtifactType.QA_SET: {"items": []},
}


def minimal_payload(t: ArtifactType) -> Any:
    """The smallest legal payload for `t`.

    Raises `KeyError` for types that opted out, so a caller can never silently
    receive a stand-in that is not actually a valid value of the type.
    """
    if t not in HAS_MINIMAL:
        raise KeyError(f"no minimal fixture for {t}")
    return _MINIMAL[t]

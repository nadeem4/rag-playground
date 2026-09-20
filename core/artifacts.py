"""Artifact types and the immutable artifact value.

An artifact is what a transform produces: an immutable value identified by a
recipe hash (see `core.ids`). The payload itself lives on disk and is loaded
lazily; `meta` is small and always in memory.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class ArtifactType(StrEnum):
    """The value types that flow between pipeline stages.

    A StrEnum rather than a Literal so that `inputs = {"file": ArtifactType.RAW_FILE}`
    typechecks in plugins without an explicit annotation, and so it serializes to
    JSON as a plain string.
    """

    RAW_FILE = "raw_file"
    QUERY = "query"
    PARSED_DOC = "parsed_doc"
    CHUNK_SET = "chunk_set"
    INDEX = "index"
    RETRIEVAL_RESULT = "retrieval_result"
    OUTPUT = "output"
    QA_SET = "qa_set"


@dataclass(frozen=True)
class Artifact:
    """A committed pipeline value.

    `id` is a *recipe* hash, not a content hash — it is computed from the
    transform and its inputs before the payload exists. That is sound only for
    deterministic transforms; see `Transform.deterministic`.
    """

    id: str
    type: ArtifactType
    meta: dict[str, Any] = field(default_factory=dict)

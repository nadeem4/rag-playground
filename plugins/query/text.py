"""The literal query: whatever is typed into the node's config.

Trivial on purpose. Making the query a *node* rather than a run parameter is
what makes sweeping over queries free — the sweep primitive already varies one
node's config, so it varies questions with no extra machinery, and each question
gets its own cached retrieval.
"""

from __future__ import annotations

from typing import Any, Mapping

from pydantic import BaseModel

from core.artifacts import ArtifactType
from core.payloads import Query
from core.ports import RunContext, Stage
from core.registry import register
from core.transform import Transform


class TextQueryConfig(BaseModel):
    text: str = ""


@register
class TextQuery(Transform[TextQueryConfig]):
    """`() -> query`. Usually bound ambiently, never by an explicit edge."""

    name = "text"
    stage = Stage.QUERY
    inputs = {}
    output = ArtifactType.QUERY
    config_model = TextQueryConfig

    def apply(
        self, inputs: Mapping[str, Any], config: TextQueryConfig, ctx: RunContext
    ) -> dict[str, Any]:
        return Query(text=config.text).model_dump(mode="json")

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
from core.transform import Explanation, Transform


class TextQueryConfig(BaseModel):
    text: str = ""

    #: The sentence in the document that answers this question (I-23). Empty
    #: means "not an evaluation question", and nothing else behaves differently.
    gold_answer: str = ""


@register
class TextQuery(Transform[TextQueryConfig]):
    """`() -> query`. Usually bound ambiently, never by an explicit edge."""

    name = "text"
    stage = Stage.QUERY
    inputs = {}
    output = ArtifactType.QUERY
    config_model = TextQueryConfig
    summary = (
        "The question, exactly as you type it. It is a step of its own so that "
        "trying another question reruns only retrieval and what follows, "
        "reusing everything before it."
    )

    def explain(self, config: TextQueryConfig) -> Explanation:
        text = config.text.strip()
        if not text:
            return Explanation(
                settings="No question yet.",
                warning=(
                    "The question is empty, so retrieval will return no hits. "
                    "The ingest steps still run."
                ),
            )
        shown = text if len(text) <= 120 else text[:119] + "…"
        gold = config.gold_answer.strip()
        graded = (
            " It also carries a gold answer: the sentence in the document that "
            "answers it, which the evaluation step looks for among the retrieved "
            "pieces."
            if gold
            else ""
        )
        return Explanation(
            settings=(
                f'Asks "{shown}". Vector search turns it into a vector marked as a '
                "question, as the model was trained to expect, and keyword search "
                f"matches its words as typed.{graded}"
            ),
            tradeoff=(
                "Using the document's own terms helps keyword search most; "
                "vector search copes better with different wording."
            ),
        )

    def apply(
        self, inputs: Mapping[str, Any], config: TextQueryConfig, ctx: RunContext
    ) -> dict[str, Any]:
        return Query(
            text=config.text, gold_answer=config.gold_answer
        ).model_dump(mode="json")

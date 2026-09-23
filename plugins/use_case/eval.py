"""Eval: did retrieval actually find the answer, for this one question?

The whole point is to replace an impression with a number, and the number has to
survive a change of settings. So gold is **text, not a chunk id**. A chunk id
only exists for one chunking setting, which means a label tied to ids stops
meaning anything exactly when you want to compare settings. Each question
carries the sentence in the document that answers it, and a result counts as a
hit when one of the retrieved pieces contains that sentence.

Matching is deliberately narrow. Exact containment first, then a normalised
comparison that collapses whitespace, rejoins a word hyphenated at a line end
and folds case, because parsers disagree about spacing and nothing else. There
is no fuzzy tier: a near miss is a miss, and the report says which kind of match
it was, so a run is never flattered by a loose rule you cannot see.

`top_k` is what the reader would actually have looked at. A gold sentence that
sits below it is a miss, not a hit, and `considered` says how many pieces were
checked, so a miss can be told apart from a short list.

A question may carry several gold passages (I-32), because a document often
answers the same question in more than one place. Any one of them counts as
found: `hit`, `rank` and `match` speak for the first retrieved piece that holds
any of them, and `golds_found` out of `golds_total` says how many were covered,
which is what a recall-at-k number is made of.
"""

from __future__ import annotations

import re
from typing import Any, Mapping

from pydantic import BaseModel

from core.artifacts import ArtifactType
from core.payloads import Output, Query, RetrievalResult
from core.ports import PortSpec, RunContext, Stage
from core.registry import register
from core.transform import Explanation, Transform

#: A hyphen at the end of a line, with the rest of the word on the next one.
_LINE_HYPHEN = re.compile(r"-\s*\n\s*")

NO_GOLD = (
    "This question has no gold answer, so there is nothing to look for. Set "
    "gold_answer (or gold_answers) on the query node (the question step) to the "
    "sentence in the document that answers it."
)


class EvalConfig(BaseModel):
    #: How many of the retrieved pieces count as "what the reader would see".
    top_k: int = 5


@register
class EvalUseCase(Transform[EvalConfig]):
    """`retrieval_result (+ query) -> output`."""

    name = "eval"
    stage = Stage.USE_CASE
    inputs = {
        "result": PortSpec(ArtifactType.RETRIEVAL_RESULT),
        # Ambient: the question and its gold answer travel together, and the
        # query node is never adjacent to the last node in the column.
        "query": PortSpec(ArtifactType.QUERY, ambient=True),
    }
    output = ArtifactType.OUTPUT
    config_model = EvalConfig

    #: Arithmetic over its inputs, with nothing to re-roll.
    cacheable = True
    deterministic = True

    summary = (
        "Checks whether the retrieved pieces contain the sentence that answers "
        "the question, and reports where it was found. No language model, no "
        "API key and no cost: it compares text with text."
    )

    learn = {
        "_strategy": {
            "hint": (
                "This step marks one question right or wrong by looking for its "
                "answer sentence in the retrieved pieces."
            ),
            "more": [
                "Every question carries the sentence in the document that "
                "answers it. A piece that contains that sentence is a hit, and "
                "the rank of the first such piece says how far down the reader "
                "would have had to look.",
                "The answer is a sentence rather than a piece number on purpose. "
                "Piece numbers change the moment you change how the document is "
                "cut, so a score built on them could never compare two settings. "
                "A sentence stays the same sentence.",
                "The comparison is strict. The sentence has to be there, give or "
                "take spacing, a word broken across a line and capital letters. "
                "Something that merely looks close counts as a miss, which is "
                "what keeps the number honest.",
            ],
        },
        "top_k": {
            "hint": (
                "Only this many of the retrieved pieces are checked, because "
                "that is what the reader would have looked at."
            ),
            "more": [
                "An answer that sits below this line is reported as a miss. "
                "That is the point: a piece nobody reads cannot help.",
                "Raising it makes more questions count as hits, and makes the "
                "score say less about how well the pieces were ordered. Lowering "
                "it is a harder test of the ranking.",
            ],
        },
    }

    def explain(self, config: EvalConfig) -> Explanation:
        k = config.top_k
        settings = (
            f"Looks for the question's gold answer in the top {k} of the pieces "
            "it receives, and says whether it was found, at which rank, and in "
            "which piece. A question with several gold answers counts as found "
            "when any one of them is there, and the report says how many of "
            "them were. The sentence has to be there word for word, allowing "
            "only for different spacing, a word broken across a line and "
            "capital letters. The report says which of those two kinds of match "
            "it was. No language model and no API key."
        )
        if k < 1:
            return Explanation(
                settings=settings,
                warning=(
                    "top_k must be at least 1, or nothing is checked and every "
                    "question is a miss."
                ),
                blocking=True,
            )
        return Explanation(
            settings=settings,
            tradeoff=(
                "A larger top_k counts an answer found far down the list as a "
                "hit, so the score says more about retrieval and less about the "
                "order. A smaller one is a stricter test of the ranking."
            ),
        )

    def apply(
        self, inputs: Mapping[str, Any], config: EvalConfig, ctx: RunContext
    ) -> dict[str, Any]:
        result = RetrievalResult.model_validate(inputs["result"])
        query = Query.model_validate(inputs["query"])
        golds = query.golds
        if not golds:
            raise ValueError(NO_GOLD)

        considered = result.hits[: max(config.top_k, 0)]
        normalised = [_normalise(gold) for gold in golds]
        found: set[int] = set()
        rank: int | None = None
        matched_chunk_id = ""
        match = "none"

        for hit in considered:
            text = hit.chunk.text
            normalised_text: str | None = None
            for n, gold in enumerate(golds):
                if n in found:
                    continue
                if gold in text:
                    kind = "exact"
                else:
                    if normalised_text is None:
                        normalised_text = _normalise(text)
                    if normalised[n] not in normalised_text:
                        continue
                    kind = "normalized"
                found.add(n)
                if rank is None:
                    # The first piece the reader would have reached that holds
                    # any of the gold passages.
                    rank, matched_chunk_id, match = hit.rank, hit.chunk.id, kind
            if len(found) == len(golds):
                break

        return Output(
            kind="eval",
            payload={
                "question": query.text,
                "gold_answer": golds[0],
                "hit": match != "none",
                "rank": rank,
                "matched_chunk_id": matched_chunk_id,
                "match": match,
                "golds_total": len(golds),
                "golds_found": len(found),
                "considered": len(considered),
                "total_candidates": result.total_candidates,
            },
        ).model_dump(mode="json")


def _normalise(text: str) -> str:
    """The same sentence as a parser with other habits would have written it."""
    return " ".join(_LINE_HYPHEN.sub("", text).split()).casefold()

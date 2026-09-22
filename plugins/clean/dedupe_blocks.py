"""Remove blocks that repeat text an earlier block already carries.

Boilerplate — a licence notice, a repeated abstract, a table caption echoed
under every table — inflates the index with passages that are all equally good
matches for the same query, so the top-k fills with copies of one answer and
the second-best *distinct* passage never surfaces.

Two scopes:

* `exact` — normalized text (whitespace collapsed, case folded) must match.
  Cheap, and the only safe default: it never removes text a reader would call
  different.
* `near` — `difflib.SequenceMatcher` ratio must reach `similarity`. Pure
  stdlib; no embedding model, no ML dependency. Catches the OCR-drifted and
  re-typeset copies that `exact` misses.

The first occurrence in reading order always survives, which is what keeps the
result a fixed point: every kept block was compared against all previously kept
blocks, so no two survivors are within the threshold and a second pass finds
nothing.

Comparison is keyed on `(type, text)`, never text alone. A heading "Summary"
and a paragraph "Summary" are a section title and its first line, not a
duplicate — dropping the paragraph would delete real content on a coincidence.
"""

from __future__ import annotations

from difflib import SequenceMatcher
from typing import Any, Literal, Mapping

from pydantic import BaseModel, Field

from core.artifacts import ArtifactType
from core.payloads import Element
from core.ports import PortSpec, RunContext, Stage
from core.registry import register
from core.transform import Explanation, Transform
from plugins.clean import apply_edits, as_parsed_doc, make_report, normalize, report_entry


class DedupeBlocksConfig(BaseModel):
    similarity: float = Field(
        default=0.95,
        ge=0.0,
        le=1.0,
        description="Minimum difflib ratio to call two blocks duplicates. "
        "Only consulted when `scope` is 'near'.",
    )
    scope: Literal["exact", "near"] = Field(
        default="exact",
        description="'exact' compares normalized text; 'near' compares by "
        "similarity ratio.",
    )


def _near_duplicate(
    key: str, candidates: list[tuple[Element, str]], similarity: float
) -> tuple[Element, float] | None:
    """First kept block within `similarity`, or None.

    `real_quick_ratio` and `quick_ratio` are cheap upper bounds on `ratio`, so
    a block that cannot possibly match is rejected on its length alone rather
    than by aligning it.
    """
    for element, other in candidates:
        matcher = SequenceMatcher(None, key, other)
        if matcher.real_quick_ratio() < similarity:
            continue
        if matcher.quick_ratio() < similarity:
            continue
        ratio = matcher.ratio()
        if ratio >= similarity:
            return element, ratio
    return None


@register
class DedupeBlocks(Transform[DedupeBlocksConfig]):
    name = "dedupe_blocks"
    stage = Stage.CLEAN
    inputs = {"doc": PortSpec(ArtifactType.PARSED_DOC)}
    output = ArtifactType.PARSED_DOC
    config_model = DedupeBlocksConfig
    summary = (
        "Removes a block whose text repeats an earlier block, keeping the first "
        "copy in reading order. Blocks are compared only with blocks of the same "
        "kind, so a heading and a paragraph with the same words are both kept."
    )

    def explain(self, config: DedupeBlocksConfig) -> Explanation:
        s = config.similarity
        if config.scope == "exact":
            return Explanation(
                settings=(
                    "Exact mode: two blocks are copies when their text matches "
                    "after ignoring case and spacing. The similarity threshold "
                    f"({s:.2f}) is only used in near mode."
                ),
                tradeoff=(
                    "Exact never removes text a reader would call different, but "
                    "misses copies that differ by a single character, such as a "
                    "typo or an OCR slip."
                ),
            )
        warning = None
        if s <= 0.5:
            warning = (
                f"At {s:.0%} similarity, blocks that share only part of their "
                "characters count as copies, so real content is likely to be "
                "removed."
            )
        return Explanation(
            settings=(
                "Near mode: a block is removed when its text is at least "
                f"{s:.0%} the same, character by character, as an earlier block "
                "of the same kind."
            ),
            tradeoff=(
                "Near mode catches copies with small differences, but a low "
                "threshold can remove genuinely different blocks that share most "
                "of their wording, such as numbered clauses."
            ),
            warning=warning,
        )

    def apply(
        self, inputs: Mapping[str, Any], config: DedupeBlocksConfig, ctx: RunContext
    ):
        doc = as_parsed_doc(inputs["doc"])

        exact_index: dict[tuple[str, str], Element] = {}
        near_index: dict[str, list[tuple[Element, str]]] = {}
        removed: list[dict[str, Any]] = []

        for element in sorted(doc.elements, key=lambda e: e.order):
            key = normalize(element.text)
            # A blank block carries no text to duplicate. Collapsing every empty
            # block into one would silently merge unrelated figures and tables,
            # whose meaning is in their metadata, not their text.
            if not key:
                continue

            twin = exact_index.get((element.type, key))
            reason = f"exact duplicate of '{twin.id}'" if twin else ""

            if twin is None and config.scope == "near":
                found = _near_duplicate(
                    key, near_index.get(element.type, []), config.similarity
                )
                if found is not None:
                    twin, ratio = found
                    reason = (
                        f"near-duplicate of '{twin.id}' "
                        f"(similarity {ratio:.2f} >= {config.similarity:.2f})"
                    )

            if twin is not None:
                removed.append(
                    report_entry(element, duplicate_of=twin.id, reason=reason)
                )
                continue

            exact_index[(element.type, key)] = element
            near_index.setdefault(element.type, []).append((element, key))

        if not removed:
            return apply_edits(doc)

        report = make_report(
            self.name,
            self.version,
            config.model_dump(mode="json"),
            removed=removed,
            retyped=[],
            kept_count=len(doc.elements) - len(removed),
        )
        return apply_edits(
            doc, remove={row["id"] for row in removed}, report=report
        )

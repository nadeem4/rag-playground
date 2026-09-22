"""Remove every block whose text matches a pattern.

The two automatic cleaners cannot catch every kind of boilerplate. A repeated
notice that a parser labels as ordinary body text is not a running head
(`header_footer_strip` skips long blocks and anything mid-page), and
`dedupe_blocks` keeps its first copy because keeping one original is what
de-duplication means. When you already know the text you do not want indexed,
naming it is the standard tool.

Two modes:

* `contains` is a plain substring test. The pattern is never read as a regex,
  so `1+1` or `[1](` match themselves.
* `regex` is `re.search`, so it is unanchored unless the pattern anchors it.

Case is ignored unless `case_sensitive` is set. An empty pattern changes
nothing and writes no report, which keeps the cleaner a fixed point: a second
pass over its own output finds nothing to remove.
"""

from __future__ import annotations

import re
from typing import Any, Callable, Literal, Mapping

from pydantic import BaseModel, Field

from core.artifacts import ArtifactType
from core.ports import PortSpec, RunContext, Stage, set_note
from core.registry import register
from core.transform import Explanation, Transform
from plugins.clean import apply_edits, as_parsed_doc, make_report, report_entry


class DropMatchingConfig(BaseModel):
    pattern: str = Field(
        default="",
        description="Text to look for. Any block containing it is removed. "
        "Leave empty to remove nothing.",
    )
    mode: Literal["contains", "regex"] = Field(
        default="contains",
        description="'contains' matches the pattern as plain text; 'regex' "
        "treats it as a regular expression found anywhere in the block.",
    )
    case_sensitive: bool = Field(
        default=False,
        description="Match upper and lower case exactly. Off means 'Notice' "
        "also matches 'notice'.",
    )


def _matcher(config: DropMatchingConfig) -> Callable[[str], bool]:
    if config.mode == "regex":
        flags = 0 if config.case_sensitive else re.IGNORECASE
        try:
            compiled = re.compile(config.pattern, flags)
        except re.error as exc:
            raise ValueError(
                f"drop_matching: invalid regex '{config.pattern}': {exc}"
            ) from exc
        return lambda text: compiled.search(text) is not None

    if config.case_sensitive:
        return lambda text: config.pattern in text
    needle = config.pattern.casefold()
    return lambda text: needle in text.casefold()


@register
class DropMatching(Transform[DropMatchingConfig]):
    name = "drop_matching"
    stage = Stage.CLEAN
    inputs = {"doc": PortSpec(ArtifactType.PARSED_DOC)}
    output = ArtifactType.PARSED_DOC
    config_model = DropMatchingConfig
    summary = (
        "Removes every block whose text contains a pattern you name. Use it for "
        "boilerplate the automatic cleaners miss, such as a notice repeated in "
        "the middle of pages."
    )

    def explain(self, config: DropMatchingConfig) -> Explanation:
        how = "as a regular expression" if config.mode == "regex" else "as plain text"
        case = "matching case exactly" if config.case_sensitive else "ignoring case"
        if not config.pattern:
            return Explanation(
                settings=(
                    "No pattern is set, so nothing is removed. Once you add one, "
                    f"it will be matched {how}, {case}."
                ),
            )
        if config.mode == "regex":
            try:
                _matcher(config)
            except ValueError as exc:
                cause = str(exc.__cause__ or exc)
                return Explanation(
                    settings=f"Matches the regular expression {config.pattern}, {case}.",
                    warning=(
                        f"This is not a valid regular expression ({cause}), so "
                        "the step would fail."
                    ),
                    blocking=True,
                )
            target = f"the regular expression {config.pattern} matches anywhere"
        else:
            target = f'"{config.pattern}" appears as plain text'
        return Explanation(
            settings=f"Removes every block where {target}, {case}.",
            tradeoff=(
                "The whole block goes, not just the matching words, so a short "
                "pattern can remove a paragraph of real content that merely "
                "mentions it."
            ),
        )

    def apply(
        self, inputs: Mapping[str, Any], config: DropMatchingConfig, ctx: RunContext
    ):
        doc = as_parsed_doc(inputs["doc"])
        if not config.pattern:
            return apply_edits(doc)

        matches = _matcher(config)
        reason = f"matched pattern '{config.pattern}'"
        removed = [
            report_entry(element, reason=reason)
            for element in sorted(doc.elements, key=lambda e: e.order)
            if matches(element.text)
        ]
        if not removed:
            set_note(ctx, "The pattern matched no block, so nothing was removed.")
            return apply_edits(doc)

        report = make_report(
            self.name,
            self.version,
            config.model_dump(mode="json"),
            removed=removed,
            retyped=[],
            kept_count=len(doc.elements) - len(removed),
        )
        return apply_edits(doc, remove={row["id"] for row in removed}, report=report)

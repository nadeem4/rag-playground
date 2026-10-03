"""Shared machinery for the CLEAN stage.

A cleaner is the only kind of transform that *destroys* content, so the two
things every cleaner in this package must get right live here rather than in
each plugin:

1. **The rebuild.** Removing an element invalidates three things at once — the
   `order` sequence (now has holes), any `parent_id` pointing at it (now
   dangling), and every `md_start`/`md_end` offset after it (now shifted).
   `apply_edits` fixes all three in one place so no cleaner can fix two and
   forget the third.
2. **The report.** Silent removal teaches nothing. Every cleaner appends one
   entry to `parser_meta["clean_report"]`, which is a *list* so a stack of
   cleaners reads back as an ordered diff of the whole pipeline rather than the
   last cleaner's opinion.

This module deliberately imports no sibling module: `header_footer_strip` and
`dedupe_blocks` import *from* this package, so importing them here would be a
cycle. Plugin discovery imports the plugin modules directly.
"""

from __future__ import annotations

import re
from typing import Any, Collection, Mapping

from core.payloads import Element, ParsedDoc

#: Where a cleaner's diff goes. A key inside `parser_meta` rather than a new
#: top-level field, because `ParsedDoc` is a payload shared with the parse stage
#: and `core/` is out of scope for a plugin to change.
REPORT_KEY = "clean_report"

#: Enough of a removed block to recognise it in the UI without carrying a whole
#: paragraph into the artifact's metadata.
PREVIEW_CHARS = 80

_WHITESPACE = re.compile(r"\s+")


def as_parsed_doc(value: Any) -> ParsedDoc:
    """Accept either a `ParsedDoc` or the JSON dict the store reads back.

    The executor hands a freshly executed payload downstream in memory but
    re-reads a cached one from disk, so a cleaner sees both shapes.
    """
    return value if isinstance(value, ParsedDoc) else ParsedDoc.model_validate(value)


def normalize(text: str) -> str:
    """Case- and whitespace-insensitive form, for comparing two blocks.

    Deliberately keeps digits: `Section 1` and `Section 2` are different
    sections, not one running head seen twice.
    """
    return _WHITESPACE.sub(" ", text).strip().casefold()


def preview(text: str) -> str:
    flat = _WHITESPACE.sub(" ", text).strip()
    return flat if len(flat) <= PREVIEW_CHARS else flat[: PREVIEW_CHARS - 1] + "…"


def report_entry(element: Element, **extra: Any) -> dict[str, Any]:
    """The common half of a report row: what it was and where it was."""
    return {
        "id": element.id,
        "type": element.type,
        "page": element.page,
        "order": element.order,
        "preview": preview(element.text),
        **extra,
    }


def make_report(
    cleaner: str,
    version: str,
    config: Mapping[str, Any],
    *,
    removed: list[dict[str, Any]],
    retyped: list[dict[str, Any]],
    kept_count: int,
) -> dict[str, Any]:
    return {
        "cleaner": cleaner,
        "version": version,
        "config": dict(config),
        "removed": removed,
        "retyped": retyped,
        "removed_count": len(removed),
        "kept_count": kept_count,
    }


def _nearest_surviving(
    parent_id: str | None,
    parent_of: Mapping[str, str | None],
    alive: Collection[str],
) -> str | None:
    """Climb until an ancestor survives.

    Reparenting rather than clearing: a paragraph that hung off a dropped
    running head still belongs to whatever contained the head, and a chunker
    walking the tree would otherwise see it as a second root. `None` only when
    no ancestor survives at all. The `seen` guard means a malformed parent cycle
    in the input degrades to a cleared parent instead of hanging.
    """
    seen: set[str] = set()
    while parent_id is not None and parent_id not in alive:
        if parent_id in seen:
            return None
        seen.add(parent_id)
        parent_id = parent_of.get(parent_id)
    return parent_id


def apply_edits(
    doc: ParsedDoc,
    *,
    retype: Mapping[str, str] | None = None,
    remove: Collection[str] = (),
    report: Mapping[str, Any] | None = None,
) -> ParsedDoc:
    """Return a new `ParsedDoc` with `remove` gone and `retype` applied.

    Guarantees, in one place, every invariant a cleaner owes its consumer:

    * `order` is total and contiguous from 0, with the survivors' relative
      order untouched;
    * no `parent_id` names a removed element;
    * `md_start`/`md_end` are cleared, because after an edit they describe a
      projection that no longer exists. `render_markdown()` clears them on entry
      too, but returning a doc carrying offsets that are *wrong* rather than
      merely absent is how an offset-based chunker silently mis-cites.

    With nothing to do it returns an unedited deep copy, so a cleaner that finds
    nothing is exactly the identity — which is what makes stacking a cleaner
    twice equal to applying it once.
    """
    retype = dict(retype or {})
    remove = set(remove)
    if not retype and not remove:
        return doc.model_copy(deep=True)

    ordered = sorted(doc.elements, key=lambda e: e.order)
    survivors = [e for e in ordered if e.id not in remove]
    alive = {e.id for e in survivors}
    parent_of = {e.id: e.parent_id for e in doc.elements}

    elements: list[Element] = []
    for position, element in enumerate(survivors):
        fresh = element.model_copy(deep=True)
        if fresh.id in retype:
            fresh.type = retype[fresh.id]  # type: ignore[assignment]
        fresh.order = position
        fresh.parent_id = _nearest_surviving(fresh.parent_id, parent_of, alive)
        fresh.md_start = None
        fresh.md_end = None
        elements.append(fresh)

    out = doc.model_copy(deep=True)
    out.elements = elements
    if report is not None:
        out.parser_meta.setdefault(REPORT_KEY, []).append(dict(report))
    return out


#: Past this many pages, a note says "across 12 pages" instead of listing them.
MAX_PAGES_NAMED = 5


def plural(count: int, word: str) -> str:
    """`1 block`, `2 blocks`: the simple English plural a run note needs."""
    return f"{count} {word}" if count == 1 else f"{count} {word}s"


def join_words(items: list[str]) -> str:
    """`a`, `a and b`, `a, b and c`."""
    if len(items) <= 1:
        return "".join(items)
    return f"{', '.join(items[:-1])} and {items[-1]}"


def count_by_kind(kinds: list[str], names: Mapping[str, str] | None = None) -> str:
    """`2 paragraphs and 1 list item`, in the order each kind first appears.

    A kind is the element type with underscores as spaces, unless `names`
    gives it a plainer word (a `header` is a `running header` to a reader).
    """
    counts: dict[str, int] = {}
    for kind in kinds:
        counts[kind] = counts.get(kind, 0) + 1
    names = names or {}
    return join_words(
        [plural(n, names.get(k, k.replace("_", " "))) for k, n in counts.items()]
    )


def page_phrase(pages: list[int | None], preposition: str) -> str:
    """` on pages 1, 2 and 3`, or empty when any block has no page."""
    if not pages or any(p is None for p in pages):
        return ""
    unique = sorted(set(pages))
    if len(unique) == 1:
        return f" {preposition} page {unique[0]}"
    if len(unique) > MAX_PAGES_NAMED:
        return f" across {len(unique)} pages"
    return f" {preposition} pages {join_words([str(p) for p in unique])}"


def removed_note(
    rows: list[dict[str, Any]], detail: str = "", names: Mapping[str, str] | None = None
) -> str:
    """`Removed 2 blocks: 2 paragraphs{detail}.`, the opening every cleaner uses."""
    return (
        f"Removed {plural(len(rows), 'block')}: "
        f"{count_by_kind([r['type'] for r in rows], names)}{detail}."
    )


#: The note for a cleaner that removed nothing starts with this.
NOTHING_REMOVED = "Removed 0 blocks. "

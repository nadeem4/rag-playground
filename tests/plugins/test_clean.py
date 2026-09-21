"""Tests for the clean-stage plugins.

A cleaner is the one kind of transform that *destroys* content, so the tests
here are weighted towards the invariants that make destruction safe: contiguous
ordering, no dangling parents, unchanged relative order, a re-projectable
markdown view, idempotence, and a report that says exactly what went and why.

Both cleaners are `parsed_doc -> parsed_doc`, so they stack. The composition
tests are not decoration: stacking is the reason the CLEAN stage exists in
`core.ports.STACKABLE`.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from core.artifacts import ArtifactType
from core.payloads import Element, ParsedDoc
from core.ports import PortSpec, RunContext, Stage
from core.registry import registry
from plugins.clean.dedupe_blocks import DedupeBlocks
from plugins.clean.drop_matching import DropMatching
from plugins.clean.header_footer_strip import HeaderFooterStrip

# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def el(
    eid: str,
    text: str,
    order: int,
    *,
    etype: str = "paragraph",
    page: int | None = None,
    parent_id: str | None = None,
    level: int | None = None,
) -> Element:
    return Element(
        id=eid,
        type=etype,
        text=text,
        order=order,
        page=page,
        parent_id=parent_id,
        level=level,
    )


def doc(elements: list[Element], **kw) -> ParsedDoc:
    pages = [e.page for e in elements if e.page is not None]
    return ParsedDoc(
        elements=elements,
        page_count=kw.pop("page_count", max(pages) if pages else 0),
        source_id=kw.pop("source_id", "s" * 16),
        filename=kw.pop("filename", "sample.pdf"),
        **kw,
    )


def run(transform, parsed: ParsedDoc, tmp_path: Path, **cfg) -> ParsedDoc:
    """Apply a cleaner the way the executor would, and validate the result."""
    inst = transform()
    ctx = RunContext(
        output_dir=tmp_path / "out",
        emit=lambda ev: None,
        tmp=tmp_path / "tmp",
    )
    out = inst.apply({"doc": parsed}, inst.config_model(**cfg), ctx)
    return ParsedDoc.model_validate(
        out.model_dump(mode="json") if isinstance(out, ParsedDoc) else out
    )


def reports(parsed: ParsedDoc) -> list[dict]:
    return parsed.parser_meta.get("clean_report", [])


def texts(parsed: ParsedDoc) -> list[str]:
    return [e.text for e in sorted(parsed.elements, key=lambda e: e.order)]


def ids_in_order(parsed: ParsedDoc) -> list[str]:
    return [e.id for e in sorted(parsed.elements, key=lambda e: e.order)]


# --------------------------------------------------------------------------
# fixtures
# --------------------------------------------------------------------------


def paged_doc() -> ParsedDoc:
    """Four pages, each wrapped in a running head and a page number."""
    elements: list[Element] = []
    order = 0
    for page in (1, 2, 3, 4):
        elements.append(
            el(f"h{page}", "ACME Corp — Confidential", order, page=page)
        )
        order += 1
        elements.append(
            el(
                f"b{page}",
                f"Body paragraph number {page} with unique wording.",
                order,
                page=page,
            )
        )
        order += 1
        elements.append(el(f"p{page}", f"{page}", order, page=page))
        order += 1
    return doc(elements, page_count=4)


def messy_doc() -> ParsedDoc:
    """Running heads, page numbers, a duplicate block, and real parentage.

    The duplicated notice sits in the *middle* of each page on purpose: a
    repeated block at a page edge is a running foot, and stripping it is
    `header_footer_strip`'s job, not dedupe's.
    """
    elements: list[Element] = []
    order = 0
    for page in (1, 2, 3, 4):
        elements.append(el(f"h{page}", "ACME Corp — Confidential", order, page=page))
        order += 1
        elements.append(
            el(
                f"t{page}",
                f"Section {page}",
                order,
                etype="heading",
                page=page,
                level=1,
            )
        )
        order += 1
        # The same boilerplate on every page — dedupe's job, not the header's.
        elements.append(
            el(
                f"d{page}",
                "This notice is repeated verbatim in the body.",
                order,
                page=page,
                parent_id=f"t{page}",
            )
        )
        order += 1
        # A child of the running head: after the head goes, this must reparent.
        elements.append(
            el(
                f"b{page}",
                f"Body paragraph number {page} with unique wording.",
                order,
                page=page,
                parent_id=f"h{page}",
            )
        )
        order += 1
        elements.append(el(f"p{page}", f"Page {page}", order, page=page))
        order += 1
    return doc(elements, page_count=4)


CLEANERS = [HeaderFooterStrip, DedupeBlocks, DropMatching]

#: Config the shared invariant tests use, per cleaner. The others remove blocks
#: from `messy_doc` with their defaults; `drop_matching` defaults to an empty
#: pattern (a no-op), so it is given one that removes the running heads.
INVARIANT_CONFIG: dict[type, dict] = {DropMatching: {"pattern": "ACME Corp"}}


def cfg(cls) -> dict:
    return INVARIANT_CONFIG.get(cls, {})


# --------------------------------------------------------------------------
# registration / plumbing
# --------------------------------------------------------------------------


@pytest.mark.parametrize("cls", CLEANERS)
def test_declares_the_clean_stage_contract(cls):
    assert cls.stage is Stage.CLEAN
    assert cls.output is ArtifactType.PARSED_DOC
    assert cls.inputs == {"doc": PortSpec(ArtifactType.PARSED_DOC)}
    # Input type == output type is what makes cleaners stackable.
    assert cls.inputs["doc"].type == cls.output


@pytest.mark.parametrize("cls", CLEANERS)
def test_is_registered(cls):
    assert registry.get(Stage.CLEAN, cls.name) is cls


@pytest.mark.parametrize("cls", CLEANERS)
def test_accepts_a_plain_dict_payload(cls, tmp_path):
    """The executor reads artifacts back as JSON, so a cleaner sees a dict."""
    inst = cls()
    ctx = RunContext(output_dir=tmp_path, emit=lambda ev: None, tmp=tmp_path)
    out = inst.apply(
        {"doc": messy_doc().model_dump(mode="json")}, inst.config_model(**cfg(cls)), ctx
    )
    assert ParsedDoc.model_validate(
        out.model_dump(mode="json") if isinstance(out, ParsedDoc) else out
    ).elements


@pytest.mark.parametrize("cls", CLEANERS)
def test_does_not_mutate_its_input(cls, tmp_path):
    original = messy_doc()
    before = original.model_dump(mode="json")
    run(cls, original, tmp_path, **cfg(cls))
    assert original.model_dump(mode="json") == before


# --------------------------------------------------------------------------
# header_footer_strip
# --------------------------------------------------------------------------


def test_repeated_first_block_is_retyped_as_header(tmp_path):
    out = run(HeaderFooterStrip, paged_doc(), tmp_path, drop=False)
    heads = [e for e in out.elements if e.id.startswith("h")]
    assert len(heads) == 4
    assert {e.type for e in heads} == {"header"}


def test_repeated_last_block_of_digits_is_a_page_number(tmp_path):
    out = run(HeaderFooterStrip, paged_doc(), tmp_path, drop=False)
    assert {e.type for e in out.elements if e.id.startswith("p")} == {"page_number"}


def test_page_n_of_m_is_a_page_number(tmp_path):
    elements = []
    order = 0
    for page in (1, 2, 3, 4):
        elements.append(el(f"b{page}", f"Body {page} text.", order, page=page))
        order += 1
        elements.append(el(f"p{page}", f"Page {page} of 4", order, page=page))
        order += 1
    out = run(HeaderFooterStrip, doc(elements), tmp_path, drop=False)
    assert {e.type for e in out.elements if e.id.startswith("p")} == {"page_number"}


def test_repeated_non_numeric_last_block_is_a_footer(tmp_path):
    elements = []
    order = 0
    for page in (1, 2, 3, 4):
        elements.append(el(f"b{page}", f"Body {page} text.", order, page=page))
        order += 1
        elements.append(el(f"f{page}", "© 2026 ACME Corp", order, page=page))
        order += 1
    out = run(HeaderFooterStrip, doc(elements), tmp_path, drop=False)
    assert {e.type for e in out.elements if e.id.startswith("f")} == {"footer"}


def test_retyping_alone_removes_the_block_from_the_markdown(tmp_path):
    """`core.payloads` excludes header/footer/page_number from the projection."""
    out = run(HeaderFooterStrip, paged_doc(), tmp_path, drop=False)
    markdown, offsets = out.render_markdown()
    assert "ACME Corp" not in markdown
    assert len(out.elements) == 12  # nothing was removed
    assert set(offsets) == {f"b{p}" for p in (1, 2, 3, 4)}


def test_drop_removes_the_blocks_from_the_elements(tmp_path):
    out = run(HeaderFooterStrip, paged_doc(), tmp_path, drop=True)
    assert ids_in_order(out) == ["b1", "b2", "b3", "b4"]
    assert all(e.type == "paragraph" for e in out.elements)


def test_drop_is_the_default(tmp_path):
    assert HeaderFooterStrip.config_model().drop is True
    assert HeaderFooterStrip.config_model().min_page_ratio == 0.5


def test_a_block_below_the_page_ratio_is_kept(tmp_path):
    elements = []
    order = 0
    for page in (1, 2, 3, 4):
        if page == 1:
            elements.append(el("rare", "Draft watermark", order, page=page))
            order += 1
        elements.append(el(f"b{page}", f"Body {page} text.", order, page=page))
        order += 1
    out = run(HeaderFooterStrip, doc(elements), tmp_path)
    assert "rare" in ids_in_order(out)


def test_the_page_ratio_is_configurable(tmp_path):
    """The same block, kept at 0.75 and stripped at 0.5."""
    elements = []
    order = 0
    for page in (1, 2, 3, 4):
        if page in (1, 2):
            elements.append(el(f"h{page}", "Running head", order, page=page))
            order += 1
        elements.append(el(f"b{page}", f"Body {page} text.", order, page=page))
        order += 1
    strict = run(HeaderFooterStrip, doc(elements), tmp_path, min_page_ratio=0.75)
    assert "h1" in ids_in_order(strict)
    loose = run(HeaderFooterStrip, doc(elements), tmp_path, min_page_ratio=0.5)
    assert "h1" not in ids_in_order(loose)


def test_a_long_repeated_block_is_not_a_running_head(tmp_path):
    """Boilerplate paragraphs are dedupe's problem; running heads are short."""
    long_text = "A licence paragraph that is far too long to be a running head. " * 3
    elements = []
    order = 0
    for page in (1, 2, 3, 4):
        elements.append(el(f"h{page}", long_text, order, page=page))
        order += 1
        elements.append(el(f"b{page}", f"Body {page} text.", order, page=page))
        order += 1
    out = run(HeaderFooterStrip, doc(elements), tmp_path)
    assert len(out.elements) == 8


def test_a_block_in_the_middle_of_a_page_is_not_a_running_head(tmp_path):
    elements = []
    order = 0
    for page in (1, 2, 3, 4):
        elements.append(el(f"a{page}", f"Opening {page}.", order, page=page))
        order += 1
        elements.append(el(f"m{page}", "Repeated middle", order, page=page))
        order += 1
        elements.append(el(f"z{page}", f"Closing {page}.", order, page=page))
        order += 1
    out = run(HeaderFooterStrip, doc(elements), tmp_path)
    assert [e.id for e in out.elements if e.id.startswith("m")] == [
        "m1",
        "m2",
        "m3",
        "m4",
    ]


def test_a_single_page_document_is_untouched(tmp_path):
    """With one page every block 'repeats on 100% of pages' — a trap."""
    single = doc(
        [
            el("h1", "ACME Corp", 0, page=1),
            el("b1", "The only paragraph.", 1, page=1),
            el("p1", "1", 2, page=1),
        ]
    )
    out = run(HeaderFooterStrip, single, tmp_path)
    assert out.model_dump(mode="json") == single.model_dump(mode="json")


def test_elements_without_a_page_are_never_stripped(tmp_path):
    elements = [el(f"n{i}", "Same text", i) for i in range(4)]
    out = run(HeaderFooterStrip, doc(elements), tmp_path)
    assert len(out.elements) == 4


def test_page_numbers_are_matched_by_pattern_not_by_repetition(tmp_path):
    """'1', '2', '3', '4' never repeat, yet they are all page numbers."""
    out = run(HeaderFooterStrip, paged_doc(), tmp_path)
    removed = reports(out)[0]["removed"]
    assert {r["type"] for r in removed} == {"header", "page_number"}


def test_a_numbered_section_heading_is_not_mistaken_for_a_running_head(tmp_path):
    """'Section 1' … 'Section 4' differ; only the digits are alike."""
    elements = []
    order = 0
    for page in (1, 2, 3, 4):
        elements.append(
            el(f"t{page}", f"Section {page}", order, etype="heading", page=page, level=1)
        )
        order += 1
        elements.append(el(f"b{page}", f"Body {page} text.", order, page=page))
        order += 1
    out = run(HeaderFooterStrip, doc(elements), tmp_path)
    assert len(out.elements) == 8


def test_stripping_runs_to_a_fixed_point(tmp_path):
    """Removing the page number exposes a running foot behind it."""
    elements = []
    order = 0
    for page in (1, 2, 3, 4):
        elements.append(el(f"b{page}", f"Body {page} text.", order, page=page))
        order += 1
        elements.append(el(f"f{page}", "Internal use only", order, page=page))
        order += 1
        elements.append(el(f"p{page}", f"{page}", order, page=page))
        order += 1
    out = run(HeaderFooterStrip, doc(elements), tmp_path)
    assert ids_in_order(out) == ["b1", "b2", "b3", "b4"]


def test_header_report_names_id_type_preview_and_reason(tmp_path):
    out = run(HeaderFooterStrip, paged_doc(), tmp_path)
    (report,) = reports(out)
    assert report["cleaner"] == HeaderFooterStrip.name
    assert report["removed_count"] == 8
    assert report["kept_count"] == 4
    entry = next(r for r in report["removed"] if r["id"] == "h1")
    assert entry["type"] == "header"
    assert "ACME Corp" in entry["preview"]
    assert "4/4 pages" in entry["reason"]


def test_retyped_blocks_are_reported_separately(tmp_path):
    out = run(HeaderFooterStrip, paged_doc(), tmp_path, drop=False)
    (report,) = reports(out)
    assert report["removed"] == []
    assert {r["id"] for r in report["retyped"]} == {
        "h1", "h2", "h3", "h4", "p1", "p2", "p3", "p4",
    }
    entry = next(r for r in report["retyped"] if r["id"] == "p1")
    assert entry["from"] == "paragraph"
    assert entry["to"] == "page_number"


def test_a_document_with_nothing_to_strip_writes_no_report(tmp_path):
    clean = doc([el(f"b{p}", f"Body {p}.", p - 1, page=p) for p in (1, 2, 3)])
    out = run(HeaderFooterStrip, clean, tmp_path)
    assert reports(out) == []


# --------------------------------------------------------------------------
# dedupe_blocks
# --------------------------------------------------------------------------


def test_exact_duplicate_is_removed_and_the_first_kept(tmp_path):
    d = doc(
        [
            el("a", "Repeated notice.", 0),
            el("b", "Something else.", 1),
            el("c", "Repeated notice.", 2),
        ]
    )
    out = run(DedupeBlocks, d, tmp_path)
    assert ids_in_order(out) == ["a", "b"]


def test_exact_matching_normalizes_whitespace_and_case(tmp_path):
    d = doc(
        [
            el("a", "Repeated  notice.", 0),
            el("b", "repeated\nnotice.", 1),
        ]
    )
    out = run(DedupeBlocks, d, tmp_path)
    assert ids_in_order(out) == ["a"]


def test_exact_scope_keeps_a_near_duplicate(tmp_path):
    d = doc(
        [
            el("a", "The quick brown fox jumps over the lazy dog.", 0),
            el("b", "The quick brown fox jumps over the lazy cat.", 1),
        ]
    )
    out = run(DedupeBlocks, d, tmp_path, scope="exact")
    assert ids_in_order(out) == ["a", "b"]


def test_near_scope_removes_a_near_duplicate(tmp_path):
    d = doc(
        [
            el("a", "The quick brown fox jumps over the lazy dog.", 0),
            el("b", "The quick brown fox jumps over the lazy cat.", 1),
        ]
    )
    out = run(DedupeBlocks, d, tmp_path, scope="near", similarity=0.9)
    assert ids_in_order(out) == ["a"]


def test_near_scope_respects_the_similarity_threshold(tmp_path):
    d = doc(
        [
            el("a", "The quick brown fox jumps over the lazy dog.", 0),
            el("b", "The quick brown fox jumps over the lazy cat.", 1),
        ]
    )
    out = run(DedupeBlocks, d, tmp_path, scope="near", similarity=0.99)
    assert ids_in_order(out) == ["a", "b"]


def test_unrelated_text_survives_near_scope(tmp_path):
    d = doc(
        [
            el("a", "The quick brown fox jumps over the lazy dog.", 0),
            el("b", "Retrieval grounds an answer in a cited passage.", 1),
        ]
    )
    out = run(DedupeBlocks, d, tmp_path, scope="near", similarity=0.9)
    assert ids_in_order(out) == ["a", "b"]


def test_same_text_in_different_element_types_is_not_a_duplicate(tmp_path):
    d = doc(
        [
            el("a", "Summary", 0, etype="heading", level=1),
            el("b", "Summary", 1),
        ]
    )
    out = run(DedupeBlocks, d, tmp_path)
    assert ids_in_order(out) == ["a", "b"]


def test_blank_blocks_are_left_alone(tmp_path):
    d = doc([el("a", "   ", 0), el("b", "", 1), el("c", "Real text.", 2)])
    out = run(DedupeBlocks, d, tmp_path)
    assert ids_in_order(out) == ["a", "b", "c"]


def test_dedupe_report_names_id_type_preview_and_reason(tmp_path):
    d = doc(
        [
            el("a", "Repeated notice.", 0),
            el("b", "Repeated notice.", 1),
        ]
    )
    out = run(DedupeBlocks, d, tmp_path)
    (report,) = reports(out)
    assert report["cleaner"] == DedupeBlocks.name
    assert report["removed_count"] == 1
    assert report["kept_count"] == 1
    (entry,) = report["removed"]
    assert entry["id"] == "b"
    assert entry["type"] == "paragraph"
    assert "Repeated notice." in entry["preview"]
    assert entry["duplicate_of"] == "a"  # names the survivor it duplicates
    assert "exact" in entry["reason"]


def test_a_document_with_no_duplicates_writes_no_report(tmp_path):
    d = doc([el("a", "One.", 0), el("b", "Two.", 1)])
    out = run(DedupeBlocks, d, tmp_path)
    assert reports(out) == []


# --------------------------------------------------------------------------
# required invariants, over both cleaners
# --------------------------------------------------------------------------


@pytest.mark.parametrize("cls", CLEANERS)
def test_order_is_total_and_contiguous_from_zero(cls, tmp_path):
    out = run(cls, messy_doc(), tmp_path, **cfg(cls))
    orders = sorted(e.order for e in out.elements)
    assert orders == list(range(len(out.elements)))


@pytest.mark.parametrize("cls", CLEANERS)
def test_no_parent_id_points_at_a_removed_element(cls, tmp_path):
    out = run(cls, messy_doc(), tmp_path, **cfg(cls))
    surviving = {e.id for e in out.elements}
    dangling = [e.id for e in out.elements if e.parent_id not in (None, *surviving)]
    assert dangling == []


def test_a_removed_parent_is_replaced_by_its_own_parent(tmp_path):
    """Reparent to the nearest surviving ancestor, never orphan silently."""
    d = doc(
        [
            el("a", "Repeated notice.", 0),
            el("b", "Repeated notice.", 1, parent_id="a"),
            el("c", "A child of the duplicate.", 2, parent_id="b"),
        ]
    )
    out = run(DedupeBlocks, d, tmp_path)
    assert ids_in_order(out) == ["a", "c"]
    assert {e.id: e.parent_id for e in out.elements} == {"a": None, "c": "a"}


def test_reparenting_climbs_past_a_whole_removed_chain(tmp_path):
    d = doc(
        [
            el("root", "Root text.", 0, etype="heading", level=1),
            el("x", "Repeated notice.", 1, parent_id="root"),
            el("y", "Repeated notice.", 2, parent_id="x"),
            el("z", "A surviving leaf.", 3, parent_id="y"),
        ]
    )
    out = run(DedupeBlocks, d, tmp_path)
    assert ids_in_order(out) == ["root", "x", "z"]
    assert {e.id: e.parent_id for e in out.elements}["z"] == "x"


def test_a_removed_root_leaves_its_children_parentless(tmp_path):
    """Reparenting climbs the *tree*, it does not redirect to the survivor the
    removed block duplicated — `b` was a root, so `c` becomes one too."""
    d = doc(
        [
            el("a", "Repeated notice.", 0),
            el("b", "Repeated notice.", 1),
            el("c", "Child of the duplicate.", 2, parent_id="b"),
        ]
    )
    out = run(DedupeBlocks, d, tmp_path)
    assert {e.id: e.parent_id for e in out.elements} == {"a": None, "c": None}


@pytest.mark.parametrize("cls", CLEANERS)
def test_relative_order_of_survivors_is_unchanged(cls, tmp_path):
    before = messy_doc()
    out = run(cls, before, tmp_path, **cfg(cls))
    survivors = {e.id for e in out.elements}
    expected = [
        e.id for e in sorted(before.elements, key=lambda e: e.order)
        if e.id in survivors
    ]
    assert ids_in_order(out) == expected


@pytest.mark.parametrize("cls", CLEANERS)
def test_cleaning_leaves_no_stale_markdown_offsets(cls, tmp_path):
    before = messy_doc()
    before.render_markdown()  # stamp offsets that removal would invalidate
    out = run(cls, before, tmp_path, **cfg(cls))
    assert all(e.md_start is None and e.md_end is None for e in out.elements)

    markdown, offsets = out.render_markdown()
    for e in out.elements:
        if e.id in offsets:
            assert markdown[e.md_start : e.md_end] == e.render()
        else:
            assert e.md_start is None and e.md_end is None
    # Re-projecting is stable.
    assert out.render_markdown()[0] == markdown


@pytest.mark.parametrize("cls", CLEANERS)
def test_cleaning_an_already_clean_document_is_a_no_op(cls, tmp_path):
    clean = doc(
        [
            el("b1", "First body paragraph.", 0, page=1),
            el("b2", "Second body paragraph.", 1, page=2),
            el("b3", "Third body paragraph.", 2, page=3),
        ]
    )
    out = run(cls, clean, tmp_path, **cfg(cls))
    assert out.model_dump(mode="json") == clean.model_dump(mode="json")


@pytest.mark.parametrize("cls", CLEANERS)
def test_applying_a_cleaner_twice_equals_applying_it_once(cls, tmp_path):
    once = run(cls, messy_doc(), tmp_path, **cfg(cls))
    twice = run(cls, once, tmp_path, **cfg(cls))
    assert twice.model_dump(mode="json") == once.model_dump(mode="json")


@pytest.mark.parametrize("cls", CLEANERS)
def test_an_empty_document_cleans_without_raising(cls, tmp_path):
    empty = ParsedDoc(elements=[])
    out = run(cls, empty, tmp_path, **cfg(cls))
    assert out.elements == []
    assert out.render_markdown() == ("", {})


def test_removing_every_element_yields_an_empty_document(tmp_path):
    """Two pages whose only block is the same running head."""
    d = doc(
        [
            el("h1", "ACME Corp", 0, page=1),
            el("h2", "ACME Corp", 1, page=2),
        ]
    )
    out = run(HeaderFooterStrip, d, tmp_path)
    assert out.elements == []
    assert out.render_markdown() == ("", {})
    assert reports(out)[0]["removed_count"] == 2
    assert reports(out)[0]["kept_count"] == 0


# --------------------------------------------------------------------------
# stacking — the reason CLEAN is in STACKABLE
# --------------------------------------------------------------------------


def test_stacking_strip_then_dedupe_composes(tmp_path):
    stripped = run(HeaderFooterStrip, messy_doc(), tmp_path)
    assert ids_in_order(stripped) == [
        "t1", "d1", "b1", "t2", "d2", "b2", "t3", "d3", "b3", "t4", "d4", "b4",
    ]
    out = run(DedupeBlocks, stripped, tmp_path)
    assert ids_in_order(out) == [
        "t1", "d1", "b1", "t2", "b2", "t3", "b3", "t4", "b4",
    ]
    assert sorted(e.order for e in out.elements) == list(range(9))


def test_stacking_dedupe_then_strip_leaves_one_running_head_behind(tmp_path):
    """Order matters: dedupe collapses the four heads into one, and one
    occurrence is below the page ratio, so the strip can no longer see it.
    That is exactly why `clean` stacks in a user-chosen order."""
    deduped = run(DedupeBlocks, messy_doc(), tmp_path)
    out = run(HeaderFooterStrip, deduped, tmp_path)
    assert ids_in_order(out) == [
        "h1", "t1", "d1", "b1", "t2", "b2", "t3", "b3", "t4", "b4",
    ]


def test_stacking_accumulates_one_report_per_cleaner(tmp_path):
    stripped = run(HeaderFooterStrip, messy_doc(), tmp_path)
    out = run(DedupeBlocks, stripped, tmp_path)
    assert [r["cleaner"] for r in reports(out)] == [
        HeaderFooterStrip.name,
        DedupeBlocks.name,
    ]


def test_a_stacked_document_still_satisfies_every_invariant(tmp_path):
    stripped = run(HeaderFooterStrip, messy_doc(), tmp_path)
    out = run(DedupeBlocks, stripped, tmp_path)

    surviving = {e.id for e in out.elements}
    assert sorted(e.order for e in out.elements) == list(range(len(out.elements)))
    assert all(e.parent_id in (None, *surviving) for e in out.elements)
    assert all(e.md_start is None for e in out.elements)

    markdown, offsets = out.render_markdown()
    for eid, (start, end) in offsets.items():
        e = next(x for x in out.elements if x.id == eid)
        assert markdown[start:end] == e.render()
    assert "ACME Corp" not in markdown
    assert markdown.count("This notice is repeated verbatim in the body.") == 1


def test_stacking_preserves_the_upstream_parser_meta(tmp_path):
    source = messy_doc()
    source.parser_meta["parser"] = "pdfium"
    out = run(DedupeBlocks, run(HeaderFooterStrip, source, tmp_path), tmp_path)
    assert out.parser_meta["parser"] == "pdfium"
    assert out.page_count == 4
    assert out.filename == "sample.pdf"

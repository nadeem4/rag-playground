"""Tests for `clean/drop_matching`, the pattern cleaner (interface I-6).

The shared contract and default-config invariants run through the `CLEANERS`
parametrization in `test_clean.py`. The default pattern is empty, which is a
no-op, so the invariants are re-checked here with a pattern that actually
removes blocks.
"""

from __future__ import annotations

import pytest

from core.payloads import ParsedDoc
from plugins.clean.dedupe_blocks import DedupeBlocks
from plugins.clean.drop_matching import DropMatching
from tests.plugins.test_clean import doc, el, ids_in_order, messy_doc, reports, run, texts

NOTICE = (
    "We are proud to be an equal opportunity workplace. We do not discriminate "
    "on the basis of race, religion, colour, national origin, gender, sexual "
    "orientation, age, marital status, or disability status."
)


def notice_doc() -> ParsedDoc:
    """Three pages, each carrying the same long notice in the body."""
    elements = []
    order = 0
    for page in (1, 2, 3):
        elements.append(el(f"b{page}", f"Role details, part {page}.", order, page=page))
        order += 1
        elements.append(el(f"n{page}", NOTICE, order, page=page))
        order += 1
    return doc(elements, page_count=3)


# --------------------------------------------------------------------------
# matching
# --------------------------------------------------------------------------


def test_contains_removes_every_block_holding_the_substring(tmp_path):
    out = run(DropMatching, notice_doc(), tmp_path, pattern="equal opportunity")
    assert ids_in_order(out) == ["b1", "b2", "b3"]


def test_contains_is_a_plain_substring_never_a_regex(tmp_path):
    d = doc([el("a", "Price: 1+1 offer", 0), el("b", "Price: 11 offer", 1)])
    out = run(DropMatching, d, tmp_path, pattern="1+1")
    assert ids_in_order(out) == ["b"]


def test_contains_does_not_choke_on_regex_metacharacters(tmp_path):
    d = doc([el("a", "See [1](", 0), el("b", "Keep me.", 1)])
    out = run(DropMatching, d, tmp_path, pattern="[1](")
    assert ids_in_order(out) == ["b"]


def test_regex_mode_uses_search(tmp_path):
    d = doc(
        [
            el("a", "Page 3 of 10", 0),
            el("b", "Chapter 3 begins here.", 1),
            el("c", "See page 3 of the appendix.", 2),
        ]
    )
    out = run(DropMatching, d, tmp_path, pattern=r"page \d+ of \d+", mode="regex")
    assert ids_in_order(out) == ["b", "c"]


def test_regex_mode_is_not_anchored(tmp_path):
    d = doc([el("a", "Intro. Copyright 2024 ACME.", 0), el("b", "Body.", 1)])
    out = run(DropMatching, d, tmp_path, pattern=r"copyright \d{4}", mode="regex")
    assert ids_in_order(out) == ["b"]


def test_case_insensitive_by_default(tmp_path):
    out = run(DropMatching, notice_doc(), tmp_path, pattern="EQUAL OPPORTUNITY")
    assert ids_in_order(out) == ["b1", "b2", "b3"]


def test_case_sensitive_contains(tmp_path):
    out = run(
        DropMatching,
        notice_doc(),
        tmp_path,
        pattern="EQUAL OPPORTUNITY",
        case_sensitive=True,
    )
    assert len(out.elements) == 6
    assert reports(out) == []


def test_case_sensitive_regex(tmp_path):
    d = doc([el("a", "Confidential", 0), el("b", "confidential", 1)])
    out = run(
        DropMatching, d, tmp_path, pattern="^Conf", mode="regex", case_sensitive=True
    )
    assert ids_in_order(out) == ["b"]
    out = run(DropMatching, d, tmp_path, pattern="^Conf", mode="regex")
    assert out.elements == []


# --------------------------------------------------------------------------
# no-ops and errors
# --------------------------------------------------------------------------


@pytest.mark.parametrize("mode", ["contains", "regex"])
def test_empty_pattern_is_a_no_op_without_a_report(mode, tmp_path):
    before = notice_doc()
    out = run(DropMatching, before, tmp_path, pattern="", mode=mode)
    assert out.model_dump(mode="json") == before.model_dump(mode="json")
    assert reports(out) == []


def test_no_match_writes_no_report(tmp_path):
    before = notice_doc()
    out = run(DropMatching, before, tmp_path, pattern="nothing like this")
    assert out.model_dump(mode="json") == before.model_dump(mode="json")


def test_invalid_regex_raises_a_readable_error(tmp_path):
    with pytest.raises(ValueError, match=r"invalid regex.*'\(unclosed'"):
        run(DropMatching, notice_doc(), tmp_path, pattern="(unclosed", mode="regex")


def test_an_invalid_regex_is_fine_in_contains_mode(tmp_path):
    d = doc([el("a", "text (unclosed", 0), el("b", "Keep.", 1)])
    out = run(DropMatching, d, tmp_path, pattern="(unclosed")
    assert ids_in_order(out) == ["b"]


# --------------------------------------------------------------------------
# invariants, with a pattern that removes something
# --------------------------------------------------------------------------


def test_order_is_contiguous_and_survivors_keep_relative_order(tmp_path):
    before = messy_doc()
    out = run(DropMatching, before, tmp_path, pattern="ACME Corp")
    assert sorted(e.order for e in out.elements) == list(range(len(out.elements)))
    expected = [
        e.id
        for e in sorted(before.elements, key=lambda e: e.order)
        if not e.text.startswith("ACME")
    ]
    assert ids_in_order(out) == expected


def test_children_of_a_removed_block_are_reparented(tmp_path):
    d = doc(
        [
            el("root", "Section", 0, etype="heading", level=1),
            el("x", "Boilerplate notice.", 1, parent_id="root"),
            el("y", "Boilerplate notice again.", 2, parent_id="x"),
            el("z", "A surviving leaf.", 3, parent_id="y"),
        ]
    )
    out = run(DropMatching, d, tmp_path, pattern="boilerplate")
    assert ids_in_order(out) == ["root", "z"]
    assert {e.id: e.parent_id for e in out.elements} == {"root": None, "z": "root"}


def test_no_parent_id_dangles_after_removal(tmp_path):
    out = run(DropMatching, messy_doc(), tmp_path, pattern="ACME Corp")
    alive = {e.id for e in out.elements}
    assert all(e.parent_id in (None, *alive) for e in out.elements)


def test_applying_twice_equals_applying_once(tmp_path):
    once = run(DropMatching, notice_doc(), tmp_path, pattern="equal opportunity")
    twice = run(DropMatching, once, tmp_path, pattern="equal opportunity")
    assert twice.model_dump(mode="json") == once.model_dump(mode="json")
    assert len(reports(twice)) == 1


def test_does_not_mutate_its_input(tmp_path):
    original = notice_doc()
    before = original.model_dump(mode="json")
    run(DropMatching, original, tmp_path, pattern="equal opportunity")
    assert original.model_dump(mode="json") == before


# --------------------------------------------------------------------------
# report
# --------------------------------------------------------------------------


def test_report_lists_each_removed_block_with_the_reason(tmp_path):
    out = run(DropMatching, notice_doc(), tmp_path, pattern="equal opportunity")
    (report,) = reports(out)
    assert report["cleaner"] == "drop_matching"
    assert report["config"] == {
        "pattern": "equal opportunity",
        "mode": "contains",
        "case_sensitive": False,
    }
    assert report["removed_count"] == 3
    assert report["kept_count"] == 3
    assert report["retyped"] == []
    assert [r["id"] for r in report["removed"]] == ["n1", "n2", "n3"]
    first = report["removed"][0]
    assert first["type"] == "paragraph"
    assert first["page"] == 1
    assert first["order"] == 1
    assert first["preview"].startswith("We are proud to be an equal opportunity")
    assert all(
        r["reason"] == "matched pattern 'equal opportunity'" for r in report["removed"]
    )


# --------------------------------------------------------------------------
# stacking
# --------------------------------------------------------------------------


def test_dedupe_then_drop_removes_every_copy_of_the_notice(tmp_path):
    """Dedupe keeps the first copy by design; drop_matching takes the last one."""
    deduped = run(DedupeBlocks, notice_doc(), tmp_path)
    assert texts(deduped).count(NOTICE) == 1

    out = run(DropMatching, deduped, tmp_path, pattern="equal opportunity workplace")
    assert NOTICE not in texts(out)
    assert ids_in_order(out) == ["b1", "b2", "b3"]
    assert [r["cleaner"] for r in reports(out)] == ["dedupe_blocks", "drop_matching"]
    assert sorted(e.order for e in out.elements) == [0, 1, 2]

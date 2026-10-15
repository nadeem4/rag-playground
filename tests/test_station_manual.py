"""The manual sample: deep numbered headings, one table, page furniture and a repeated warning.

It is the sample of Pandion's "Manuals and guides" template, so it must give that
template's settings work to do: heading levels to read, a header and footer for
`content_layers` to drop, and a warning repeated word for word for `dedupe_blocks`.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pypdfium2 as pdfium
import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.samplegen import station_manual as sample  # noqa: E402

FOLDER = ROOT / "samples" / sample.NAME


def _page_texts() -> list[str]:
    pdf = pdfium.PdfDocument(sample.build())
    try:
        return [" ".join(page.get_textpage().get_text_range().split()) for page in pdf]
    finally:
        pdf.close()


def _questions() -> list[dict]:
    return json.loads((FOLDER / "questions.json").read_text(encoding="utf-8"))


def _headings() -> list[tuple[int, str]]:
    """(font size, text) of every bold line, read from the PDF's own content streams."""
    found = re.findall(rb"/F2 (\d+) Tf -?\d+ -?\d+ Td \((.*?)\) Tj", sample.build())
    return [(int(size), text.decode("ascii")) for size, text in found]


def test_build_is_deterministic():
    assert sample.build() == sample.build()


def test_the_manual_has_five_to_seven_pages_each_with_its_furniture_and_the_warning():
    pages = _page_texts()
    assert 5 <= len(pages) <= 7
    warning = " ".join(sample.WARNING.split())
    for n, text in enumerate(pages, start=1):
        assert sample.HEADER_TEXT in text
        assert f"Page {n} of {len(pages)}" in text
        assert warning in text, f"page {n} has no warning"


def test_numbered_headings_go_four_levels_deep_and_shrink_with_each_level():
    sizes: dict[int, set[int]] = {}
    for size, text in _headings():
        number = re.match(r"(\d+(?:\.\d+)*) ", text)
        if number:
            sizes.setdefault(number.group(1).count(".") + 1, set()).add(size)
    assert set(sizes) == {1, 2, 3, 4}
    # One size per level, and each level is smaller than the one above it.
    assert all(len(s) == 1 for s in sizes.values()), sizes
    ordered = [next(iter(sizes[level])) for level in (1, 2, 3, 4)]
    assert ordered == sorted(ordered, reverse=True) and len(set(ordered)) == 4


def test_two_subsections_share_a_title_under_different_parents():
    titles = [re.sub(r"^[\d.]+ ", "", text) for _, text in _headings() if re.match(r"\d+\.\d+\.\d+ ", text)]
    assert any(titles.count(t) >= 2 for t in titles)


def test_the_settings_table_is_in_the_text():
    text = " ".join(_page_texts())
    for row in sample.TABLE:
        for cell in row:
            assert cell in text


def test_every_gold_answer_is_in_the_pdf_text():
    text = " ".join(_page_texts())
    questions = _questions()
    assert 10 <= len(questions) <= 12
    for q in questions:
        assert set(q) >= {"id", "question", "gold_answer", "answer", "tags"}, q["id"]
        if "table row" in q["tags"]:
            # A row is matched the way Docling writes it, `| a | b |`; pdfium reads each cell.
            for cell in filter(None, (c.strip() for c in q["gold_answer"].split("|"))):
                assert cell in text, (q["id"], cell)
        else:
            assert " ".join(q["gold_answer"].split()) in text, q["id"]


def test_no_em_dash_anywhere():
    files = [
        ROOT / "scripts" / "samplegen" / "station_manual.py",
        FOLDER / "questions.json",
        FOLDER / "sample.json",
    ]
    for f in files:
        assert "\N{EM DASH}" not in f.read_text(encoding="utf-8"), f.name
    assert "\N{EM DASH}" not in " ".join(_page_texts())


#: As in test_sample_plants: found in the top 3, not just the top 5, so a place or
#: two of drift between Windows and Linux does not turn a hit into a miss.
FOUND_BY = 3


@pytest.mark.models
def test_the_manuals_template_finds_every_answer_and_keeps_heading_paths(tmp_path):
    import pandion
    from pandion.textmatch import normalise

    p = pandion.Pipeline.from_dict(pandion.compose_template("manuals", "balanced", path=str(tmp_path / "index")))
    stages = p.index.run(FOLDER / f"{sample.NAME}.pdf").documents[f"{sample.NAME}.pdf"].stages
    pieces = stages["chunk"].output.chunks
    assert all(c.heading_path for c in pieces)
    # The warning is read on every page, then kept once.
    assert sum("WARNING" in c.text for c in pieces) == 1
    assert not any(sample.HEADER_TEXT in c.text for c in pieces)
    # Look-alike subsections ("set this threshold to 4", "This part takes") land in
    # separate pieces, each under its own numbered heading.
    golds = {q["id"]: q["gold_answer"] for q in _questions()}

    def piece_of(qid: str):
        (piece,) = [c for c in pieces if normalise(golds[qid]) in normalise(c.text)]
        return piece

    for qid, heading in [
        ("frost-threshold", "2.2.1 Frost alarm"),
        ("wind-threshold", "2.2.2 Wind alarm"),
        ("sensor-batteries", "4.2.1 Outdoor sensor"),
        ("display-batteries", "4.2.2 Indoor display"),
    ]:
        assert piece_of(qid).heading_path[-1] == heading, (qid, piece_of(qid).heading_path)
    assert piece_of("frost-threshold") is not piece_of("wind-threshold")
    assert piece_of("sensor-batteries") is not piece_of("display-batteries")
    for q in _questions():
        hits = p.retrieve(q["question"]).hits
        ranks = [h.rank for h in hits if normalise(q["gold_answer"]) in normalise(h.chunk.text)]
        assert ranks and ranks[0] <= FOUND_BY, (q["id"], ranks)

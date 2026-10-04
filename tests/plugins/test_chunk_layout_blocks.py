"""By layout block (`layout_blocks`): tables stay with their captions and headings.

The shared invariants (slice-back, offsets, provenance) run over every chunker
in `test_chunk.py`; this file checks what is particular to this strategy.
"""

from __future__ import annotations

import pydantic
import pytest

from core.artifacts import ArtifactType
from core.ports import RunContext, Stage
from plugins.chunk.layout_blocks import LayoutBlocksChunker
from tests.plugins.test_chunk import DOCS, _doc, mixed_doc, run


def _ctx(tmp_path) -> RunContext:
    return RunContext(output_dir=tmp_path, emit=lambda e: None, tmp=tmp_path)


def _apply(doc, tmp_path, **cfg):
    ctx = _ctx(tmp_path)
    out = LayoutBlocksChunker().apply(
        {"doc": doc}, LayoutBlocksChunker.config_model(**cfg), ctx
    )
    return out, ctx.extras.get("meta", {}).get("note")


def _table(rows: int) -> str:
    lines = ["| name | value |", "| - | - |"]
    lines += [f"| row{i} | {i} |" for i in range(rows)]
    return "\n".join(lines)


def _sentences(n: int) -> str:
    return " ".join(f"Sentence number {i} says a few words." for i in range(n))


def _holding(cs, text):
    return [c for c in cs.chunks if text in c.text]


# --------------------------------------------------------------------------- #
# Wiring
# --------------------------------------------------------------------------- #


def test_declares_its_ports_and_name():
    assert LayoutBlocksChunker.name == "layout_blocks"
    assert LayoutBlocksChunker.stage is Stage.CHUNK
    assert LayoutBlocksChunker.inputs["doc"].type is ArtifactType.PARSED_DOC
    assert LayoutBlocksChunker.output is ArtifactType.CHUNK_SET


def test_listed_in_plugin_modules():
    from plugins import PLUGIN_MODULES

    assert "plugins.chunk.layout_blocks" in PLUGIN_MODULES


def test_config_defaults():
    cfg = LayoutBlocksChunker.config_model()
    assert cfg.max_tokens == 400
    assert cfg.keep_tables_whole is True
    assert cfg.heading_context is True
    with pytest.raises(pydantic.ValidationError):
        LayoutBlocksChunker.config_model(max_tokens=0)


def test_prefers_headings_and_names_its_fallback():
    assert LayoutBlocksChunker.prefers == {"doc": {"structure": ["headings"]}}
    assert LayoutBlocksChunker.fallback == (
        "There are no headings to follow, so the text is cut by size."
    )


# --------------------------------------------------------------------------- #
# Units
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("budget", [1, 5, 20])
def test_caption_before_a_table_travels_with_it(budget):
    doc = _doc(
        [
            ("heading", "Results", 1, 1),
            ("paragraph", "Some words before the table.", None, 1),
            ("caption", "Table 1: Scores", None, 1),
            ("table", _table(2), None, 1),
            ("paragraph", "Some words after the table.", None, 1),
        ]
    )
    cs = run(LayoutBlocksChunker, doc, max_tokens=budget)
    [piece] = _holding(cs, "| row0 |")
    assert "Table 1: Scores" in piece.text


@pytest.mark.parametrize("budget", [1, 5, 20])
def test_caption_after_a_table_travels_with_it(budget):
    doc = _doc(
        [
            ("heading", "Results", 1, 1),
            ("paragraph", "Some words before the table.", None, 1),
            ("table", _table(2), None, 1),
            ("caption", "Table 1: Scores", None, 1),
            ("paragraph", "Some words after the table.", None, 1),
        ]
    )
    cs = run(LayoutBlocksChunker, doc, max_tokens=budget)
    [piece] = _holding(cs, "| row0 |")
    assert "Table 1: Scores" in piece.text


def test_a_caption_between_two_tables_goes_with_the_one_after():
    doc = _doc(
        [
            ("table", "| a |\n| - |\n| first |", None, 1),
            ("caption", "Table 2: Second", None, 1),
            ("table", "| b |\n| - |\n| second |", None, 1),
        ]
    )
    cs = run(LayoutBlocksChunker, doc, max_tokens=1)
    [piece] = _holding(cs, "| second |")
    assert "Table 2: Second" in piece.text
    assert "| first |" not in piece.text


def test_figure_travels_with_its_caption():
    doc = _doc(
        [
            ("heading", "Pictures", 1, 1),
            ("paragraph", "Text before the figure goes here.", None, 1),
            ("figure", "A chart of sales", None, 1),
            ("caption", "Figure 2: Sales by month", None, 1),
            ("paragraph", "Text after the figure goes here.", None, 1),
        ]
    )
    cs = run(LayoutBlocksChunker, doc, max_tokens=12)
    [piece] = _holding(cs, "A chart of sales")
    assert "Figure 2: Sales by month" in piece.text


# --------------------------------------------------------------------------- #
# Sections and packing
# --------------------------------------------------------------------------- #


def test_a_new_piece_starts_at_every_heading():
    cs = run(LayoutBlocksChunker, DOCS["many_headings"]())
    starts = [c.text.splitlines()[0] for c in cs.chunks]
    assert starts == ["# Alpha", "## Beta", "### Gamma", "# Delta"]
    assert cs.chunks[2].heading_path == ["Alpha", "Beta", "Gamma"]


def test_units_are_packed_up_to_max_tokens():
    doc = _doc(
        [("heading", "Notes", 1, 1)]
        + [("paragraph", f"Short note {i} here.", None, 1) for i in range(12)]
    )
    cs = run(LayoutBlocksChunker, doc, max_tokens=12)
    assert len(cs.chunks) > 1
    assert all(c.token_count <= 12 for c in cs.chunks)
    # Packed, not one piece per block.
    assert len(cs.chunks) < 13
    # Never cut through a block.
    for i in range(12):
        assert len(_holding(cs, f"Short note {i} here.")) == 1


def test_oversized_table_is_kept_whole_and_the_note_says_so(tmp_path):
    doc = _doc(
        [
            ("heading", "Data", 1, 1),
            ("caption", "Table 1: Many rows", None, 1),
            ("table", _table(30), None, 1),
        ]
    )
    cs, note = _apply(doc, tmp_path, max_tokens=20)
    [piece] = _holding(cs, "| row0 |")
    assert "| row29 |" in piece.text and "Table 1: Many rows" in piece.text
    assert piece.token_count > 20
    assert note == (
        "Cut 2 blocks into 1 piece along 1 heading, keeping 1 table whole "
        "although it is over the size limit. This document has headings at "
        "level 1."
    )
    assert cs.chunker_meta["tables_kept_whole"] == 1


def test_the_note_names_tables_kept_whole_in_the_plural(tmp_path):
    doc = _doc(
        [
            ("heading", "Data", 1, 1),
            ("table", _table(30), None, 1),
            ("paragraph", "Between the tables.", None, 1),
            ("table", _table(30), None, 1),
        ]
    )
    _, note = _apply(doc, tmp_path, max_tokens=20)
    assert note.endswith(
        ", keeping 2 tables whole although they are over the size limit. "
        "This document has headings at level 1."
    )


def test_oversized_table_is_split_when_keep_tables_whole_is_off(tmp_path):
    doc = _doc(
        [
            ("heading", "Data", 1, 1),
            ("table", _table(30), None, 1),
        ]
    )
    cs, note = _apply(doc, tmp_path, max_tokens=20, keep_tables_whole=False)
    assert not any("| row0 |" in c.text and "| row29 |" in c.text for c in cs.chunks)
    assert all(c.token_count <= 20 for c in cs.chunks)
    assert "keeping" not in note
    assert note.endswith("along 1 heading. This document has headings at level 1.")
    assert cs.chunker_meta["tables_kept_whole"] == 0


def test_oversized_paragraph_is_cut_at_sentence_ends():
    doc = _doc([("heading", "Long", 1, 1), ("paragraph", _sentences(20), None, 1)])
    cs = run(LayoutBlocksChunker, doc, max_tokens=25)
    body = [c for c in cs.chunks if "Sentence" in c.text]
    assert len(body) > 1
    for c in body:
        assert c.token_count <= 25
        assert c.text.endswith("says a few words.")
        assert c.text.lstrip("# Long\n").startswith("Sentence number")


def test_a_single_sentence_over_the_limit_is_cut_on_tokens():
    words = " ".join(f"w{i}" for i in range(60)) + "."
    doc = _doc([("paragraph", words, None, 1)])
    cs = run(LayoutBlocksChunker, doc, max_tokens=10)
    assert len(cs.chunks) > 1
    assert all(c.token_count <= 10 for c in cs.chunks)


# --------------------------------------------------------------------------- #
# Heading context and the text invariant
# --------------------------------------------------------------------------- #


def test_embed_text_carries_only_the_path_above_the_piece_own_heading():
    cs = run(LayoutBlocksChunker, DOCS["many_headings"]())
    gamma = cs.chunks[2]
    assert gamma.text.startswith("### Gamma")
    assert gamma.embed_text == "Alpha > Beta\n\n" + gamma.text


def test_embed_text_is_unset_when_the_piece_opens_with_its_whole_path():
    cs = run(LayoutBlocksChunker, DOCS["many_headings"]())
    alpha, delta = cs.chunks[0], cs.chunks[3]
    assert alpha.text.startswith("# Alpha") and delta.text.startswith("# Delta")
    assert alpha.embed_text is None and delta.embed_text is None


def test_embed_text_is_unset_when_headings_in_a_row_open_the_piece():
    doc = _doc(
        [
            ("heading", "Ch1", 1, 1),
            ("heading", "Sec", 2, 1),
            ("paragraph", "Body text under the section.", None, 1),
        ]
    )
    [piece] = run(LayoutBlocksChunker, doc).chunks
    assert piece.embed_text is None


def test_embed_text_carries_the_whole_path_when_the_piece_has_no_heading():
    doc = _doc([("heading", "Long", 1, 1), ("paragraph", _sentences(6), None, 1)])
    cs = run(LayoutBlocksChunker, doc, max_tokens=8)
    later = cs.chunks[1]
    assert not later.text.startswith("#")
    assert later.embed_text == "Long\n\n" + later.text


def test_embed_text_is_unset_when_heading_context_is_off():
    cs = run(LayoutBlocksChunker, DOCS["many_headings"](), heading_context=False)
    assert all(c.embed_text is None for c in cs.chunks)


def test_embed_text_is_unset_without_a_heading_path():
    cs = run(LayoutBlocksChunker, DOCS["single_paragraph"]())
    assert [c.embed_text for c in cs.chunks] == [None]


@pytest.mark.parametrize("budget", [1, 7, 400])
@pytest.mark.parametrize("name", sorted(DOCS))
def test_text_is_always_a_slice_of_source_text(name, budget):
    cs = run(LayoutBlocksChunker, DOCS[name](), max_tokens=budget)
    for c in cs.chunks:
        assert cs.source_text[c.start_char : c.end_char] == c.text


# --------------------------------------------------------------------------- #
# Notes and meta
# --------------------------------------------------------------------------- #


def test_no_headings_sets_the_fallback_note(tmp_path):
    doc = _doc([("paragraph", "one", None, 1), ("paragraph", "two", None, 1)])
    _, note = _apply(doc, tmp_path)
    assert note == LayoutBlocksChunker.fallback


def test_no_note_about_headings_for_an_empty_document(tmp_path):
    _, note = _apply(DOCS["empty"](), tmp_path)
    assert note is None


def test_the_note_counts_blocks_pieces_and_headings(tmp_path):
    doc = _doc(
        [
            ("heading", "Results", 1, 1),
            ("caption", "Table 1: Scores", None, 1),
            ("table", _table(2), None, 1),
            ("paragraph", "A closing line.", None, 1),
        ]
    )
    _, note = _apply(doc, tmp_path)
    assert note == (
        "Cut 3 blocks into 1 piece along 1 heading. This document has "
        "headings at level 1."
    )


def test_the_note_uses_plurals(tmp_path):
    _, note = _apply(DOCS["many_headings"](), tmp_path)
    assert note == (
        "Cut 9 blocks into 4 pieces along 4 headings. This document has "
        "headings at levels 1, 2 and 3."
    )


def test_meta_fields():
    cs = run(LayoutBlocksChunker, mixed_doc(), max_tokens=300)
    assert cs.chunker_meta == {
        "chunker": "layout_blocks",
        "max_tokens": 300,
        "keep_tables_whole": True,
        "heading_context": True,
        "section_level": 6,
        "blocks": 5,
        "headings": 1,
        "tables_kept_whole": 0,
    }


def test_user_facing_strings_have_no_dashes():
    cls = LayoutBlocksChunker
    texts = [cls.summary, cls.fallback]
    for entry in cls.learn.values():
        texts.append(entry["hint"])
        texts.extend(entry["more"])
    exp = cls().explain(cls.config_model())
    texts += [exp.settings, exp.tradeoff]
    for text in texts:
        assert chr(0x2014) not in text and chr(0x2013) not in text


def test_a_heading_joins_a_too_big_table_below_it():
    doc = _doc(
        [
            ("heading", "Data", 1, 1),
            ("table", _table(30), None, 1),
            ("paragraph", "After the table.", None, 1),
        ]
    )
    cs = run(LayoutBlocksChunker, doc, max_tokens=20)
    assert cs.chunks[0].text.startswith("# Data")
    assert "| row29 |" in cs.chunks[0].text
    assert not any(c.text == "# Data" for c in cs.chunks)


def test_a_heading_joins_the_first_piece_of_a_too_big_paragraph():
    doc = _doc([("heading", "Long", 1, 1), ("paragraph", _sentences(6), None, 1)])
    cs = run(LayoutBlocksChunker, doc, max_tokens=8)
    assert cs.chunks[0].text.startswith("# Long\n\nSentence number 0")
    assert not any(c.text == "# Long" for c in cs.chunks)


def test_headings_in_a_row_join_the_body_below_them():
    doc = _doc(
        [
            ("heading", "Ch1", 1, 1),
            ("heading", "Sec", 2, 1),
            ("paragraph", "Body text under the section.", None, 1),
        ]
    )
    cs = run(LayoutBlocksChunker, doc)
    assert not any(c.text == "# Ch1" for c in cs.chunks)
    [piece] = cs.chunks
    assert piece.text.startswith("# Ch1\n\n## Sec")
    assert piece.heading_path == ["Ch1", "Sec"]


def test_a_small_table_is_not_counted_as_kept_whole(tmp_path):
    doc = _doc([("heading", "Data", 1, 1), ("table", _table(2), None, 1)])
    cs, note = _apply(doc, tmp_path, max_tokens=400)
    assert note == (
        "Cut 2 blocks into 1 piece along 1 heading. This document has "
        "headings at level 1."
    )
    assert cs.chunker_meta["tables_kept_whole"] == 0


def test_without_headings_a_big_table_is_still_kept_whole(tmp_path):
    doc = _doc([("paragraph", "Intro.", None, 1), ("table", _table(30), None, 1)])
    cs, note = _apply(doc, tmp_path, max_tokens=20)
    assert note == "There are no headings to follow, so the text is cut by size."
    assert len(_holding(cs, "| row0 |")) == 1
    assert "| row29 |" in _holding(cs, "| row0 |")[0].text


# --------------------------------------------------------------------------- #
# Section level
# --------------------------------------------------------------------------- #


def _experience_doc():
    return _doc(
        [
            ("heading", "SUMMARY", 1, 1),
            ("paragraph", "A short summary line.", None, 1),
            ("heading", "EXPERIENCE", 1, 1),
            ("heading", "Role one", 2, 1),
            ("paragraph", "Did the first thing well.", None, 1),
            ("heading", "Role two", 2, 1),
            ("paragraph", "Did the second thing well.", None, 1),
        ]
    )


def test_section_level_defaults_to_every_heading_and_is_bounded():
    assert LayoutBlocksChunker.config_model().section_level == 6
    for bad in (0, 7):
        with pytest.raises(pydantic.ValidationError):
            LayoutBlocksChunker.config_model(section_level=bad)


def test_section_level_one_keeps_a_whole_top_section_in_one_piece():
    cs = run(LayoutBlocksChunker, _experience_doc(), section_level=1)
    experience = _holding(cs, "# EXPERIENCE")
    assert len(experience) == 1
    assert "Role one" in experience[0].text and "Role two" in experience[0].text
    assert len(cs.chunks) == 2


def test_section_level_six_starts_a_piece_at_every_heading():
    cs = run(LayoutBlocksChunker, _experience_doc(), section_level=6)
    starts = [c.text.splitlines()[0] for c in cs.chunks]
    assert starts == ["# SUMMARY", "# EXPERIENCE", "## Role two"]
    assert len(_holding(cs, "# EXPERIENCE")) == 1
    assert "Role one" in _holding(cs, "# EXPERIENCE")[0].text


def test_a_piece_spanning_deeper_headings_keeps_its_path_from_the_top():
    cs = run(LayoutBlocksChunker, _experience_doc(), section_level=1)
    [piece] = _holding(cs, "# EXPERIENCE")
    # The piece opens with EXPERIENCE then a role, so its path names both.
    assert piece.heading_path == ["EXPERIENCE", "Role one"]
    # A piece cut below a role, when the section is too big, still names both.
    small = run(LayoutBlocksChunker, _experience_doc(), section_level=1, max_tokens=8)
    [second] = _holding(small, "Did the second thing well.")
    assert second.heading_path == ["EXPERIENCE", "Role two"]


def test_a_heading_with_no_level_counts_as_level_one():
    doc = _doc(
        [
            ("heading", "Top", 1, 1),
            ("paragraph", "Under top.", None, 1),
            ("heading", "Loose", None, 1),
            ("paragraph", "Under loose.", None, 1),
            ("heading", "Deep", 2, 1),
            ("paragraph", "Under deep.", None, 1),
        ]
    )
    cs = run(LayoutBlocksChunker, doc, section_level=1)
    starts = [c.text.splitlines()[0] for c in cs.chunks]
    assert starts == ["# Top", "# Loose"]
    assert "Under deep." in cs.chunks[1].text


def test_the_schema_description_names_section_level():
    schema = LayoutBlocksChunker.config_model.model_json_schema()
    description = schema["properties"]["section_level"]["description"]
    assert "section_level" in description


def test_explain_names_section_level_and_changes_with_it():
    cls = LayoutBlocksChunker
    top = cls().explain(cls.config_model(section_level=1)).settings
    every = cls().explain(cls.config_model(section_level=6)).settings
    assert "section_level" in top and "section_level" in every
    assert top != every
    for text in (top, every):
        assert chr(0x2014) not in text and chr(0x2013) not in text


def test_the_note_lists_the_heading_levels_in_the_document(tmp_path):
    doc = _doc(
        [
            ("heading", "Title", 2, 1),
            ("heading", "Section", 3, 1),
            ("heading", "Role", 4, 1),
            ("paragraph", "Body.", None, 1),
        ]
    )
    _, note = _apply(doc, tmp_path, section_level=3)
    assert note.endswith("This document has headings at levels 2, 3 and 4.")


def test_section_level_help_says_where_levels_come_from():
    cls = LayoutBlocksChunker
    description = cls.config_model.model_json_schema()["properties"]["section_level"][
        "description"
    ]
    texts = [description, *cls.learn["section_level"]["more"]]
    joined = " ".join(texts)
    assert "Docling" in joined and "heading_hierarchy" in joined
    assert "A title is 1 and section headings start at 2" in description
    assert "3 kept a section whole" in description
    assert "Experience section" not in joined
    top = cls().explain(cls.config_model(section_level=1)).settings
    assert "only headings at level 1 start a new section" in top


def test_a_deeper_heading_joins_a_table_kept_whole_below_it():
    doc = _doc(
        [
            ("heading", "TOP", 1, 1),
            ("paragraph", "Intro line.", None, 1),
            ("heading", "Sub", 2, 1),
            ("table", _table(30), None, 1),
            ("paragraph", "After.", None, 1),
        ]
    )
    cs = run(LayoutBlocksChunker, doc, section_level=1, max_tokens=20)
    [table] = _holding(cs, "| row0 |")
    assert table.text.startswith("## Sub")
    assert "| row29 |" in table.text
    [after] = _holding(cs, "After.")
    assert after.heading_path == ["TOP", "Sub"]

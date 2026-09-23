"""Payload models — and the one invariant that makes the whole tool honest.

Elements are canonical; markdown is a *rendered projection* of them. Nothing
stores markdown. `render_markdown()` derives it and stamps each element with the
offsets at which its own rendered text appears, so every downstream chunker's
`start_char`/`end_char` can be traced back to a real element.

The property tests below are the ones that keep that true: if a rendering rule
and an offset ever disagree, the slice-back test fails immediately.
"""

import pytest

from core.artifacts import Artifact, ArtifactType
from core.payloads import (
    Chunk,
    ChunkSet,
    Element,
    Hit,
    Output,
    ParsedDoc,
    QaItem,
    QaSet,
    Query,
    RetrievalResult,
)
from core.storage import Store

EXCLUDED = ("header", "footer", "page_number")


def el(eid, type_, text, order, **kw):
    return Element(id=eid, type=type_, text=text, order=order, **kw)


@pytest.fixture
def rich_doc():
    """One element of every declared type, in a deliberately scrambled list order."""
    return ParsedDoc(
        elements=[
            el("e5", "code", "print('hi')", 5),
            el("e0", "header", "ACME Confidential", 0),
            el("e2", "paragraph", "Paris is the capital of France.", 2),
            el("e1", "heading", "Introduction", 1, level=1),
            el("e9", "page_number", "3", 9),
            el("e3", "heading", "Details", 3, level=2),
            el("e4", "list_item", "first point", 4),
            el("e6", "table", "| a | b |\n| - | - |\n| 1 | 2 |", 6),
            el("e7", "figure", "Figure 1", 7),
            el("e8", "caption", "A caption.", 8),
            el("e10", "footnote", "A footnote.", 10),
            el("e11", "formula", "E = mc^2", 11),
            el("e12", "footer", "page 3 of 9", 12),
        ],
        page_count=3,
        source_id="src-1",
        filename="acme.pdf",
    )


# --- model shape -------------------------------------------------------------


def test_element_requires_id_type_text_order():
    e = el("e1", "paragraph", "hello", 0)
    assert (e.parent_id, e.page, e.bbox, e.level) == (None, None, None, None)
    assert (e.md_start, e.md_end) == (None, None)


def test_element_rejects_unknown_type():
    with pytest.raises(ValueError):
        el("e1", "sidebar", "hello", 0)


def test_element_bbox_is_a_four_tuple():
    e = el("e1", "paragraph", "hi", 0, bbox=[1, 2, 3.5, 4])
    assert e.bbox == (1.0, 2.0, 3.5, 4.0)


def test_parsed_doc_has_no_markdown_field():
    """Markdown is a projection. Storing it is the bug this design prevents."""
    assert "markdown" not in ParsedDoc.model_fields


def test_chunk_defaults():
    c = Chunk(id="c1", text="body")
    assert (c.start_char, c.end_char, c.token_count) == (0, 0, 0)
    assert (c.kind, c.level, c.ordinal) == ("chunk", 0, 0)
    assert (c.heading_path, c.source_element_ids, c.metadata) == ([], [], {})
    assert c.page_span is None


def test_chunk_text_to_embed_falls_back_to_text():
    assert Chunk(id="c1", text="body").text_to_embed == "body"


def test_chunk_text_to_embed_uses_embed_text_when_set():
    c = Chunk(id="c1", text="body", embed_text="context: body")
    assert c.text_to_embed == "context: body"


def test_chunk_text_to_embed_honours_empty_embed_text():
    """An empty string is a deliberate choice, not an absent one."""
    assert Chunk(id="c1", text="body", embed_text="").text_to_embed == ""


def test_text_to_embed_is_not_a_serialized_field():
    assert "text_to_embed" not in Chunk(id="c1", text="b").model_dump()


def test_every_container_model_is_default_constructible():
    for model in (ChunkSet, Query, RetrievalResult, Output, QaSet):
        model()


def test_hit_and_qaitem_defaults():
    h = Hit(chunk=Chunk(id="c1", text="b"), score=0.5, rank=1)
    assert (h.prior_rank, h.prior_score) == (None, None)
    assert (h.expansion, h.retriever, h.matched_chunk_id) == ("none", "", "")
    assert (h.component_scores, h.highlights) == ({}, [])
    q = QaItem(question="what?")
    assert (q.gold_chunk_ids, q.gold_answer) == ([], None)


# --- I-32: several gold passages per question --------------------------------


def test_a_query_with_no_gold_has_no_golds():
    assert Query(text="q?").golds == []
    assert Query(text="q?", gold_answer="   ").golds == []


def test_the_single_gold_answer_is_the_whole_list_when_it_is_alone():
    assert Query(gold_answer="  One sentence.  ").golds == ["One sentence."]


def test_the_list_wins_and_includes_the_single_one():
    q = Query(gold_answer="A.", gold_answers=["B.", "C."])
    assert q.golds == ["A.", "B.", "C."]


def test_a_gold_repeated_in_both_fields_appears_once():
    assert Query(gold_answer="A.", gold_answers=["A.", "B."]).golds == ["A.", "B."]


def test_blank_entries_in_the_list_are_dropped():
    assert Query(gold_answers=["A.", "  ", ""]).golds == ["A."]


# --- rendering rules ---------------------------------------------------------


def test_renders_in_order_field_not_list_order(rich_doc):
    md, _ = rich_doc.render_markdown()
    assert md.index("Introduction") < md.index("Paris is the capital")
    assert md.index("Paris is the capital") < md.index("Details")
    assert md.index("Details") < md.index("first point")


def test_heading_renders_hashes_by_level(rich_doc):
    md, _ = rich_doc.render_markdown()
    assert "# Introduction" in md
    assert "## Details" in md


def test_heading_without_level_defaults_to_h1():
    md, _ = ParsedDoc(elements=[el("e1", "heading", "Title", 0)]).render_markdown()
    assert md == "# Title"


def test_list_item_renders_with_dash(rich_doc):
    md, _ = rich_doc.render_markdown()
    assert "- first point" in md


def test_code_is_fenced(rich_doc):
    md, _ = rich_doc.render_markdown()
    assert "```\nprint('hi')\n```" in md


def test_table_passes_through_as_is(rich_doc):
    md, _ = rich_doc.render_markdown()
    assert "| a | b |\n| - | - |\n| 1 | 2 |" in md


def test_paragraph_passes_through_as_is(rich_doc):
    md, _ = rich_doc.render_markdown()
    assert "Paris is the capital of France." in md


def test_blocks_are_separated_by_a_blank_line():
    doc = ParsedDoc(
        elements=[el("a", "paragraph", "one", 0), el("b", "paragraph", "two", 1)]
    )
    md, _ = doc.render_markdown()
    assert md == "one\n\ntwo"


# --- the projection invariants ----------------------------------------------


@pytest.mark.parametrize("bad", EXCLUDED)
def test_excluded_types_never_appear_in_the_projection(rich_doc, bad):
    md, offsets = rich_doc.render_markdown()
    text = next(e.text for e in rich_doc.elements if e.type == bad)
    assert text not in md
    assert not any(e.id in offsets for e in rich_doc.elements if e.type == bad)


def test_excluded_elements_get_no_offsets(rich_doc):
    rich_doc.render_markdown()
    for e in rich_doc.elements:
        if e.type in EXCLUDED:
            assert (e.md_start, e.md_end) == (None, None)


def test_every_rendered_element_slices_back_exactly(rich_doc):
    """The property test: markdown[md_start:md_end] IS the element's rendered text."""
    md, offsets = rich_doc.render_markdown()
    rendered = [e for e in rich_doc.elements if e.type not in EXCLUDED]
    assert len(offsets) == len(rendered)
    for e in rendered:
        assert e.md_start is not None and e.md_end is not None
        start, end = offsets[e.id]
        assert (start, end) == (e.md_start, e.md_end)
        assert md[start:end] == _expected_render(e)
        assert e.text in md[start:end]


def _expected_render(e):
    if e.type == "heading":
        return "#" * (e.level or 1) + " " + e.text
    if e.type == "list_item":
        return "- " + e.text
    if e.type == "code":
        return "```\n" + e.text + "\n```"
    return e.text


def test_offsets_are_ordered_and_non_overlapping(rich_doc):
    md, offsets = rich_doc.render_markdown()
    spans = sorted(offsets.values())
    for (_, prev_end), (next_start, _) in zip(spans, spans[1:]):
        assert prev_end <= next_start
    assert spans[-1][1] <= len(md)


def test_render_is_stable_across_repeated_calls(rich_doc):
    first_md, first_offsets = rich_doc.render_markdown()
    second_md, second_offsets = rich_doc.render_markdown()
    third_md, third_offsets = rich_doc.render_markdown()
    assert first_md == second_md == third_md
    assert first_offsets == second_offsets == third_offsets


def test_render_is_stable_on_an_equivalent_fresh_doc(rich_doc):
    clone = ParsedDoc.model_validate(rich_doc.model_dump())
    assert rich_doc.render_markdown()[0] == clone.render_markdown()[0]


def test_empty_doc_renders_to_empty_string():
    md, offsets = ParsedDoc(elements=[]).render_markdown()
    assert md == ""
    assert offsets == {}


def test_doc_of_only_excluded_elements_renders_to_empty_string():
    doc = ParsedDoc(
        elements=[el("h", "header", "ACME", 0), el("f", "footer", "p1", 1)]
    )
    md, offsets = doc.render_markdown()
    assert md == ""
    assert offsets == {}


def test_element_with_empty_text_still_slices_back():
    doc = ParsedDoc(
        elements=[el("a", "paragraph", "", 0), el("b", "paragraph", "after", 1)]
    )
    md, offsets = doc.render_markdown()
    assert md[offsets["a"][0] : offsets["a"][1]] == ""
    assert md[offsets["b"][0] : offsets["b"][1]] == "after"


def test_unicode_slices_back_by_character_offsets():
    doc = ParsedDoc(
        elements=[
            el("a", "paragraph", "café — naïve", 0),
            el("b", "heading", "Résumé", 1, level=2),
        ]
    )
    md, offsets = doc.render_markdown()
    assert md[offsets["a"][0] : offsets["a"][1]] == "café — naïve"
    assert md[offsets["b"][0] : offsets["b"][1]] == "## Résumé"


def test_removing_an_element_reprojects_cleanly(rich_doc):
    """A cleaner drops elements; the projection follows with no stale offsets."""
    rich_doc.render_markdown()
    rich_doc.elements = [e for e in rich_doc.elements if e.id != "e2"]
    md, offsets = rich_doc.render_markdown()
    assert "Paris is the capital" not in md
    assert "e2" not in offsets
    for e in rich_doc.elements:
        if e.type not in EXCLUDED:
            assert md[e.md_start : e.md_end] == _expected_render(e)


# --- storage round-trip ------------------------------------------------------


AID = "abcdef0123456789" + "f" * 48


@pytest.fixture
def store(tmp_path):
    return Store(tmp_path / "artifacts")


def _roundtrip(store, model, artifact_type, aid=AID):
    store.put(Artifact(id=aid, type=artifact_type), model)
    return type(model).model_validate(store.load(aid, artifact_type))


def test_parsed_doc_round_trips_through_the_store(store, rich_doc):
    rich_doc.elements[2].bbox = (1.0, 2.0, 3.0, 4.0)
    rich_doc.elements[2].page = 1
    rich_doc.render_markdown()
    back = _roundtrip(store, rich_doc, ArtifactType.PARSED_DOC)
    assert back == rich_doc
    assert back.render_markdown() == rich_doc.render_markdown()


def test_chunk_set_round_trips_through_the_store(store):
    cs = ChunkSet(
        chunks=[
            Chunk(
                id="c1",
                text="Paris is the capital.",
                embed_text="Context. Paris is the capital.",
                start_char=0,
                end_char=21,
                token_count=5,
                doc_id="d1",
                heading_path=["Intro", "Details"],
                source_element_ids=["e2", "e3"],
                page_span=(1, 2),
                metadata={"lang": "en"},
            ),
            Chunk(id="c2", text="Another chunk.", ordinal=1, doc_id="d1"),
        ],
        doc_id="d1",
        source_text="Paris is the capital.\n\nAnother chunk.",
        chunker_meta={"chunker": "recursive_character"},
    )
    back = _roundtrip(store, cs, ArtifactType.CHUNK_SET)
    assert back == cs
    assert back.chunks[0].page_span == (1, 2)
    assert back.chunks[0].text_to_embed == "Context. Paris is the capital."


def test_retrieval_result_round_trips_through_the_store(store):
    rr = RetrievalResult(
        hits=[
            Hit(
                chunk=Chunk(id="c1", text="Paris is the capital.", page_span=(1, 1)),
                score=0.91,
                rank=0,
                prior_rank=3,
                prior_score=0.42,
                matched_chunk_id="c1-small",
                expansion="parent",
                retriever="hybrid_rrf",
                component_scores={"dense": 0.8, "bm25": 0.3},
                highlights=[(0, 5), (10, 17)],
            )
        ],
        query_id="q1",
        fetch_k=20,
        total_candidates=47,
        timings_ms={"dense": 1.5, "fts": 0.75},
    )
    back = _roundtrip(store, rr, ArtifactType.RETRIEVAL_RESULT)
    assert back == rr
    assert back.hits[0].highlights == [(0, 5), (10, 17)]
    assert back.hits[0].chunk.page_span == (1, 1)


def test_query_round_trips_through_the_store(store):
    q = Query(
        text="what is the capital of France?",
        variants=["capital of France", "France capital city"],
        embed_text="The capital of France is Paris.",
        filters={"lang": "en"},
        history=[{"role": "user", "content": "hi"}],
        transform_trace=[{"transform": "hyde", "produced": "..."}],
    )
    assert _roundtrip(store, q, ArtifactType.QUERY) == q


def test_output_and_qa_set_round_trip_through_the_store(store):
    out = Output(kind="search", payload={"hits": [{"rank": 0, "text": "Paris"}]})
    assert _roundtrip(store, out, ArtifactType.OUTPUT) == out
    qa = QaSet(
        items=[
            QaItem(
                question="capital of France?",
                gold_chunk_ids=["c1"],
                gold_answer="Paris",
            )
        ]
    )
    assert _roundtrip(store, qa, ArtifactType.QA_SET) == qa


def test_round_trip_survives_the_id_canonicalizer(rich_doc):
    """model_dump(mode='json') must be canonicalizable — no tuples, no non-finite."""
    from core.ids import canonical_json

    assert canonical_json(rich_doc.model_dump(mode="json"))

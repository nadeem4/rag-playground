"""Chunk plugin tests.

The load-bearing test in this file is `test_chunk_slices_back_out_of_source_text`:
every chunk from every chunker must satisfy

    chunk_set.source_text[chunk.start_char:chunk.end_char] == chunk.text

That is what makes the chunk-boundary overlay inspector trustworthy. It is
parametrized over every chunker and every document shape, so a new chunker gets
it for free the moment it is added to `CHUNKERS`.
"""

from __future__ import annotations

import pytest

from pandion.artifacts import ArtifactType
from pandion.payloads import ParsedDoc
from pandion.ports import PortSpec, RunContext, Stage
from pandion.plugins.chunk.layout_blocks import LayoutBlocksChunker
from pandion.plugins.chunk.markdown_header import MarkdownHeaderChunker
from pandion.plugins.chunk.recursive_character import RecursiveCharacterChunker
from pandion.plugins.chunk.sentence_window import SentenceWindowChunker
from pandion.plugins.chunk.token_based import TokenBasedChunker
from pandion.tokenize import HeuristicTokenCounter

from chunkdocs import (
    DOCS,
    _doc,
    empty_doc,
    long_paragraph_doc,
    many_headings_doc,
    run,
)

CHUNKERS = [
    RecursiveCharacterChunker,
    MarkdownHeaderChunker,
    TokenBasedChunker,
    LayoutBlocksChunker,
    SentenceWindowChunker,
]


@pytest.fixture(params=sorted(DOCS), ids=sorted(DOCS))
def doc(request) -> ParsedDoc:
    return DOCS[request.param]()


@pytest.fixture(params=CHUNKERS, ids=lambda c: c.name)
def chunker(request):
    return request.param


# --------------------------------------------------------------------------- #
# The invariant
# --------------------------------------------------------------------------- #


def test_chunk_slices_back_out_of_source_text(chunker, doc):
    """source_text[start_char:end_char] == text, for every chunk."""
    result = run(chunker, doc)
    for chunk in result.chunks:
        assert result.source_text[chunk.start_char : chunk.end_char] == chunk.text, (
            f"{chunker.name}: chunk {chunk.ordinal} does not slice back"
        )


def test_slice_back_holds_at_small_budgets(chunker, doc):
    """Tight budgets drive the force-split paths; the invariant still holds."""
    tight = {
        "recursive_character": {"chunk_size": 40, "chunk_overlap": 10},
        "markdown_header": {"max_tokens": 8},
        "token_based": {"max_tokens": 8, "overlap": 3},
        "layout_blocks": {"max_tokens": 8},
        "sentence_window": {"sentences_per_chunk": 1, "overlap_sentences": 0},
    }[chunker.name]
    result = run(chunker, doc, **tight)
    for chunk in result.chunks:
        assert result.source_text[chunk.start_char : chunk.end_char] == chunk.text


def test_source_text_is_the_rendered_markdown(chunker, doc):
    expected, _ = doc.render_markdown()
    result = run(chunker, doc)
    assert result.source_text == expected


def test_offsets_are_sane(chunker, doc):
    result = run(chunker, doc)
    for chunk in result.chunks:
        assert 0 <= chunk.start_char <= chunk.end_char <= len(result.source_text)
        assert chunk.text != ""


# --------------------------------------------------------------------------- #
# Chunk metadata
# --------------------------------------------------------------------------- #


def test_source_element_ids_all_resolve(chunker, doc):
    known = {e.id for e in doc.elements}
    result = run(chunker, doc)
    for chunk in result.chunks:
        assert chunk.source_element_ids, (
            f"{chunker.name}: chunk {chunk.ordinal} cites no source element"
        )
        for element_id in chunk.source_element_ids:
            assert element_id in known, (
                f"{chunker.name}: chunk {chunk.ordinal} cites unknown element "
                f"{element_id!r}"
            )


def test_source_element_ids_really_overlap_the_chunk(chunker, doc):
    """A cited element's rendered span must intersect the chunk's span."""
    doc.render_markdown()
    by_id = {e.id: e for e in doc.elements}
    result = run(chunker, doc)
    for chunk in result.chunks:
        for element_id in chunk.source_element_ids:
            element = by_id[element_id]
            assert element.md_start is not None
            assert element.md_start < chunk.end_char
            assert element.md_end > chunk.start_char


def test_token_count_is_populated(chunker, doc):
    counter = HeuristicTokenCounter()
    result = run(chunker, doc)
    for chunk in result.chunks:
        assert chunk.token_count == counter.count(chunk.text)


def test_ordinals_are_sequential(chunker, doc):
    result = run(chunker, doc)
    assert [c.ordinal for c in result.chunks] == list(range(len(result.chunks)))


def test_doc_id_is_carried(chunker, doc):
    result = run(chunker, doc)
    assert result.doc_id == doc.source_id
    for chunk in result.chunks:
        assert chunk.doc_id == doc.source_id


def test_chunk_ids_are_unique_and_nonempty(chunker, doc):
    result = run(chunker, doc)
    ids = [c.id for c in result.chunks]
    assert all(ids)
    assert len(set(ids)) == len(ids)


def test_page_span_is_within_the_document(chunker, doc):
    doc.render_markdown()
    by_id = {e.id: e for e in doc.elements}
    result = run(chunker, doc)
    for chunk in result.chunks:
        pages = [
            by_id[eid].page
            for eid in chunk.source_element_ids
            if by_id[eid].page is not None
        ]
        if not pages:
            assert chunk.page_span is None
        else:
            assert chunk.page_span == (min(pages), max(pages))


def test_heading_path_entries_are_real_headings(chunker, doc):
    headings = {e.text for e in doc.elements if e.type == "heading"}
    result = run(chunker, doc)
    for chunk in result.chunks:
        for entry in chunk.heading_path:
            assert entry in headings


def test_chunkers_are_deterministic(chunker, doc):
    first = run(chunker, doc)
    second = run(chunker, doc)
    assert first.model_dump(mode="json") == second.model_dump(mode="json")


def test_empty_doc_yields_empty_chunk_set(chunker):
    result = run(chunker, empty_doc())
    assert result.chunks == []
    assert result.source_text == ""


def test_chunker_meta_names_the_chunker(chunker, doc):
    result = run(chunker, doc)
    assert result.chunker_meta.get("chunker") == chunker.name


# --------------------------------------------------------------------------- #
# Transform declarations
# --------------------------------------------------------------------------- #


def test_declares_the_chunk_stage(chunker):
    assert chunker.stage is Stage.CHUNK
    assert chunker.output is ArtifactType.CHUNK_SET
    assert chunker.inputs == {"doc": PortSpec(ArtifactType.PARSED_DOC)}


def test_accepts_a_plain_dict_payload(chunker):
    """The executor hands back JSON, not a model instance."""
    doc = many_headings_doc()
    inst = chunker()
    result = inst.apply(
        {"doc": doc.model_dump(mode="json")}, chunker.config_model(), None
    )
    assert result.chunks
    first = result.chunks[0]
    assert result.source_text[first.start_char : first.end_char] == first.text


def test_registered_in_the_global_registry(chunker):
    from pandion.registry import registry

    assert registry.get(Stage.CHUNK, chunker.name) is chunker


# --------------------------------------------------------------------------- #
# recursive_character
# --------------------------------------------------------------------------- #


def test_recursive_character_respects_chunk_size():
    doc = long_paragraph_doc()
    result = run(RecursiveCharacterChunker, doc, chunk_size=200, chunk_overlap=50)
    assert len(result.chunks) > 1
    for chunk in result.chunks:
        assert chunk.end_char - chunk.start_char <= 200


def test_recursive_character_overlap_actually_overlaps():
    doc = long_paragraph_doc()
    result = run(RecursiveCharacterChunker, doc, chunk_size=300, chunk_overlap=100)
    pairs = list(zip(result.chunks, result.chunks[1:]))
    assert pairs
    overlapping = [
        (a, b)
        for a, b in pairs
        if a.start_char < b.start_char < a.end_char
    ]
    assert len(overlapping) >= len(pairs) // 2, (
        "overlap was configured but consecutive chunks do not overlap"
    )


def test_recursive_character_zero_overlap_does_not_overlap():
    doc = long_paragraph_doc()
    result = run(RecursiveCharacterChunker, doc, chunk_size=300, chunk_overlap=0)
    for a, b in zip(result.chunks, result.chunks[1:]):
        assert b.start_char >= a.end_char


def test_recursive_character_prefers_paragraph_boundaries():
    doc = _doc(
        [
            ("paragraph", "First paragraph.", None, 1),
            ("paragraph", "Second paragraph.", None, 1),
            ("paragraph", "Third paragraph.", None, 1),
        ]
    )
    result = run(RecursiveCharacterChunker, doc, chunk_size=20, chunk_overlap=0)
    assert [c.text for c in result.chunks] == [
        "First paragraph.",
        "Second paragraph.",
        "Third paragraph.",
    ]


def test_recursive_character_covers_every_word():
    doc = long_paragraph_doc()
    result = run(RecursiveCharacterChunker, doc, chunk_size=250, chunk_overlap=0)
    joined = "".join(c.text for c in result.chunks)
    for i in (0, 450, 899):
        assert f"word{i}" in joined


def _recursive_note(doc, tmp_path, **cfg):
    ctx = RunContext(output_dir=tmp_path, emit=lambda e: None, tmp=tmp_path)
    out = RecursiveCharacterChunker().apply(
        {"doc": doc}, RecursiveCharacterChunker.config_model(**cfg), ctx
    )
    return out, ctx.extras.get("meta", {}).get("note")


def _experience_doc():
    return _doc(
        [
            ("heading", "EXPERIENCE", 1, 1),
            ("heading", "Role one", 2, 1),
            ("paragraph", "Did the first thing well.", None, 1),
        ]
    )


def test_recursive_character_heading_context_is_on_by_default():
    assert RecursiveCharacterChunker.config_model().heading_context is True


def test_recursive_character_prefixes_the_heading_path_to_embed_text_only():
    doc = _experience_doc()
    result = run(RecursiveCharacterChunker, doc, chunk_size=26, chunk_overlap=0)
    [body] = [c for c in result.chunks if "Did the first thing" in c.text]
    assert body.text == "Did the first thing well."
    assert body.heading_path == ["EXPERIENCE", "Role one"]
    assert body.embed_text == "EXPERIENCE > Role one\n\nDid the first thing well."


def test_recursive_character_does_not_repeat_the_headings_a_chunk_opens_with():
    doc = _experience_doc()
    result = run(RecursiveCharacterChunker, doc, chunk_overlap=0)
    [chunk] = result.chunks
    assert chunk.text.startswith("# EXPERIENCE\n\n## Role one")
    assert chunk.heading_path == ["EXPERIENCE", "Role one"]
    assert chunk.embed_text is None
    # A chunk that opens with the role only gets the part of the path above it.
    doc = _doc(
        [
            ("heading", "EXPERIENCE", 1, 1),
            ("paragraph", "Intro under experience.", None, 1),
            ("heading", "Role one", 2, 1),
            ("paragraph", "Did the first thing well.", None, 1),
        ]
    )
    result = run(RecursiveCharacterChunker, doc, chunk_size=40, chunk_overlap=0)
    [role] = [c for c in result.chunks if c.text.startswith("## Role one")]
    assert role.embed_text == "EXPERIENCE\n\n" + role.text


def test_recursive_character_heading_context_off_leaves_embed_text_unset():
    doc = _experience_doc()
    result = run(
        RecursiveCharacterChunker,
        doc,
        chunk_size=26,
        chunk_overlap=0,
        heading_context=False,
    )
    assert all(c.embed_text is None for c in result.chunks)


def test_recursive_character_without_headings_is_unchanged(tmp_path):
    doc = long_paragraph_doc()
    on, note = _recursive_note(doc, tmp_path, chunk_size=200, chunk_overlap=0)
    off, _ = _recursive_note(
        doc, tmp_path, chunk_size=200, chunk_overlap=0, heading_context=False
    )
    assert [c.text for c in on.chunks] == [c.text for c in off.chunks]
    assert all(c.embed_text is None for c in on.chunks)
    assert note == (
        "There are no headings in this document, so heading_context adds nothing."
    )


def test_recursive_character_schema_and_explain_name_heading_context():
    cls = RecursiveCharacterChunker
    schema = cls.config_model.model_json_schema()
    assert "heading_context" in schema["properties"]["heading_context"]["description"]
    on = cls().explain(cls.config_model()).settings
    off = cls().explain(cls.config_model(heading_context=False)).settings
    assert "heading_context" in on and on != off


# --------------------------------------------------------------------------- #
# markdown_header
# --------------------------------------------------------------------------- #


def test_markdown_header_keeps_a_heading_with_its_body():
    doc = many_headings_doc()
    result = run(MarkdownHeaderChunker, doc)
    first = result.chunks[0]
    assert first.text.startswith("# Alpha")
    assert "Alpha body text goes here." in first.text


def test_markdown_header_splits_on_heading_boundaries():
    doc = many_headings_doc()
    result = run(MarkdownHeaderChunker, doc)
    starts = [c.text.splitlines()[0] for c in result.chunks]
    assert starts == ["# Alpha", "## Beta", "### Gamma", "# Delta"]


def test_markdown_header_sets_nested_heading_paths():
    doc = many_headings_doc()
    result = run(MarkdownHeaderChunker, doc)
    assert [c.heading_path for c in result.chunks] == [
        ["Alpha"],
        ["Alpha", "Beta"],
        ["Alpha", "Beta", "Gamma"],
        ["Delta"],
    ]


def test_markdown_header_emits_a_preamble_chunk_with_no_heading():
    doc = _doc(
        [
            ("paragraph", "Front matter before any heading.", None, 1),
            ("heading", "Alpha", 1, 1),
            ("paragraph", "Body.", None, 1),
        ]
    )
    result = run(MarkdownHeaderChunker, doc)
    assert result.chunks[0].heading_path == []
    assert result.chunks[0].text == "Front matter before any heading."
    assert result.chunks[1].heading_path == ["Alpha"]


def test_markdown_header_splits_oversized_sections():
    doc = long_paragraph_doc()
    result = run(MarkdownHeaderChunker, doc, max_tokens=64)
    assert len(result.chunks) > 1


def test_markdown_header_keeps_the_heading_path_on_split_sections():
    prose = " ".join(f"token{i}" for i in range(400))
    doc = _doc(
        [
            ("heading", "Alpha", 1, 1),
            ("heading", "Beta", 2, 1),
            ("paragraph", prose, None, 1),
        ]
    )
    result = run(MarkdownHeaderChunker, doc, max_tokens=32)
    assert len(result.chunks) > 2
    assert all(c.heading_path == ["Alpha", "Beta"] for c in result.chunks[1:])


# --------------------------------------------------------------------------- #
# token_based
# --------------------------------------------------------------------------- #


def test_token_based_respects_max_tokens():
    counter = HeuristicTokenCounter()
    doc = long_paragraph_doc()
    result = run(TokenBasedChunker, doc, max_tokens=50, overlap=10)
    assert len(result.chunks) > 1
    for chunk in result.chunks:
        assert counter.count(chunk.text) <= 50


def test_token_based_overlaps_by_the_configured_amount():
    doc = long_paragraph_doc()
    result = run(TokenBasedChunker, doc, max_tokens=50, overlap=10)
    for a, b in zip(result.chunks, result.chunks[1:]):
        assert b.start_char < a.end_char


def test_token_based_zero_overlap_tiles_the_document():
    counter = HeuristicTokenCounter()
    doc = long_paragraph_doc()
    result = run(TokenBasedChunker, doc, max_tokens=50, overlap=0)
    for a, b in zip(result.chunks, result.chunks[1:]):
        assert b.start_char >= a.end_char
    total = sum(c.token_count for c in result.chunks)
    assert total == counter.count(result.source_text)


def test_token_based_overlap_larger_than_budget_still_terminates():
    doc = long_paragraph_doc()
    result = run(TokenBasedChunker, doc, max_tokens=20, overlap=100)
    assert len(result.chunks) > 1
    for chunk in result.chunks:
        assert result.source_text[chunk.start_char : chunk.end_char] == chunk.text


def test_markdown_header_prefers_headings_and_names_its_fallback():
    """The UI shows a soft lock, and this sentence, when the parser finds no headings."""
    from pandion.plugins.chunk.markdown_header import MarkdownHeaderChunker

    assert MarkdownHeaderChunker.prefers == {"doc": {"structure": ["headings"]}}
    assert MarkdownHeaderChunker.fallback == (
        "The whole document is treated as one section and cut by size."
    )


def test_size_chunkers_prefer_nothing():
    from pandion.plugins.chunk.recursive_character import RecursiveCharacterChunker
    from pandion.plugins.chunk.token_based import TokenBasedChunker

    assert RecursiveCharacterChunker.prefers == {}
    assert TokenBasedChunker.prefers == {}


def test_the_character_chunker_defaults_to_the_samples_400_and_80():
    # One default everywhere: a fresh step, Compare's Start from defaults and the
    # sample pipeline all cut at 400 characters with 80 of overlap, which makes
    # more pieces than the search returns on every sample.
    from pandion.plugins.chunk.recursive_character import RecursiveCharacterConfig

    c = RecursiveCharacterConfig()
    assert (c.chunk_size, c.chunk_overlap) == (400, 80)


# --------------------------------------------------------------------------- #
# heading_context on token_based and sentence_window
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("cls", [TokenBasedChunker, SentenceWindowChunker])
def test_heading_context_is_off_by_default_so_stored_ids_stay(cls):
    config = cls.config_model()
    assert config.heading_context is False
    assert "heading_context" not in config.model_dump()


def test_token_based_heading_context_prefixes_embed_text_only():
    doc = _experience_doc()
    result = run(TokenBasedChunker, doc, max_tokens=6, overlap=0, heading_context=True)
    [body] = [c for c in result.chunks if "Did the first thing" in c.text]
    assert body.text == "Did the first thing well."
    assert body.embed_text == "EXPERIENCE > Role one\n\nDid the first thing well."
    off = run(TokenBasedChunker, doc, max_tokens=6, overlap=0)
    assert [c.text for c in off.chunks] == [c.text for c in result.chunks]
    assert all(c.embed_text is None for c in off.chunks)


def test_sentence_window_heading_context_prefixes_embed_text_only():
    doc = _doc(
        [
            ("heading", "EXPERIENCE", 1, 1),
            ("paragraph", "First sentence here. Second sentence here.", None, 1),
        ]
    )
    result = run(
        SentenceWindowChunker,
        doc,
        sentences_per_chunk=1,
        overlap_sentences=0,
        heading_context=True,
    )
    first, second = result.chunks
    assert first.embed_text is None  # it opens with the heading itself
    assert second.text == "Second sentence here."
    assert second.embed_text == "EXPERIENCE\n\nSecond sentence here."


@pytest.mark.parametrize("cls", [TokenBasedChunker, SentenceWindowChunker])
def test_heading_context_is_named_in_schema_and_explain(cls):
    schema = cls.config_model.model_json_schema()
    assert "heading_context" in schema["properties"]["heading_context"]["description"]
    on = cls().explain(cls.config_model(heading_context=True)).settings
    off = cls().explain(cls.config_model()).settings
    assert "heading_context" in on and on != off

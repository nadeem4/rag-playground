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

from core.artifacts import ArtifactType
from core.payloads import Element, ParsedDoc
from core.ports import PortSpec, Stage
from plugins.chunk.markdown_header import MarkdownHeaderChunker
from plugins.chunk.recursive_character import RecursiveCharacterChunker
from plugins.chunk.token_based import TokenBasedChunker
from providers.tokenize import HeuristicTokenCounter

CHUNKERS = [RecursiveCharacterChunker, MarkdownHeaderChunker, TokenBasedChunker]


# --------------------------------------------------------------------------- #
# Document fixtures
# --------------------------------------------------------------------------- #


def _doc(specs, *, source_id="doc0123456789ab", page_count=1) -> ParsedDoc:
    """Build a ParsedDoc from `(type, text, level, page)` tuples."""
    elements = [
        Element(
            id=f"e{i}",
            type=etype,
            text=text,
            order=i,
            level=level,
            page=page,
        )
        for i, (etype, text, level, page) in enumerate(specs)
    ]
    return ParsedDoc(
        elements=elements,
        page_count=page_count,
        source_id=source_id,
        filename="fixture.pdf",
    )


def empty_doc() -> ParsedDoc:
    return _doc([], page_count=0)


def single_paragraph_doc() -> ParsedDoc:
    return _doc([("paragraph", "A single short paragraph about ducks.", None, 1)])


def many_headings_doc() -> ParsedDoc:
    return _doc(
        [
            ("heading", "Alpha", 1, 1),
            ("paragraph", "Alpha body text goes here.", None, 1),
            ("heading", "Beta", 2, 1),
            ("paragraph", "Beta body text goes here.", None, 1),
            ("heading", "Gamma", 3, 2),
            ("list_item", "gamma one", None, 2),
            ("list_item", "gamma two", None, 2),
            ("heading", "Delta", 1, 2),
            ("paragraph", "Delta body text goes here.", None, 2),
            ("header", "running head, excluded", None, 2),
            ("page_number", "7", None, 2),
        ],
        page_count=2,
    )


def unicode_doc() -> ParsedDoc:
    return _doc(
        [
            ("heading", "Café — Übersicht 日本語", 1, 1),
            ("paragraph", "Naïve résumé façade. 東京は日本の首都です。", None, 1),
            ("paragraph", "Ελληνικά κείμενα και emoji 🐿️🌍 μαζί.", None, 1),
        ]
    )


def long_paragraph_doc() -> ParsedDoc:
    """One paragraph far past any chunk budget, plus an unsplittable run.

    The 4000-character no-whitespace run forces every chunker down to its
    hard-split fallback, which is exactly where offset bookkeeping breaks.
    """
    prose = " ".join(f"word{i}" for i in range(900))
    return _doc(
        [
            ("paragraph", prose, None, 1),
            ("paragraph", "x" * 4000, None, 1),
        ]
    )


def mixed_doc() -> ParsedDoc:
    return _doc(
        [
            ("heading", "Title", 1, 1),
            ("paragraph", "Intro.\nSecond line of intro. Third sentence here.", None, 1),
            ("code", "def f():\n    return 1", None, 1),
            ("table", "| a | b |\n| - | - |\n| 1 | 2 |", None, 2),
            ("footnote", "A footnote.", None, 2),
        ],
        page_count=2,
    )


DOCS = {
    "empty": empty_doc,
    "single_paragraph": single_paragraph_doc,
    "many_headings": many_headings_doc,
    "unicode": unicode_doc,
    "long_paragraph": long_paragraph_doc,
    "mixed": mixed_doc,
}


def run(cls, doc: ParsedDoc, **cfg):
    """Instantiate a chunker and apply it to `doc`."""
    inst = cls()
    return inst.apply({"doc": doc}, cls.config_model(**cfg), None)


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
    from core.registry import registry

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

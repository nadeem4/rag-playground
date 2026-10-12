"""Small parsed documents the chunk tests share.

A plain module, not a conftest, so `test_chunk.py`, `test_chunk_layout_blocks.py`
and `test_chunk_sentence_window.py` can import the same builders.
"""

from __future__ import annotations

from pandion.payloads import Element, ParsedDoc


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

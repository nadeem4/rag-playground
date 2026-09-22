"""Plugin explanations (I-11) and outcome notes (I-13), beyond the contract suite."""

from __future__ import annotations

import pytest

from core.payloads import Element, ParsedDoc
from core.ports import RunContext
from plugins.chunk.markdown_header import MarkdownHeaderChunker, MarkdownHeaderConfig
from plugins.chunk.recursive_character import (
    RecursiveCharacterChunker,
    RecursiveCharacterConfig,
)
from plugins.chunk.token_based import TokenBasedChunker, TokenBasedConfig
from plugins.clean.drop_matching import DropMatching, DropMatchingConfig
from plugins.clean.header_footer_strip import HeaderFooterStrip, HeaderFooterStripConfig
from plugins.index.lancedb_store import LanceDbIndex, LanceDbIndexConfig
from plugins.use_case.chat import ChatConfig, ChatUseCase


# --- blocking warnings -----------------------------------------------------


@pytest.mark.parametrize("overlap", [100, 150])
def test_recursive_character_blocks_overlap_at_or_over_size(overlap):
    exp = RecursiveCharacterChunker().explain(
        RecursiveCharacterConfig(chunk_size=100, chunk_overlap=overlap)
    )
    assert exp.blocking is True
    assert "overlap" in exp.warning.lower()


def test_recursive_character_default_is_not_blocking():
    exp = RecursiveCharacterChunker().explain(RecursiveCharacterConfig())
    assert exp.blocking is False and exp.warning is None
    assert "1,000" in exp.settings and "200" in exp.settings
    assert exp.tradeoff


def test_token_based_blocks_overlap_at_or_over_max_tokens():
    exp = TokenBasedChunker().explain(TokenBasedConfig(max_tokens=64, overlap=64))
    assert exp.blocking is True


def test_lancedb_blocks_truncation_over_native_dim():
    exp = LanceDbIndex().explain(LanceDbIndexConfig(truncate_dim=2048))
    assert exp.blocking is True
    assert "1024" in exp.warning


def test_lancedb_blocks_truncation_on_a_non_matryoshka_embedder():
    exp = LanceDbIndex().explain(
        LanceDbIndexConfig(embedder="bge-small-en-v1.5", truncate_dim=128)
    )
    assert exp.blocking is True
    assert "matryoshka" in exp.warning.lower()


def test_lancedb_blocks_a_non_positive_truncation():
    exp = LanceDbIndex().explain(LanceDbIndexConfig(truncate_dim=0))
    assert exp.blocking is True


def test_lancedb_names_embedder_and_widths():
    exp = LanceDbIndex().explain(LanceDbIndexConfig(truncate_dim=256))
    assert exp.blocking is False
    assert "qwen3-embedding-0.6b" in exp.settings
    assert "1024" in exp.settings and "256" in exp.settings


def test_lancedb_warns_when_fts_is_off():
    exp = LanceDbIndex().explain(LanceDbIndexConfig(build_fts=False))
    assert exp.blocking is False
    assert "bm25" in exp.warning


def test_chat_names_model_and_needs_a_key():
    exp = ChatUseCase().explain(ChatConfig())
    text = exp.settings + (exp.tradeoff or "")
    assert "Opus 5" in text
    assert "API key" in text
    assert "citation" in text.lower()


def test_drop_matching_blocks_an_invalid_regex():
    exp = DropMatching().explain(DropMatchingConfig(pattern="(", mode="regex"))
    assert exp.blocking is True


def test_header_footer_strip_zero_ratio_warns_but_does_not_block():
    """A block must repeat on at least two pages, so 0% no longer empties
    the document; it only drops the ratio's extra protection."""
    exp = HeaderFooterStrip().explain(HeaderFooterStripConfig(min_page_ratio=0.0))
    assert exp.blocking is False
    assert "two pages" in exp.warning


def test_header_footer_strip_default_has_no_short_document_warning():
    exp = HeaderFooterStrip().explain(HeaderFooterStripConfig())
    assert exp.warning is None
    assert "two pages" in exp.settings


# --- outcome notes (I-13) --------------------------------------------------


def _ctx(tmp_path) -> RunContext:
    return RunContext(output_dir=tmp_path, emit=lambda e: None, tmp=tmp_path)


def _doc(elements) -> ParsedDoc:
    return ParsedDoc(
        elements=[
            Element(id=f"e{i}", type=t, text=x, order=i, page=p, level=1 if t == "heading" else None)
            for i, (t, x, p) in enumerate(elements)
        ],
        page_count=max(p for _, _, p in elements),
        source_id="s",
        filename="f.pdf",
    )


def test_markdown_header_notes_the_fallback(tmp_path):
    ctx = _ctx(tmp_path)
    MarkdownHeaderChunker().apply(
        {"doc": _doc([("paragraph", "one", 1), ("paragraph", "two", 1)])},
        MarkdownHeaderConfig(max_tokens=300),
        ctx,
    )
    note = ctx.extras["meta"]["note"]
    assert "no headings" in note and "300" in note


def test_markdown_header_no_note_when_headings_exist(tmp_path):
    ctx = _ctx(tmp_path)
    MarkdownHeaderChunker().apply(
        {"doc": _doc([("heading", "Intro", 1), ("paragraph", "two", 1)])},
        MarkdownHeaderConfig(),
        ctx,
    )
    assert "note" not in ctx.extras.get("meta", {})


def test_header_footer_strip_notes_a_single_page(tmp_path):
    ctx = _ctx(tmp_path)
    HeaderFooterStrip().apply(
        {"doc": _doc([("paragraph", "a", 1), ("paragraph", "b", 1)])},
        HeaderFooterStripConfig(),
        ctx,
    )
    assert "one page" in ctx.extras["meta"]["note"]


def test_header_footer_strip_notes_when_every_block_repeats(tmp_path):
    ctx = _ctx(tmp_path)
    HeaderFooterStrip().apply(
        {"doc": _doc([("paragraph", "ACME", 1), ("paragraph", "ACME", 2)])},
        HeaderFooterStripConfig(),
        ctx,
    )
    note = ctx.extras["meta"]["note"]
    assert "two pages" in note and "meets the ratio" not in note


def test_drop_matching_notes_a_pattern_that_matched_nothing(tmp_path):
    ctx = _ctx(tmp_path)
    DropMatching().apply(
        {"doc": _doc([("paragraph", "a", 1)])},
        DropMatchingConfig(pattern="zzz"),
        ctx,
    )
    assert "matched no block" in ctx.extras["meta"]["note"]

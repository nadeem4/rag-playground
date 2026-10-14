"""Names the CLI and the playground's teaching routes need, public."""

from __future__ import annotations

import pandion
from pandion import Pipeline


CONFIG = {
    "path": "./index",
    "index": {
        "parse": {"use": "docling"},
        "chunk": {"use": "recursive_character"},
        "embed": {"use": "qwen3-embedding-0.6b"},
        "store": {"use": "lancedb"},
    },
}


def test_a_pipeline_names_the_extras_its_steps_need(tmp_path):
    p = Pipeline.from_dict(CONFIG, base=tmp_path)
    assert p.extras() == ["docling", "lancedb", "local"]


def test_a_chat_answer_needs_its_providers_sdk(tmp_path):
    data = {
        **CONFIG,
        "retrieve": {"search": {"use": "dense"}},
        "answer": {"use": "chat", "model": "claude-haiku-4-5"},
    }
    assert "anthropic" in Pipeline.from_dict(data, base=tmp_path).extras()


def test_preload_parser_is_public_and_a_parser_with_nothing_to_load_is_quiet():
    assert "preload_parser" in pandion.__all__
    pandion.preload_parser("pdfium")


def test_an_unknown_parser_is_a_key_error_with_a_sentence():
    try:
        pandion.preload_parser("no_such_parser")
    except KeyError as exc:
        assert "no_such_parser" in str(exc)
    else:
        raise AssertionError("expected a KeyError")


def test_count_tokens_is_the_token_chunkers_counter():
    assert "count_tokens" in pandion.chunk.__all__
    assert pandion.chunk.count_tokens("one two three") == 3

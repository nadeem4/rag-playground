"""Every problem with a pipeline dict is a ConfigError with one plain sentence,
so a server can hand it back as it is (pandion-api's POST /pipelines/validate)."""

import pytest

import pandion
from pandion import ConfigError, Pipeline
from pdfs import SAMPLE_PAGES, build_pdf

BASE = {
    "path": "./index",
    "index": {
        "parse": {"use": "pdfium"},
        "chunk": {"use": "recursive_character"},
        "embed": {"use": "fake-deterministic"},
        "store": {"use": "lancedb"},
    },
}


def with_index(**changes):
    return {**BASE, "index": {**BASE["index"], **changes}}


def test_a_models_block_that_is_not_a_mapping_is_a_config_error():
    with pytest.raises(ConfigError) as info:
        Pipeline.from_dict({**BASE, "models": 3})
    assert str(info.value) == "models must be a mapping of settings."


def test_an_unknown_strategy_is_a_sentence_not_a_quoted_key():
    with pytest.raises(ConfigError) as info:
        Pipeline.from_dict(with_index(parse={"use": "nope"}))
    assert str(info.value).startswith("index.parse uses 'nope', which is not a parse strategy.")


def test_a_bad_value_is_one_line_naming_the_step_and_the_setting():
    with pytest.raises(ConfigError) as info:
        Pipeline.from_dict(with_index(chunk={"use": "recursive_character", "chunk_size": "big"}))
    message = str(info.value)
    assert message.startswith("index.chunk (recursive_character): chunk_size: Input should be a valid integer")
    assert message.endswith(".") and "\n" not in message and "validation error" not in message


def test_explain_gives_the_same_sentence():
    with pytest.raises(ConfigError) as info:
        pandion.explain("chunk", "recursive_character", {"chunk_size": "big"})
    assert str(info.value).startswith("chunk (recursive_character): chunk_size: Input should be a valid integer")


def test_a_stage_call_gives_the_sentence_as_a_value_error(tmp_path):
    pdf = tmp_path / "r.pdf"
    pdf.write_bytes(build_pdf(SAMPLE_PAGES))
    doc = pandion.parse(pdf, use="pdfium")
    with pytest.raises(ValueError, match="chunk_size: Input should be a valid integer") as info:
        pandion.chunk(doc, use="recursive_character", chunk_size="big")
    assert "\n" not in str(info.value)

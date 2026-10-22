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


def _steps_with(use):
    """The same bad `use` at each kind of step, with the rest of the pipeline sound."""
    search = {"search": {"use": "dense"}}
    return {
        "index.parse": with_index(parse={"use": use}),
        "index.store": with_index(store={"use": use}),
        "retrieve.search": {**BASE, "retrieve": {"search": {"use": use}}},
        "answer": {**BASE, "retrieve": search, "answer": {"use": use}},
    }


@pytest.mark.parametrize("use", [["a"], {"name": "a"}], ids=["list", "dict"])
@pytest.mark.parametrize("where", ["index.parse", "index.store", "retrieve.search", "answer"])
def test_a_use_that_is_not_a_name_is_a_config_error(use, where):
    with pytest.raises(ConfigError) as info:
        Pipeline.from_dict(_steps_with(use)[where])
    assert str(info.value) == f"{where} must say which strategy to use, as use: <name>."


def test_a_setting_name_that_is_not_text_is_a_config_error():
    with pytest.raises(ConfigError) as info:
        Pipeline.from_dict(with_index(chunk={"use": "recursive_character", 3: 1, "x": 2}))
    assert str(info.value) == "index.chunk has a setting whose name is not text: 3."


def test_a_models_setting_name_that_is_not_text_is_a_config_error():
    with pytest.raises(ConfigError) as info:
        Pipeline.from_dict({**BASE, "models": {3: "x"}})
    assert str(info.value) == "models has a setting whose name is not text: 3."


def test_a_bad_models_value_is_one_sentence():
    with pytest.raises(ConfigError) as info:
        Pipeline.from_dict({**BASE, "models": {"download": "sometimes"}})
    message = str(info.value)
    assert message.startswith("models: download: ")
    assert message.endswith(".") and not message.endswith("..") and "\n" not in message


# --------------------------------------------------------------------------
# Where a problem belongs, so a caller never has to read the sentence for it
# --------------------------------------------------------------------------


def _refusal(data):
    with pytest.raises(ConfigError) as info:
        Pipeline.from_dict(data)
    return info.value


@pytest.mark.parametrize(
    ("data", "step", "use"),
    [
        (with_index(chunk={"use": "recursive_character", "chunk_size": -3}), "index.chunk", "recursive_character"),
        (with_index(clean=[{"use": "dedupe_blocks"}, {"use": "drop_matching", "nope": 1}]), "index.clean.2", "drop_matching"),
        (with_index(parse={"use": "no-such-parser"}), "index.parse", "no-such-parser"),
        (with_index(parse={"pages": 3}), "index.parse", None),
        (with_index(embed={"use": "no-such-embedder"}), "index.embed", "no-such-embedder"),
        ({**BASE, "retrieve": {"search": {"use": "dense", "top_k": "x"}}}, "retrieve.search", "dense"),
        ({**BASE, "retrieve": {"search": {"use": "dense"}, "rerank": [{"use": "mmr"}, {"use": "mmr", "x": 1}]}}, "retrieve.rerank.2", "mmr"),
        ({**BASE, "retrieve": {"search": {"use": "dense"}}, "answer": {"use": "eval"}}, "answer", "eval"),
        ({**BASE, "retrieve": {"search": {"use": "dense"}, "rewrite": {"use": "prf", "text": "q"}}}, "retrieve.rewrite", None),
        ({**BASE, "retrieve": {"search": {"use": "dense"}, "rewrite": {"use": "prf", "filters": {}}}}, "retrieve.rewrite", None),
        (with_index(source={"use": "upload", "filename": "a.pdf"}), "index.source", "upload"),
        (with_index(store={"use": "no-such-store"}), "index.store", "no-such-store"),
        (with_index(store={"use": "lancedb", "embedder": "fake-deterministic"}), "index.store", "lancedb"),
        (with_index(store={"use": "lancedb", "nope": 1}), "index.store", "lancedb"),
    ],
)
def test_a_steps_problem_names_its_step_and_strategy(data, step, use):
    e = _refusal(data)
    assert (e.step, e.use) == (step, use)
    assert e.to_dict() == {"message": str(e), "step": step, "use": use, "settings": e.settings}


def test_each_refused_setting_comes_with_its_own_sentence():
    e = _refusal(with_index(chunk={"use": "recursive_character", "chunk_size": -3, "chunk_overlap": "x"}))
    assert {s["field"] for s in e.settings} == {"chunk_size", "chunk_overlap"}
    assert all(s["message"].endswith(".") and s["message"].rstrip(".") in str(e) for s in e.settings)


def test_a_problem_that_is_no_one_steps_names_none():
    e = _refusal(with_index(nope=1))
    assert (e.step, e.use, e.settings) == (None, None, [])
    e = _refusal({**BASE, "models": 3})
    assert e.to_dict() == {"message": "models must be a mapping of settings.", "step": None, "use": None, "settings": []}


def test_an_unknown_setting_names_the_step_but_no_setting():
    e = _refusal(with_index(chunk={"use": "recursive_character", "bogus": 1}))
    assert e.step == "index.chunk" and e.settings == []


def test_explain_says_which_settings_it_refused():
    with pytest.raises(ConfigError) as info:
        pandion.explain("chunk", "recursive_character", {"chunk_size": "x"})
    assert info.value.use == "recursive_character"
    assert [s["field"] for s in info.value.settings] == ["chunk_size"]


def test_place_turns_a_sentences_step_into_its_place_in_the_file():
    from pandion.config import place

    assert place("index.clean step 2") == "index.clean.2"
    assert place("retrieve.rerank") == "retrieve.rerank"
    assert place("answer") == "answer"
    assert place("index") is None and place("models") is None

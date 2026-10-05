"""Contract tests for the LLM rewrite of the question.

No test calls a model: `providers.llm.complete` is replaced by a fake that
records the prompt and returns whatever reply the test names.
"""

from __future__ import annotations

import pytest

from core.artifacts import ArtifactType
from core.payloads import Query
from core.ports import RunContext, Stage
from core.registry import registry
from plugins.query.llm_rewrite import (
    DOC_BUDGET,
    UNUSABLE_NOTE,
    LlmRewrite,
    LlmRewriteConfig,
)
from providers import llm
from providers.llm import CHAT_MODELS, Completion

QUESTION = "Who is my current employer?"
REWRITE = "current employer company present role"
CREDS = {"anthropic_api_key": "sk-ant-test", "openai_api_key": "sk-openai-test"}


class FakeComplete:
    def __init__(self, reply: str, stop_reason: str = "end_turn"):
        self.reply = reply
        self.stop_reason = stop_reason
        self.calls: list[dict] = []

    def __call__(self, model, **kwargs):
        self.calls.append({"model": model, **kwargs})
        return Completion(
            text=self.reply,
            usage={"input_tokens": 1, "output_tokens": 1},
            stop_reason=self.stop_reason,
        )


@pytest.fixture
def reply(monkeypatch):
    def install(text: str, stop_reason: str = "end_turn") -> FakeComplete:
        fake = FakeComplete(text, stop_reason)
        monkeypatch.setattr(llm, "complete", fake)
        return fake

    return install


def ctx(tmp_path, creds: dict | None = CREDS) -> RunContext:
    run_ctx = RunContext(output_dir=tmp_path, emit=lambda e: None, tmp=tmp_path)
    if creds is not None:
        run_ctx.extras["credentials"] = dict(creds)
    return run_ctx


def rewrite(tmp_path, *, doc=None, run_ctx=None, **config) -> tuple[Query, str | None]:
    run_ctx = run_ctx or ctx(tmp_path)
    inputs = {} if doc is None else {"doc": doc}
    out = LlmRewrite().apply(
        inputs, LlmRewriteConfig(**({"text": QUESTION} | config)), run_ctx
    )
    return Query.model_validate(out), run_ctx.extras.get("meta", {}).get("note")


def parsed_doc(text: str) -> dict:
    return {
        "doc_id": "doc-1",
        "elements": [{"id": "e1", "type": "paragraph", "text": text, "order": 0}],
    }


# -- declarations ---------------------------------------------------------------


def test_registered_under_the_query_stage():
    assert registry.get(Stage.QUERY, "llm_rewrite") is LlmRewrite
    assert LlmRewrite.output is ArtifactType.QUERY


def test_the_parsed_document_is_an_optional_ambient_input():
    port = LlmRewrite.inputs["doc"]
    assert port.type is ArtifactType.PARSED_DOC
    assert port.ambient and not port.required


def test_a_model_call_is_never_cached():
    assert LlmRewrite.cacheable is False


def test_model_choices_are_the_chat_step_models():
    schema = LlmRewriteConfig.model_json_schema()["properties"]
    assert set(schema["model"]["enum"]) == set(CHAT_MODELS)
    assert schema["style"]["enum"] == ["document words", "keywords"]
    assert LlmRewriteConfig().style == "document words"
    for field in ("text", "model", "style"):
        assert LlmRewriteConfig.model_fields[field].description


# -- the rewrite ------------------------------------------------------------------


def test_the_rewrite_becomes_the_text_and_the_question_is_kept(reply, tmp_path):
    reply(f"  {REWRITE}  ")
    query, note = rewrite(tmp_path, gold_answer="g")
    assert query.text == REWRITE
    assert query.original == QUESTION
    assert query.gold_answer == "g"
    assert note == f"Rewrote the question as: {REWRITE}."


@pytest.mark.parametrize("ending", [".", "?", "!"])
def test_the_note_does_not_double_the_rewrites_own_full_stop(reply, tmp_path, ending):
    reply(f"Where does the person work now{ending}")
    _, note = rewrite(tmp_path)
    assert note == f"Rewrote the question as: Where does the person work now{ending}"


def test_the_prompt_asks_for_one_line_in_the_documents_words(reply, tmp_path):
    fake = reply(REWRITE)
    rewrite(tmp_path)
    call = fake.calls[0]
    assert QUESTION in call["user"]
    assert "one line" in call["system"]
    assert "do not answer" in call["system"].lower()
    assert "words the document would use" in call["system"]
    assert call["api_key"] == "sk-ant-test"


@pytest.mark.parametrize("style", ["document words", "keywords"])
def test_the_prompt_prefers_section_and_date_words_and_never_a_name(reply, tmp_path, style):
    fake = reply(REWRITE)
    rewrite(tmp_path, style=style)
    system = fake.calls[0]["system"]
    assert "section and date words" in system
    assert "Experience, Present" in system
    assert "Never use a person's name." in system


def test_the_keywords_style_asks_for_six_to_ten_search_words(reply, tmp_path):
    fake = reply(REWRITE)
    rewrite(tmp_path, style="keywords")
    system = fake.calls[0]["system"]
    assert "six to ten search words" in system
    assert "words the document would use" not in system


def test_the_document_start_is_given_as_context_when_there_is_one(reply, tmp_path):
    fake = reply(REWRITE)
    rewrite(tmp_path, doc=parsed_doc("EXPERIENCE " + "x" * 3000))
    user = fake.calls[0]["user"]
    assert "EXPERIENCE" in user
    assert "x" * DOC_BUDGET not in user
    assert DOC_BUDGET == 1500


def test_without_a_document_there_is_no_context(reply, tmp_path):
    fake = reply(REWRITE)
    rewrite(tmp_path)
    assert "document begins" not in fake.calls[0]["user"].lower()


@pytest.mark.parametrize(
    "bad", ["", "   ", "x" * 301, "first line\nsecond line"], ids=["empty", "blank", "long", "newline"]
)
def test_an_unusable_reply_keeps_the_question(reply, tmp_path, bad):
    reply(bad)
    query, note = rewrite(tmp_path)
    assert query.text == QUESTION
    assert query.original == ""
    assert note == UNUSABLE_NOTE == (
        "The model gave no usable rewrite; the question was used as typed."
    )


def test_a_refusal_keeps_the_question(reply, tmp_path):
    reply(REWRITE, stop_reason="refusal")
    query, note = rewrite(tmp_path)
    assert query.text == QUESTION
    assert note == UNUSABLE_NOTE


def test_an_empty_question_makes_no_call(reply, tmp_path):
    fake = reply(REWRITE)
    query, _ = rewrite(tmp_path, text="  ")
    assert fake.calls == []
    assert query.text == "  " and query.original == ""


@pytest.mark.parametrize(
    ("model", "provider"),
    [("claude-haiku-4-5", "anthropic"), ("gpt-6-astra", "openai")],
)
def test_no_key_raises_the_chat_steps_sentence(reply, tmp_path, model, provider):
    fake = reply(REWRITE)
    with pytest.raises(ValueError) as err:
        rewrite(tmp_path, run_ctx=ctx(tmp_path, creds=None), model=model)
    assert str(err.value) == llm.no_key_message(provider)
    assert fake.calls == []


def test_a_custom_model_gets_its_base_url_and_name(reply, tmp_path):
    fake = reply(REWRITE)
    rewrite(
        tmp_path, run_ctx=ctx(tmp_path, creds=None), model="custom",
        custom_base_url=" http://localhost:11434/v1 ", custom_model=" llama3.3 ",
    )
    assert fake.calls[0]["base_url"] == "http://localhost:11434/v1"
    assert fake.calls[0]["model_name"] == "llama3.3"


def test_a_custom_model_without_url_and_name_is_refused(reply, tmp_path):
    reply(REWRITE)
    with pytest.raises(ValueError, match="base URL and a model name"):
        rewrite(tmp_path, run_ctx=ctx(tmp_path, creds=None), model="custom")


# -- explain ------------------------------------------------------------------------


def test_explain_names_model_and_style_and_keeps_the_question_for_the_answer():
    exp = LlmRewrite().explain(LlmRewriteConfig(text=QUESTION))
    text = exp.settings + " " + (exp.tradeoff or "")
    assert "model" in exp.settings and "style" in exp.settings
    assert "Claude Haiku 4.5" in exp.settings
    assert "original question still goes to the answer" in text
    keywords = LlmRewrite().explain(LlmRewriteConfig(text=QUESTION, style="keywords"))
    assert keywords.settings != exp.settings


def test_explain_warns_on_an_empty_question_and_blocks_an_incomplete_custom_endpoint():
    assert LlmRewrite().explain(LlmRewriteConfig()).warning
    exp = LlmRewrite().explain(LlmRewriteConfig(text=QUESTION, model="custom"))
    assert exp.blocking


def test_user_facing_text_has_no_long_dashes():
    exp = LlmRewrite().explain(LlmRewriteConfig(text=QUESTION))
    text = exp.settings + (exp.tradeoff or "") + LlmRewrite.summary + UNUSABLE_NOTE
    assert "\N{EM DASH}" not in text and "\N{EN DASH}" not in text

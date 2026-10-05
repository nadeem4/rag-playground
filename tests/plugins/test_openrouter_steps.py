"""OpenRouter in the three steps that call a chat model: chat, llm_rerank and
llm_rewrite. Each gets an `openrouter_model` field shown only for OpenRouter,
needs the OpenRouter key, and sends the typed model id. No test calls a model.
"""

from __future__ import annotations

import pytest

from plugins.query.llm_rewrite import LlmRewrite, LlmRewriteConfig
from plugins.rerank.llm_rerank import LlmRerank, LlmRerankConfig
from plugins.use_case.chat import ChatConfig, ChatUseCase
from providers import llm
from tests.plugins.test_rerank_llm import QUESTION, payload
from tests.plugins.test_rerank_llm import ctx as run_ctx
from tests.plugins.test_rerank_llm import reply  # noqa: F401  (fixture)
from tests.plugins.test_use_case_chat import pipeline  # noqa: F401  (fixture)
from tests.plugins.test_use_case_chat_any_model import (  # noqa: F401
    ask,
    context,
    index,
    openai_fake,
)

OR_KEY = "sk-or-test-SECRET-0123456789"
OR_CREDS = {"openrouter_api_key": OR_KEY}
MODEL_ID = "meta-llama/llama-3.3-70b-instruct"
SUGGESTIONS = (
    "anthropic/claude-sonnet-4",
    "openai/gpt-4o-mini",
    "meta-llama/llama-3.3-70b-instruct",
    "google/gemini-2.5-flash",
)

STEPS = [
    (ChatUseCase, ChatConfig, {}),
    (LlmRerank, LlmRerankConfig, {}),
    (LlmRewrite, LlmRewriteConfig, {"text": QUESTION}),
]
IDS = ["chat", "llm_rerank", "llm_rewrite"]


@pytest.mark.parametrize("cls,config_cls,base", STEPS, ids=IDS)
def test_the_model_id_field_shows_only_for_openrouter(cls, config_cls, base):
    props = config_cls.model_json_schema()["properties"]
    assert "openrouter" in props["model"]["enum"]
    assert props["model"]["x-labels"]["openrouter"] == "OpenRouter"
    field = props["openrouter_model"]
    assert field["x-show-when"] == {"model": "openrouter"}
    assert field["default"] == ""
    for suggestion in SUGGESTIONS:
        assert suggestion in field["description"]


@pytest.mark.parametrize("cls,config_cls,base", STEPS, ids=IDS)
def test_explain_blocks_openrouter_without_a_model_id(cls, config_cls, base):
    exp = cls().explain(config_cls(model="openrouter", **base))
    assert exp.blocking and "OpenRouter needs a model id" in exp.warning


@pytest.mark.parametrize("cls,config_cls,base", STEPS, ids=IDS)
def test_explain_names_the_model_id_and_the_key(cls, config_cls, base):
    exp = cls().explain(config_cls(model="openrouter", openrouter_model=MODEL_ID, **base))
    assert not exp.blocking
    assert MODEL_ID in exp.settings
    if cls is not LlmRewrite:  # the rewrite does not talk about keys
        assert "OPENROUTER_API_KEY" in exp.settings
    for text in (exp.settings, exp.tradeoff or ""):
        assert "—" not in text and "–" not in text


@pytest.mark.parametrize(
    "cls,old", [(ChatUseCase, "2"), (LlmRerank, "2"), (LlmRewrite, "1")], ids=IDS
)
def test_versions_are_bumped(cls, old):
    assert cls.version == str(int(old) + 1)


# --- llm_rerank -------------------------------------------------------------------


def test_rerank_sends_the_openrouter_key_and_model_id(reply, tmp_path):  # noqa: F811
    fake = reply("2, 1")
    LlmRerank().apply(
        {"result": payload(["a", "b"]), "query": {"text": QUESTION}},
        LlmRerankConfig(model="openrouter", openrouter_model=f" {MODEL_ID} "),
        run_ctx(tmp_path, creds=OR_CREDS),
    )
    [call] = fake.calls
    assert call["model"].provider == "openrouter"
    assert call["api_key"] == OR_KEY
    assert call["model_name"] == MODEL_ID
    assert call["base_url"] is None


def test_rerank_without_the_openrouter_key_names_it(reply, tmp_path):  # noqa: F811
    fake = reply("1")
    with pytest.raises(ValueError) as info:
        LlmRerank().apply(
            {"result": payload(["a", "b"]), "query": {"text": QUESTION}},
            LlmRerankConfig(model="openrouter", openrouter_model=MODEL_ID),
            run_ctx(tmp_path),  # Anthropic and OpenAI keys only
        )
    assert str(info.value) == llm.NO_KEY["openrouter"]
    assert fake.calls == []


# --- llm_rewrite ------------------------------------------------------------------


def test_rewrite_sends_the_openrouter_key_and_model_id(reply, tmp_path):  # noqa: F811
    fake = reply("employer company")
    LlmRewrite().apply(
        {},
        LlmRewriteConfig(text=QUESTION, model="openrouter", openrouter_model=MODEL_ID),
        run_ctx(tmp_path, creds=OR_CREDS),
    )
    [call] = fake.calls
    assert call["api_key"] == OR_KEY and call["model_name"] == MODEL_ID


def test_rewrite_without_the_openrouter_key_names_it(reply, tmp_path):  # noqa: F811
    reply("x")
    with pytest.raises(ValueError, match="OPENROUTER_API_KEY"):
        LlmRewrite().apply(
            {},
            LlmRewriteConfig(text=QUESTION, model="openrouter", openrouter_model=MODEL_ID),
            run_ctx(tmp_path),
        )


# --- chat -------------------------------------------------------------------------


def test_chat_on_openrouter_uses_sentence_ids_and_the_model_id(
    openai_fake, pipeline, index  # noqa: F811
):
    out = ask(
        pipeline, index=index, ctx=context(openrouter_api_key=OR_KEY),
        model="openrouter", openrouter_model=MODEL_ID,
    )
    assert openai_fake.built == [{"api_key": OR_KEY, "base_url": llm.OPENROUTER_BASE_URL}]
    assert openai_fake.client.requests[0]["model"] == MODEL_ID
    assert out.payload["provider"] == "openrouter"
    assert out.payload["model"] == MODEL_ID
    assert out.payload["citation_method"] == "sentence_ids"


def test_chat_on_openrouter_without_its_key_names_it(openai_fake, pipeline, index):  # noqa: F811
    with pytest.raises(ValueError, match="OPENROUTER_API_KEY"):
        ask(pipeline, index=index, model="openrouter", openrouter_model=MODEL_ID)
    assert openai_fake.built == []

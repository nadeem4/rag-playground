"""I-16: the chat model registry and `complete()`, against fake clients only.

The root conftest refuses to build a real client, so a test here that forgets to
patch a factory fails instead of reaching the network.
"""

from __future__ import annotations

import traceback
from types import SimpleNamespace

import pytest

from providers import llm
from providers.llm import CHAT_MODELS, ChatModel, Completion, complete

KEY = "sk-test-SECRET-0123456789"


# --- the registry -------------------------------------------------------------


def test_registry_entries_and_providers():
    assert list(CHAT_MODELS) == [
        "claude-opus-5",
        "claude-sonnet-5",
        "claude-haiku-4-5",
        "gpt-6-astra",
        "gpt-5.6-sol",
        "gpt-5.6-luna",
        "custom",
    ]
    providers = {m.id: m.provider for m in CHAT_MODELS.values()}
    assert providers["claude-opus-5"] == "anthropic"
    assert providers["gpt-6-astra"] == "openai"
    assert providers["custom"] == "openai_compatible"
    for model_id, model in CHAT_MODELS.items():
        assert isinstance(model, ChatModel) and model.id == model_id and model.label
        assert model.native_citations is (model.provider == "anthropic")


# --- fakes --------------------------------------------------------------------


def openai_reply(text="An answer [1.1].", finish="stop", refusal=None):
    return SimpleNamespace(
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(content=text, refusal=refusal),
                finish_reason=finish,
            )
        ],
        usage=SimpleNamespace(prompt_tokens=120, completion_tokens=30),
    )


class FakeOpenAI:
    def __init__(self, reply=None, error=None):
        self.requests: list[dict] = []
        self._reply = reply or openai_reply()
        self._error = error
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        self.requests.append(kwargs)
        if self._error is not None:
            raise self._error
        return self._reply


@pytest.fixture
def fake_openai(monkeypatch):
    holder = SimpleNamespace(client=None, reply=None, error=None, built=[])

    def make(api_key, base_url=None):
        holder.built.append({"api_key": api_key, "base_url": base_url})
        holder.client = FakeOpenAI(holder.reply, holder.error)
        return holder.client

    monkeypatch.setattr(llm, "make_openai_client", make)
    return holder


class FakeAnthropic:
    def __init__(self, reply, error=None):
        self.requests: list[dict] = []
        self._reply, self._error = reply, error
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        self.requests.append(kwargs)
        if self._error is not None:
            raise self._error
        return self._reply


def anthropic_reply(*texts, stop_reason="end_turn"):
    return SimpleNamespace(
        content=[SimpleNamespace(type="thinking", thinking="", signature="s")]
        + [SimpleNamespace(type="text", text=t, citations=None) for t in texts],
        stop_reason=stop_reason,
        usage=SimpleNamespace(input_tokens=200, output_tokens=40),
    )


@pytest.fixture
def fake_anthropic(monkeypatch):
    holder = SimpleNamespace(client=None, reply=anthropic_reply("ok"), error=None, keys=[])

    def make(api_key):
        holder.keys.append(api_key)
        holder.client = FakeAnthropic(holder.reply, holder.error)
        return holder.client

    monkeypatch.setattr(llm, "make_anthropic_client", make)
    return holder


# --- OpenAI -------------------------------------------------------------------


def test_openai_uses_chat_completions(fake_openai):
    out = complete(CHAT_MODELS["gpt-6-astra"], system="SYS", user="USER", api_key=KEY)
    assert out == Completion(
        text="An answer [1.1].",
        usage={"input_tokens": 120, "output_tokens": 30},
        stop_reason="stop",
    )
    assert fake_openai.built == [{"api_key": KEY, "base_url": None}]
    [req] = fake_openai.client.requests
    assert req["model"] == "gpt-6-astra"
    assert req["messages"] == [
        {"role": "system", "content": "SYS"},
        {"role": "user", "content": "USER"},
    ]
    assert req["max_completion_tokens"] == 2048
    assert "max_tokens" not in req


def test_openai_requires_a_key(fake_openai):
    with pytest.raises(ValueError, match="OPENAI_API_KEY"):
        complete(CHAT_MODELS["gpt-5.6-sol"], system="s", user="u", api_key=None)
    assert fake_openai.built == []


def test_openai_refusal_is_reported_as_text(fake_openai):
    fake_openai.reply = openai_reply(text=None, refusal="I can't help with that.")
    out = complete(CHAT_MODELS["gpt-6-astra"], system="s", user="u", api_key=KEY)
    assert out.stop_reason == "refusal"
    assert out.text == "I can't help with that."


def test_missing_usage_counts_as_zero(fake_openai):
    reply = openai_reply()
    reply.usage = None
    fake_openai.reply = reply
    out = complete(CHAT_MODELS["gpt-6-astra"], system="s", user="u", api_key=KEY)
    assert out.usage == {"input_tokens": 0, "output_tokens": 0}


# --- OpenAI-compatible --------------------------------------------------------


def test_compatible_passes_base_url_and_model_name(fake_openai):
    complete(
        CHAT_MODELS["custom"],
        system="s",
        user="u",
        api_key=KEY,
        base_url="http://localhost:11434/v1",
        model_name="llama3.3",
        max_tokens=512,
    )
    assert fake_openai.built == [{"api_key": KEY, "base_url": "http://localhost:11434/v1"}]
    [req] = fake_openai.client.requests
    assert req["model"] == "llama3.3"
    # Local servers know max_tokens; not every one knows max_completion_tokens.
    assert req["max_tokens"] == 512 and "max_completion_tokens" not in req


def test_compatible_without_a_key_never_falls_back_to_the_openai_env_key(
    fake_openai, monkeypatch
):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openai-ENV-must-not-travel")
    complete(
        CHAT_MODELS["custom"], system="s", user="u", api_key=None,
        base_url="http://localhost:8000/v1", model_name="m",
    )
    [built] = fake_openai.built
    assert built["api_key"] and "must-not-travel" not in built["api_key"]


@pytest.mark.parametrize("base_url,model_name", [("", "m"), ("http://x/v1", ""), (None, None)])
def test_compatible_needs_a_base_url_and_a_model_name(fake_openai, base_url, model_name):
    with pytest.raises(ValueError):
        complete(
            CHAT_MODELS["custom"], system="s", user="u", api_key=None,
            base_url=base_url, model_name=model_name,
        )
    assert fake_openai.built == []


def test_the_real_factory_does_not_read_the_openai_env_key(monkeypatch):
    """`openai.OpenAI(api_key=None)` would read OPENAI_API_KEY and send it to a
    visitor-chosen URL. The factory must always pass an explicit key."""
    import openai

    monkeypatch.setenv("OPENAI_API_KEY", "sk-openai-ENV-must-not-travel")
    kwargs = llm.openai_client_kwargs(None, "http://localhost:1/v1")
    assert kwargs["api_key"] and "must-not-travel" not in kwargs["api_key"]
    # Building the client makes no request, so the real constructor is safe here.
    client = openai.OpenAI(**kwargs)
    assert client.api_key == kwargs["api_key"]
    assert str(client.base_url).startswith("http://localhost:1/v1")


# --- errors -------------------------------------------------------------------


def _openai_errors():
    import httpx2
    import openai

    request = httpx2.Request("POST", "https://api.openai.com/v1/chat/completions")

    def status(cls, code):
        return cls(
            f"bad key {KEY}",
            response=httpx2.Response(code, request=request),
            body={"error": {"message": f"echo {KEY}"}},
        )

    return [
        status(openai.AuthenticationError, 401),
        status(openai.PermissionDeniedError, 403),
        status(openai.NotFoundError, 404),
        status(openai.RateLimitError, 429),
        status(openai.BadRequestError, 400),
        status(openai.InternalServerError, 500),
        openai.APIConnectionError(message=f"conn {KEY}", request=request),
    ]


@pytest.mark.parametrize("error", _openai_errors(), ids=lambda e: type(e).__name__)
def test_openai_errors_are_readable_and_never_carry_the_key(fake_openai, error):
    fake_openai.error = error
    with pytest.raises(RuntimeError) as info:
        complete(CHAT_MODELS["gpt-6-astra"], system="s", user="u", api_key=KEY)
    exc = info.value
    assert KEY not in str(exc) and str(exc)
    assert exc.__cause__ is None and exc.__suppress_context__
    assert KEY not in "".join(traceback.format_exception(exc))


def test_compatible_error_names_the_endpoint(fake_openai):
    import httpx2
    import openai

    fake_openai.error = openai.APIConnectionError(
        message="refused", request=httpx2.Request("POST", "http://localhost:1/v1")
    )
    with pytest.raises(RuntimeError, match="endpoint"):
        complete(
            CHAT_MODELS["custom"], system="s", user="u", api_key=None,
            base_url="http://localhost:1/v1", model_name="m",
        )


# --- Anthropic ----------------------------------------------------------------


def test_anthropic_plain_completion(fake_anthropic):
    fake_anthropic.reply = anthropic_reply("First [1.1]. ", "Second [2.1].")
    out = complete(
        CHAT_MODELS["claude-opus-5"], system="SYS", user="USER", api_key=KEY,
        max_tokens=16000,
    )
    assert out.text == "First [1.1]. Second [2.1]."
    assert out.usage == {"input_tokens": 200, "output_tokens": 40}
    assert out.stop_reason == "end_turn"
    assert fake_anthropic.keys == [KEY]
    [req] = fake_anthropic.client.requests
    assert req["model"] == "claude-opus-5"
    assert req["system"] == "SYS"
    assert req["messages"] == [{"role": "user", "content": "USER"}]
    assert req["max_tokens"] == 16000
    # The same model settings as the native path.
    assert req["thinking"] == {"type": "adaptive"}
    assert req["fallbacks"] == "default"


def test_anthropic_haiku_gets_no_adaptive_thinking(fake_anthropic):
    complete(CHAT_MODELS["claude-haiku-4-5"], system="s", user="u", api_key=KEY)
    [req] = fake_anthropic.client.requests
    assert "thinking" not in req and "fallbacks" not in req


def test_anthropic_requires_a_key(fake_anthropic):
    with pytest.raises(ValueError, match="ANTHROPIC_API_KEY"):
        complete(CHAT_MODELS["claude-opus-5"], system="s", user="u", api_key="")
    assert fake_anthropic.keys == []


def test_anthropic_errors_are_redacted(fake_anthropic):
    import anthropic
    import httpx2

    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    fake_anthropic.error = anthropic.AuthenticationError(
        f"bad {KEY}", response=httpx2.Response(401, request=request), body=None
    )
    with pytest.raises(RuntimeError) as info:
        complete(CHAT_MODELS["claude-opus-5"], system="s", user="u", api_key=KEY)
    assert KEY not in "".join(traceback.format_exception(info.value))


def test_importing_the_module_does_not_import_either_sdk():
    import subprocess
    import sys
    from pathlib import Path

    code = (
        "import sys\n"
        "import providers.llm\n"
        "leaked = sorted(m for m in sys.modules if m.split('.')[0] in ('openai', 'anthropic'))\n"
        "print(leaked)\n"
        "sys.exit(1 if leaked else 0)\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=Path(__file__).resolve().parents[2],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr

"""Chat models: which ones the playground offers, and one call to ask any of them.

`CHAT_MODELS` is the registry the chat node's `model` setting is built from.
`complete()` sends one system prompt and one user message and returns the text,
for any provider:

- `anthropic`: the Anthropic SDK, `client.beta.messages.create`, with the same
  per-model settings as the native citations path (adaptive thinking on the
  models that have it, server-side fallbacks on Opus 5).
- `openai`: the OpenAI SDK, Chat Completions (`client.chat.completions.create`),
  with `max_completion_tokens`, which OpenAI's reasoning models require.
- `openai_compatible`: the same SDK and call against a `base_url` the user
  names, with `model_name` as the model id and `max_tokens`, which local
  servers such as Ollama, vLLM and LM Studio understand.

Native Claude citations need document blocks, so that path stays in the chat
plugin. `complete()` serves the sentence-id path, which works with any model.

**Keys.** A key is handed to its client factory and to nothing else. Every SDK
error is re-raised as a fresh `RuntimeError` with the key scrubbed and the
original chain dropped (`from None`), because the SDK exception holds the
request and the request holds the key. A custom endpoint with no key gets a
placeholder, never `None`: the OpenAI SDK would otherwise read
`OPENAI_API_KEY` from the environment and send it to the custom URL.

Both SDKs are imported lazily, inside the factories and the calls, so importing
this module (every API start, every test run) costs nothing. Tests patch
`make_anthropic_client` and `make_openai_client`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

Provider = Literal["anthropic", "openai", "openai_compatible"]


@dataclass(frozen=True)
class ChatModel:
    id: str  # the config value, e.g. "gpt-6-astra"
    provider: Provider
    label: str  # "Claude Opus 5"
    native_citations: bool  # True only for anthropic


CHAT_MODELS: dict[str, ChatModel] = {
    m.id: m
    for m in (
        ChatModel("claude-opus-5", "anthropic", "Claude Opus 5", True),
        ChatModel("claude-sonnet-5", "anthropic", "Claude Sonnet 5", True),
        ChatModel("claude-haiku-4-5", "anthropic", "Claude Haiku 4.5", True),
        ChatModel("gpt-6-astra", "openai", "GPT-6 Astra", False),
        ChatModel("gpt-5.6-sol", "openai", "GPT-5.6 Sol", False),
        ChatModel("gpt-5.6-luna", "openai", "GPT-5.6 Luna", False),
        ChatModel("custom", "openai_compatible", "Custom (OpenAI-compatible)", False),
    )
}


@dataclass
class Completion:
    text: str
    usage: dict[str, int]  # {"input_tokens", "output_tokens"}
    stop_reason: str


NO_KEY: dict[str, str] = {
    "anthropic": (
        "No Anthropic API key. Add one in the UI (API key, top right) "
        "or put ANTHROPIC_API_KEY in .env."
    ),
    "openai": (
        "No OpenAI API key. Add one in the UI (API key, top right) "
        "or put OPENAI_API_KEY in .env."
    ),
}

#: Sent as the key to a custom endpoint that needs none. Local servers ignore it.
NO_KEY_PLACEHOLDER = "not-needed"

#: Models the claude-api skill documents server-side fallbacks for.
ANTHROPIC_FALLBACKS: dict[str, dict[str, Any]] = {
    "claude-opus-5": {
        "betas": ["server-side-fallback-2026-07-01"],
        "fallbacks": "default",
    },
}

#: Haiku 4.5 predates adaptive thinking (it takes `budget_tokens`).
ADAPTIVE_THINKING = {"claude-opus-5", "claude-sonnet-5"}


def make_anthropic_client(api_key: str) -> Any:
    """The one place a real Anthropic client is built. Tests patch this."""
    import anthropic

    return anthropic.Anthropic(api_key=api_key)


def openai_client_kwargs(api_key: str | None, base_url: str | None) -> dict[str, Any]:
    """Always an explicit key, so the SDK never falls back to the environment."""
    kwargs: dict[str, Any] = {"api_key": api_key or NO_KEY_PLACEHOLDER}
    if base_url:
        kwargs["base_url"] = base_url
    return kwargs


def make_openai_client(api_key: str | None, base_url: str | None = None) -> Any:
    """The one place a real OpenAI client is built. Tests patch this."""
    import openai

    return openai.OpenAI(**openai_client_kwargs(api_key, base_url))


def anthropic_request_extras(model_id: str) -> dict[str, Any]:
    """Per-model request settings shared by the native and sentence-id paths."""
    extras: dict[str, Any] = dict(ANTHROPIC_FALLBACKS.get(model_id, {}))
    if model_id in ADAPTIVE_THINKING:
        extras["thinking"] = {"type": "adaptive"}
    return extras


def complete(
    model: ChatModel,
    *,
    system: str,
    user: str,
    api_key: str | None,
    base_url: str | None = None,
    model_name: str | None = None,
    max_tokens: int = 2048,
) -> Completion:
    """One answer from any registered model. Raises a readable error, key-free."""
    if model.provider == "anthropic":
        if not api_key:
            raise ValueError(NO_KEY["anthropic"])
        request = {
            "model": model.id,
            "max_tokens": max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": user}],
            **anthropic_request_extras(model.id),
        }
        response = call_anthropic(make_anthropic_client(api_key), request, api_key)
        return Completion(
            text="".join(b.text for b in response.content if b.type == "text"),
            usage={
                "input_tokens": response.usage.input_tokens,
                "output_tokens": response.usage.output_tokens,
            },
            stop_reason=response.stop_reason,
        )

    request: dict[str, Any] = {
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    if model.provider == "openai":
        if not api_key:
            raise ValueError(NO_KEY["openai"])
        request["model"] = model.id
        request["max_completion_tokens"] = max_tokens
        client = make_openai_client(api_key)
        where = "OpenAI"
    else:
        if not base_url or not model_name:
            raise ValueError(
                "A custom endpoint needs both a base URL and a model name."
            )
        request["model"] = model_name
        request["max_tokens"] = max_tokens
        client = make_openai_client(api_key or NO_KEY_PLACEHOLDER, base_url)
        where = f"the custom endpoint at {base_url}"

    response = _call_openai(client, request, api_key, where)
    choice = response.choices[0]
    message = choice.message
    usage = response.usage
    refusal = getattr(message, "refusal", None)
    return Completion(
        text=refusal if refusal else (message.content or ""),
        usage={
            "input_tokens": usage.prompt_tokens if usage else 0,
            "output_tokens": usage.completion_tokens if usage else 0,
        },
        stop_reason="refusal" if refusal else (choice.finish_reason or "stop"),
    )


def _scrub(message: str, api_key: str | None) -> RuntimeError:
    return RuntimeError(message.replace(api_key, "[redacted]") if api_key else message)


def call_anthropic(client: Any, request: dict[str, Any], api_key: str) -> Any:
    """Send a Messages request; turn SDK errors into readable, key-free messages.

    Most specific first, as the claude-api skill prescribes.
    """
    import anthropic

    def fail(message: str) -> RuntimeError:
        return _scrub(message, api_key)

    try:
        return client.beta.messages.create(**request)
    except anthropic.AuthenticationError:
        raise fail("Anthropic rejected the API key (401). Check the key.") from None
    except anthropic.PermissionDeniedError:
        raise fail("The API key may not use this model (403).") from None
    except anthropic.NotFoundError:
        raise fail(f"Model {request['model']} was not found (404).") from None
    except anthropic.RateLimitError:
        raise fail("Rate limited by the Anthropic API (429). Retry shortly.") from None
    except anthropic.BadRequestError as e:
        raise fail(f"The Anthropic API rejected the request (400): {e.message}") from None
    except anthropic.APIStatusError as e:
        raise fail(f"Anthropic API error ({e.status_code}): {e.message}") from None
    except anthropic.APIConnectionError:
        raise fail("Could not reach the Anthropic API. Check the network.") from None


def _call_openai(
    client: Any, request: dict[str, Any], api_key: str | None, where: str
) -> Any:
    """Chat Completions, with the same error rules as `call_anthropic`."""
    import openai

    def fail(message: str) -> RuntimeError:
        return _scrub(message[0].upper() + message[1:], api_key)

    try:
        return client.chat.completions.create(**request)
    except openai.AuthenticationError:
        raise fail(f"{where} rejected the API key (401). Check the key.") from None
    except openai.PermissionDeniedError:
        raise fail(f"The API key may not use this model at {where} (403).") from None
    except openai.NotFoundError:
        raise fail(f"Model {request['model']} was not found at {where} (404).") from None
    except openai.RateLimitError:
        raise fail(f"Rate limited by {where} (429). Retry shortly.") from None
    except openai.BadRequestError as e:
        raise fail(f"{where} rejected the request (400): {e.message}") from None
    except openai.APIStatusError as e:
        raise fail(f"Error from {where} ({e.status_code}): {e.message}") from None
    except openai.APIConnectionError:
        raise fail(f"Could not reach {where}. Check the network or the server.") from None

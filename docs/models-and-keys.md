# Models and keys

RAG Playground runs its own models on the CPU and calls a chat model only when you ask it
to. This page lists the models it downloads, the chat providers it can call, and what
happens to an API key.

## Contents

- [Models the app downloads](#models-the-app-downloads)
- [Chat providers](#chat-providers)
- [Which features need a key](#which-features-need-a-key)
- [Adding a key](#adding-a-key)
- [What happens to a key](#what-happens-to-a-key)
- [Checking a key](#checking-a-key)

## Models the app downloads

Everything runs on the CPU. Models download from Hugging Face into the Hugging Face cache
(`~/.cache/huggingface`, or wherever `HF_HOME` points) the first time they are used, so
the first run of a step is slow and later runs are fast.

| Model | Used by | Download | Notes |
|---|---|---|---|
| Docling layout models | Docling parser | about 0.5 GB | |
| RapidOCR | Docling parser with `do_ocr` on | none | Its ONNX checkpoints ship inside the `rapidocr` package, so OCR downloads nothing. Several seconds per page. |
| `Qwen/Qwen3-Embedding-0.6B` | Index, the default embedder | about 1.2 GB | 1024 dimensions. Supports Matryoshka truncation through `truncate_dim`. |
| `BAAI/bge-small-en-v1.5` | Index, the baseline embedder | about 130 MB | 384 dimensions, no truncation. |
| `cross-encoder/ms-marco-MiniLM-L-6-v2` | Cross-encoder reranker, the default | | Small and fast. |
| `BAAI/bge-reranker-base` | Cross-encoder reranker | | Stronger. |
| `BAAI/bge-reranker-v2-m3` | Cross-encoder reranker | | Strongest, and slow on a CPU. |
| `fake-deterministic` | Tests | none | A hashing embedder with no download. |

Both real embedders are pinned to a Hugging Face commit. Embeddings are cached at full
width, so indexing the same pieces again, or trying several `truncate_dim` values, embeds
each piece once.

When a sample opens, the server starts loading Docling, the Qwen3 embedder and the default
cross-encoder in the background, so they are likely ready by the time you press Run.

## Chat providers

Three steps call a chat model: the chat answer (`chat`), the LLM reranker (`llm_rerank`)
and the LLM rewrite (`llm_rewrite`). Each has the same choice of model.

| Provider | Models | Key |
|---|---|---|
| Anthropic | Claude Opus 5, Claude Sonnet 5, Claude Haiku 4.5 | `ANTHROPIC_API_KEY` |
| OpenAI | GPT-6 Astra, GPT-5.6 Sol, GPT-5.6 Luna | `OPENAI_API_KEY` |
| OpenRouter | Any model OpenRouter serves. Choose OpenRouter, then type its model id in `openrouter_model`, for example `anthropic/claude-sonnet-4`, `openai/gpt-4o-mini`, `meta-llama/llama-3.3-70b-instruct` or `google/gemini-2.5-flash`. | `OPENROUTER_API_KEY` |
| Custom (OpenAI-compatible) | Any model on an OpenAI-compatible server. Set `custom_base_url` and `custom_model` on the step. | `OPENAI_COMPATIBLE_API_KEY`, optional |

The chat answer uses Claude Opus 5 by default; the LLM reranker and the LLM rewrite use
Claude Haiku 4.5.

- **OpenRouter** is called at its fixed address, `https://openrouter.ai/api/v1`, which you
  never type. Every request carries OpenRouter's optional app attribution headers
  (`HTTP-Referer` and `X-Title: RAG Playground`). Because its address is fixed, it is not a
  custom endpoint, and it works on the demo with your own key.
- **A custom endpoint** can be a local server such as Ollama (`http://localhost:11434/v1`),
  vLLM or LM Studio, and usually needs no key. Custom endpoints work only when you run the
  app yourself with demo mode off. On the demo, Custom is left out of every model choice and
  the key panel, and the server refuses a run that uses one.
- An endpoint other than OpenAI's never gets the `OpenAI-Organization` or
  `OpenAI-Project` header, even when `OPENAI_ORG_ID` or `OPENAI_PROJECT_ID` is set.

## Which features need a key

Only three things need a key, and only for the provider of the model they use:

- the chat answer;
- the LLM reranker;
- the LLM rewrite.

Everything else works without one: parsing, cleaning, chunking, indexing, every search,
PRF, the cross-encoder and MMR rerankers, the search answer and Evaluate.

A missing key fails the step with a message that names the provider, for example "No
Anthropic API key. Add one with the key button at the top right." A custom endpoint runs
without a key.

## Adding a key

The server looks for each provider's key in three places and uses the first it finds:

1. **Typed in the app.** Open the key button at the top right of the header. It reads
   **Key** until a key is set, then **API key**. The panel has one row per provider:
   Anthropic, OpenAI, Custom endpoint and OpenRouter (the demo leaves out Custom endpoint).
   Paste a key into its row and choose **Apply**.
2. **The provider's environment variable in the server process,** for example:

   ```bash
   ANTHROPIC_API_KEY=sk-ant-... uv run rag-playground            # bash
   $env:ANTHROPIC_API_KEY="sk-ant-..."; uv run rag-playground    # PowerShell, this window only
   ```

3. **A `.env` file** at the repo root. Copy `.env.example` to `.env` and fill in the keys
   you need. `.env` is gitignored. The server reads it without adding it to its own
   environment, so programs it starts do not inherit the keys.

In demo mode only the first counts: the server ignores its own environment and `.env`, so
visitors can never spend the host's keys. See [deploy.md](deploy.md#demo-mode).

Do not set a key as a system-wide or user-wide environment variable. Every program you
start would inherit it, including AI coding tools that could then read and use it.

## What happens to a key

A key you type stays in that browser tab's memory. It is never saved to the browser's
storage, a cookie, the URL, a saved pipeline or an exported file. Reloading or closing the
tab clears it, and nothing brings it back.

The app sends it as a request header (`X-Anthropic-Api-Key`, `X-OpenAI-Api-Key`,
`X-OpenRouter-Api-Key` or `X-Custom-Api-Key`) with each run, each Compare run and each key
check, and with nothing else.

The server uses a key only for the run that sent it. It never stores, logs or returns a
key, and it puts `[redacted]` in its place in any error a run reports.

Two honest limits:

- While the tab is open the key is in the browser's memory, so anything that can reach
  that page can read it: a browser extension you installed, the React developer tools, or
  a person at your keyboard. That is true of any web app you paste a key into.
- A key in `.env` is on disk, because you put it there. Only you can take it off disk
  again, by deleting the file.

When you use one of the three steps that need a key, the text it needs goes to the
provider you chose: the question and the retrieved pieces for the chat answer and the LLM
reranker, and the question and the start of the document for the LLM rewrite.

## Checking a key

The Anthropic, OpenAI and OpenRouter rows of the key panel have **Check key**, which tests
the key without spending tokens: with a model listing, or for OpenRouter with its key
endpoint. A custom endpoint's key is checked when a step runs against it.

The API behind it:

- `GET /api/settings/llm` reports only which source the server itself has for each
  provider, as `env`, `dotenv` or `none`. In demo mode it is always `none`.
- `POST /api/settings/llm/check` with `{"provider": "anthropic"}` (or `openai`, `custom`
  or `openrouter`) tests one key. A custom check also needs `"base_url"`, and is refused
  on the demo.

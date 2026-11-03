# Install, models and extras

How to install Pandion, which extras a pipeline needs, and how models are found.

[Manual index](index.md) | Previous: [index](index.md) | Next: [stages](stages.md)

## Install

Pandion is [on PyPI](https://pypi.org/project/pandion/). It needs Python 3.13.

```bash
pip install "pandion[pdfium,lancedb,local]"
```

To try the examples in this guide, which use the bundled sample PDFs, clone the repo too:
`git clone https://github.com/nadeem4/rag-playground.git`.

The base install is small. Each parser, store and model library is an extra:

| Extra | What it brings | Needed by |
|---|---|---|
| `pdfium` | pypdfium2 | the `pdfium` parser |
| `docling` | Docling and its OCR engine | the `docling` parser |
| `local` | sentence-transformers and torch | the `qwen3-embedding-0.6b` and `bge-small-en-v1.5` embedders, and the `mmr` and `cross_encoder` rerankers |
| `lancedb` | LanceDB and pyarrow | the `lancedb` index and the `dense`, `bm25` and `hybrid_rrf` retrievers |
| `qdrant` | qdrant-client | the `qdrant` index: Qdrant in a folder or on a server |
| `anthropic` | the Anthropic SDK | `llm_context`, `llm_rewrite`, `llm_rerank` and `chat` with a Claude model |
| `openai` | the OpenAI SDK | `llm_context`, `llm_rewrite`, `llm_rerank` and `chat` with an OpenAI model, OpenRouter or a custom endpoint |

The cleaners, the chunkers, the `text` query step and the `search` answer step need only the base install. The `fake-deterministic`
embedder needs no extra and no download, so it is good for trying things out.

Inside the repo, `uv sync --extra dev` installs the package with the extras the app
uses, and `uv run` then finds it.

## Models

The local embedders (`qwen3-embedding-0.6b` and `bge-small-en-v1.5`) and the
`cross_encoder` reranker use a model from Hugging Face. `models.download` decides what happens when it is not on disk yet.

- `auto` downloads the model the first time it is used.
- `never` only loads a model that is already in the folder. If it is missing, the run
  stops with an error that names the model and the folder. Use this on a server with no
  network. Download the model once with `auto`, or copy it into the folder.

`models.cache_dir` is the folder models are kept in. When it is empty, the Hugging Face
default is used, and the `HF_HOME` variable moves that. `models.device` picks where a
model runs: `auto` tries cuda, then mps, then cpu.

`models.public_endpoints_only` is for a server that strangers share. When it is true, a
step that calls a custom OpenAI-compatible endpoint accepts only a public https address
and follows no redirects, so a visitor cannot make the server call an address on its own
network. It also guards a URL given as a document (see
[A URL as a document](stages.md#a-url-as-a-document)). It changes no result.

To download every model a pipeline file needs ahead of time, for example in a Dockerfile, run
`pandion models pull pipeline.yaml` (add `--cache-dir DIR` to choose the folder). Then set
`models.download: never` and point `models.cache_dir` at the same folder, so the server
never needs the network for a model. A pull fetches the whole model repository.

Docling is the exception: it does not use `models.cache_dir` or `download: never`. It keeps
its models under `HF_HOME` and fetches them again if they are missing. Set the same `HF_HOME`
(for example `/models/hf`) when you run `pandion models pull` and when you run the server.
From Python, `pandion.pull_models(pipeline, cache_dir=None)` does the same and returns the models it fetched.

To load the default embedder before the first run, so that run does not wait, call
`pandion.preload_embedder("qwen3-embedding-0.6b")`. It takes the same settings as
`pandion.ModelSettings(download=..., device=..., cache_dir=...)`.

## Install what a file needs

Nothing is ever installed while a pipeline runs. To install the extras a pipeline file
needs, run:

```bash
pandion install pipeline.yaml
```

It reads the file, works out the extras its steps use, and runs `pip install` for them
in the Python that runs it. With `--print`, it only prints the command:

```bash
pandion install pipeline.yaml --print
```

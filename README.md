# RAG Playground

A local-first bench for learning and demonstrating RAG by experiment. Every stage of a RAG
pipeline — parsing, cleaning, chunking, indexing, retrieval, reranking, and the end use
case — is a swappable plugin that can be run and inspected **on its own**, or chained into
a full pipeline.

Not a production RAG service. No auth, no multi-tenancy, no scale story.

## The model

Two nouns. There is no `Pipeline` class.

- **Artifact** — an immutable value identified by a *recipe hash* of
  `(transform, version, model fingerprint, output type, config, port-keyed inputs)`.
- **Transform** — maps typed input ports to one output artifact.

A saved pipeline is a DAG of transform nodes. Because artifact IDs are content-addressed,
running three chunkers against one parse is automatically three cache misses downstream of
one cache hit upstream — you never re-parse a PDF to try a different chunker.

## Stages

```
source → parse → clean* → chunk → enrich* → index → retrieve → rerank* → use_case
                                                        ↑
                     query → query_transform* ──────────┘
```

`*` = stackable: input type equals output type, so the stage may repeat.

## Status

Phases 1 (engine) and 2 (plugins) are complete. Phase 3 (API and web UI) is in progress: the
API is done. See the Notion board for delivery and issue tracking.

## Run it

```bash
uv sync
uv run rag-playground
```

This starts the server on http://127.0.0.1:8000 and opens your browser. Flags: `--port`,
`--no-browser`, and `--reload` for development. The API lives under `/api`; the web UI is
served from `web/dist`, so build it once with `npm install && npm run build` in `web/`.

Uploads go to `sources/` and cached artifacts to `artifacts/` at the repo root. Set
`RAG_PLAYGROUND_SOURCES` or `RAG_PLAYGROUND_ARTIFACTS` to put them elsewhere.

### Parsers

`docling` is the recommended parser; `pdfium` is the fast baseline. Both read the PDF's text
through pypdfium2, and Docling adds a vision layout model that finds headings, list items,
tables and page furniture and fixes reading order. It runs on CPU (torch is the CPU build).

The first Docling run downloads its models from Hugging Face (about 0.5 GB, into
`~/.cache/huggingface`), so it takes a minute or two. Later runs take roughly a second per page.

### Embedders

The index embeds with `qwen3-embedding-0.6b` by default (Qwen/Qwen3-Embedding-0.6B, 1024
dimensions, Matryoshka, so `truncate_dim` can shrink it to 512, 256, 128 or 64).
`bge-small-en-v1.5` is the labelled 2024 baseline (384 dimensions, no truncation), and
`fake-deterministic` needs no download and is what the tests use. Both real models are
pinned to a Hugging Face commit and run on CPU through sentence-transformers.

The first index run downloads the model into `~/.cache/huggingface/hub`: about 1.2 GB for
Qwen3, about 130 MB for bge. On a laptop CPU Qwen3 takes about 1 to 1.5 s per 500-character
chunk.

Embeddings are cached at full width in SQLite under `artifacts/.embcache/` (or
`$RAG_PLAYGROUND_EMBED_CACHE`), so re-indexing the same chunks, or sweeping `truncate_dim`,
embeds each chunk once. Clearing the cache from the UI clears these too.

## Development

```bash
uv sync --extra dev
uv run pytest
uv run pytest -m models   # slow tests that load real models: Docling, Qwen3, bge
```

Requires Python 3.13. `uv python install 3.13` if you don't have it.

### Web UI

```bash
cd web
npm install
npm run dev      # Vite on :5173, proxies /api to 127.0.0.1:8000
npm test         # Vitest
npm run build    # outputs web/dist
```

Every color, size and radius lives in `web/src/styles/tokens.css`, which also clears
Tailwind's default scales so off-contract values do not compile. `/specimen` renders the
tokens in both themes for review. The UI is built against JSON fixtures generated from the
real engine; regenerate them with `uv run python web/scripts/export_fixtures.py`.

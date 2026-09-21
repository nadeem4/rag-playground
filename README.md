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

## Development

```bash
uv sync --extra dev
uv run pytest
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

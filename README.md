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

Phase 1 (core engine) in progress. See the Notion board for delivery and issue tracking.

## Development

```bash
uv sync --extra dev
uv run pytest
```

Requires Python 3.13. `uv python install 3.13` if you don't have it.

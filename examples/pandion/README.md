# pandion example

A small pipeline file and four scripts: one indexes two bundled sample PDFs, then
indexes them again; one keeps an index in step with a folder; one turns a question
into the query retrieval searches with; and one searches the index.

- `pipeline.yaml`: the pdfium parser, the `dedupe_blocks` cleaner, the
  `recursive_character` chunker and a lancedb index, then a `retrieve` section that
  searches with `hybrid_rrf` and reranks with `mmr`.
- `index_samples.py`: runs the pipeline twice and prints each step's note. The second
  run shows every step was reused.
- `sync_samples.py`: copies two samples into a folder and syncs the index with it, then
  adds a third sample and syncs, then removes it and syncs. Each sync prints what it
  added, changed, removed and left unchanged.
- `rewrite_question.py`: prints a question as typed and, with `ANTHROPIC_API_KEY` set,
  as Claude Haiku 4.5 rewrites it in the words of a sample PDF. The rewrite is one paid
  call.
- `search_samples.py`: indexes two samples, asks a question, and prints what each
  retrieval step did and the hits, best first. Then it asks again and shows every step
  was reused.

From the root of the repo:

```bash
uv run python examples/pandion/index_samples.py
```

The first run downloads the default embedder, `qwen3-embedding-0.6b`. To try it without
a download, use the fake embedder, or pick the smaller `bge-small-en-v1.5`:

```bash
uv run python examples/pandion/index_samples.py --embedder fake-deterministic
```

`sync_samples.py` takes the same `--embedder` option:

```bash
uv run python examples/pandion/sync_samples.py --embedder fake-deterministic
```

To search, pass the question as the argument. It takes `--embedder` too:

```bash
uv run python examples/pandion/search_samples.py "How big should a chunk be?" --embedder fake-deterministic
```

To rewrite a question, pass it as the argument:

```bash
uv run python examples/pandion/rewrite_question.py "How long should a piece be?"
```

The index is written to `pandion-example/` (or `pandion-sync-example/` for the sync
script, and `pandion-search-example/` for the search script) in the folder you run from. Use `--work` to
choose another folder. The full format of the pipeline file is in
[docs/pandion.md](../../docs/pandion.md).

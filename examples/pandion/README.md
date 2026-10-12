# pandion example

A small pipeline file and a script that indexes two bundled sample PDFs, then indexes
them again.

- `pipeline.yaml`: the pdfium parser, the `dedupe_blocks` cleaner, the
  `recursive_character` chunker and a lancedb index.
- `index_samples.py`: runs the pipeline twice and prints each step's note. The second
  run shows every step was reused.
- `sync_samples.py`: copies two samples into a folder and syncs the index with it, then
  adds a third sample and syncs, then removes it and syncs. Each sync prints what it
  added, changed, removed and left unchanged.

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

The index is written to `pandion-example/` (or `pandion-sync-example/` for the sync
script) in the folder you run from. Use `--work` to
choose another folder. The full format of the pipeline file is in
[docs/pandion.md](../../docs/pandion.md).

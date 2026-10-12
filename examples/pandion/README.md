# pandion example

A small pipeline file and a script that indexes two bundled sample PDFs, then indexes
them again.

- `pipeline.yaml`: the pdfium parser, the `dedupe_blocks` cleaner, the
  `recursive_character` chunker and a lancedb index.
- `index_samples.py`: runs the pipeline twice and prints each step's note. The second
  run shows every step was reused.

From the root of the repo:

```bash
uv run python examples/pandion/index_samples.py
```

The first run downloads the default embedder, `qwen3-embedding-0.6b`. To try it without
a download, use the fake embedder, or pick the smaller `bge-small-en-v1.5`:

```bash
uv run python examples/pandion/index_samples.py --embedder fake-deterministic
```

The index is written to `pandion-example/` in the folder you run from. Use `--work` to
choose another folder. The full format of the pipeline file is in
[docs/pandion.md](../../docs/pandion.md).

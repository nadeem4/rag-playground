# pandion example

A small pipeline file and six scripts: one indexes two bundled sample PDFs, then
indexes them again; one keeps an index in step with a folder; one turns a question
into the query retrieval searches with; one searches the index; one asks it a
question; and one builds the same pipeline three ways.

- `pipeline.yaml`: the pdfium parser, the `dedupe_blocks` cleaner, the
  `recursive_character` chunker and a lancedb index, then a `retrieve` section that
  searches with `hybrid_rrf` and reranks with `mmr`, and an `answer` section that shows
  the top three pieces with `search`.
- `cli.yaml`: `pipeline.yaml` with the fake embedder, for the `pandion` command
  examples at the end of this page. It downloads nothing.
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
- `ask_samples.py`: indexes two samples, asks a question and prints the pieces found,
  twice, to show every step was reused. With `ANTHROPIC_API_KEY` set it asks Claude Haiku
  4.5 for an answer that cites the pieces instead, which is one paid call.
- `three_styles.py`: builds the pipeline in `pipeline.yaml` as the file, as a dict per
  stage and as classes, in one folder. The first indexes and asks; the other two find every
  step already stored. It prints that the artifact ids match, then the classes pipeline
  written back as YAML.
- [`own_strategies/`](own_strategies): writes your own strategy for every stage, from
  the source to the answer, and runs them from a pipeline file (`run_yaml.py`) and mixed
  with built-in steps in code (`run_mixed.py`). Nothing is downloaded. Its README walks
  through it stage by stage.

To use Pandion from another language, a web app or several clients at once, serve it
over HTTP with pandion-api: see [`../pandion-api/`](../pandion-api).

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

To ask, pass the question as the argument. `three_styles.py` takes `--embedder` too:

```bash
uv run python examples/pandion/ask_samples.py "How big should a chunk be?" --embedder fake-deterministic
uv run python examples/pandion/three_styles.py --embedder fake-deterministic
```

To rewrite a question, pass it as the argument:

```bash
uv run python examples/pandion/rewrite_question.py "How long should a piece be?"
```

The index is written to `pandion-example/` (or `pandion-sync-example/` for the sync
script, `pandion-search-example/` for the search script, `pandion-ask-example/` for the
ask script and `pandion-styles-example/` for the three styles) in the folder you run from. Use `--work` to
choose another folder. The full format of the pipeline file is in
[docs/pandion.md](../../docs/pandion.md).

## From the command line

The `pandion` command runs a pipeline file with no script. `cli.yaml` is `pipeline.yaml`
with the fake embedder, so these commands download nothing. Swap in `pipeline.yaml` for
real results; its first run downloads `qwen3-embedding-0.6b`. From this folder
(`examples/pandion`):

```bash
uv run pandion validate cli.yaml
uv run pandion index cli.yaml ../../samples/chunking-primer/chunking-primer.pdf
uv run pandion ask cli.yaml "How big should a chunk be?"
uv run pandion eval cli.yaml ../../samples/chunking-primer/questions.json
uv run pandion compare cli.yaml --vary chunk.chunk_size=200,400,800 ../../samples/chunking-primer/chunking-primer.pdf --questions ../../samples/chunking-primer/questions.json
```

`ask` and `eval` need no `--documents` here, because `pandion index` remembers what it indexed. `compare`
runs the pipeline three times, reusing every step above Chunk from the cache. The index
goes to `cli-index/` in this folder.

`own_strategies/` reads one Markdown file per document with its own source, which cannot
sync. So name the files each time. From `own_strategies/`:

```bash
uv run pandion index pipeline.yaml notes/bees.md notes/bread.md notes/tides.md
uv run pandion ask pipeline.yaml "What causes the tides?" --documents notes/bees.md notes/bread.md notes/tides.md
```

Its file lists `plugins: [my_strategies]`. For a file that does not, `--plugins
my_strategies` imports them from the current folder. See
[the pandion command](../../docs/pandion.md#the-pandion-command).

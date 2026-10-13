# Write your own strategy, for every stage

This folder writes one strategy for every stage of a Pandion pipeline and uses them, first
from a pipeline file and then mixed with built-in steps in code. The strategies are
deliberately simple, so each file shows only what a strategy must have. Nothing is
downloaded and nothing goes over the network.

Every strategy has the same shape: a settings model where every field has a default, and
a class with `name`, `stage`, `inputs`, `output`, `config_model`, `summary` and `apply()`,
marked with `@register`. Everything you need comes from `pandion.extend`. The full guide is
"Write your own strategy" in [docs/pandion.md](../../../docs/pandion.md#write-your-own-strategy).

## The strategies, stage by stage

### Source: `text_file`

Open `my_strategies/source.py`. It reads the one text file at `location`. A source's
settings must have a `location` field, because each item given to `p.index.run([...])`
becomes one document and reaches the source as its `location`. It reads nothing from another step (`inputs = {}`) and returns
`raw_file(ctx, data, filename)`.

### Parse: `markdown`

Open `my_strategies/parse.py`. A parser reads the `file` port, a dict whose `path` is the
stored file. It returns a `ParsedDoc`: the blocks (`Element`s) in reading order.

### Clean: `drop_short`

Open `my_strategies/clean.py`. A cleaner reads the `doc` port and returns a `ParsedDoc`
again. It should say what it removed with `set_note(ctx, ...)`.

### Chunk: `per_block`

Open `my_strategies/chunk.py`. A chunker reads the `doc` port and returns a `ChunkSet`.
Its `source_text` is the text the pieces were cut from, so each piece's `start_char` and
`end_char` point at its own text there.

### Embed: `letter_counts`

Open `my_strategies/embed.py`. An embedder is an `Embedder` subclass, not a stage
strategy, and the same `@register` adds it. It sets `name`, `model_id`, `revision`,
`native_dim` and `max_seq_len`, and its `_embed(texts, kind)` returns a unit vector (its
length is 1.0), `native_dim` numbers long, for each text. `kind` is `"document"` when the
store embeds the pieces and `"query"` when the retriever embeds the question.

### Store: `jsonl_store`

Open `my_strategies/store.py`. A store reads the `chunks` port, one `ChunkSet` per
document, and returns a function that writes the index into a folder. Because its settings
have an `embedder` field, `embed: {use: letter_counts}` fills it in, and `provides` says
what a retriever can count on: the dense backend, in jsonl files. It gets the embedder
with `get_embedder(name, ctx.extras.get("models"))`, so the run's model settings reach it.

### Rewrite: `lowercase`

Open `my_strategies/rewrite.py`. A rewrite has a `text` setting, which Pandion fills with
the question. It returns a `Query`, with the question to search with in `text` and the
question as typed in `original`.

### Search: `jsonl_search`

Open `my_strategies/retrieve.py`. A retriever reads the `index` port, the folder the store
wrote, and the `query` port, which Pandion fills from the rewrite. Its `requires` must
match the store's `provides`, or the pipeline file is refused when it is read. It asks for
format jsonl as well as the dense backend, so it is refused with the `lancedb` store,
whose files it cannot read.

### Rerank: `shortest_first`

Open `my_strategies/rerank.py`. A reranker reads the `result` port, the hits of the step
before it. It returns them as a `RetrievalResult` in a new order, often fewer of them.

### Answer: `bullets`

Open `my_strategies/answer.py`. An answer step reads the `result` port and returns an
`Output`. The text in `payload["text"]` is what `p.ask(question).text` gives back.

## Use them

`pipeline.yaml` lists `plugins: [my_strategies]`, so reading the file imports the package
from the folder the file is in, and every strategy in it is registered before the steps
are checked. Then every stage names a strategy from this folder. This works from any
folder, so `pandion install --print examples/pandion/own_strategies/pipeline.yaml` works
from the root of the repo too.

`run_mixed.py` imports `my_strategies` in code instead, and mixes the built-in `pdfium`
parser and `recursive_character` chunker with the custom embedder, store, search and
answer. It reads `notes.pdf`, the three notes in one small PDF.

## Run it

From the root of the repo:

```bash
uv run python examples/pandion/own_strategies/run_yaml.py
uv run python examples/pandion/own_strategies/run_mixed.py
```

Each prints the strategy of every step and the answer to "What causes the tides?". The
index goes in `work/` next to the scripts: for `run_yaml.py` that is the file's `path`, and
`run_mixed.py` takes `--work <folder>` to put it somewhere else.
`run_mixed.py` needs the pdfium extra: `pip install "pandion[pdfium]"`.

## Ship it as a package

To use the strategies without `plugins:` or an import, put `my_strategies` in a package of
its own and add an entry point in its `pyproject.toml`. Pandion imports it the first time
it looks up a strategy:

```toml
[project.entry-points."pandion.strategies"]
my_strategies = "my_strategies"
```

If a strategy needs a pip extra of Pandion, set `extra = "<name>"` on the class, and
`pandion install pipeline.yaml` installs it.

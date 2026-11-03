# Write your own strategy

Write a strategy of your own and load it by name.

[Manual index](index.md) | Previous: [cli](cli.md) | Next: [errors](errors.md)

## Write your own strategy

Every stage takes a strategy, and you can write your own. A strategy is a class that
subclasses `pandion.extend.Transform`. You say which stage it is for, what it reads, and
what its settings are, and you write `apply()`. Then `@register` makes its `name` work in
a pipeline file and in `Pipeline(...)`, the same as a built-in.

[`examples/pandion/own_strategies/`](../../examples/pandion/own_strategies) writes one
strategy for every stage, from the source to the answer, and runs them from a pipeline
file and from code. It needs no download and no network. Its README walks through it
stage by stage.

Every strategy follows the same pattern:

1. A settings model: a pydantic `BaseModel` where every field has a default, so the step
   runs with no settings at all. A strategy with no settings still has an empty model.
2. A class that subclasses `Transform[YourSettings]` and sets:
   - `name`, the name you write after `use:`;
   - `stage`, one of `Stage.SOURCE`, `PARSE`, `CLEAN`, `CHUNK`, `INDEX`, `QUERY`,
     `RETRIEVE`, `RERANK` or `USE_CASE`;
   - `inputs`, the ports it reads, each a `PortSpec` (see the table below);
   - `output`, which the stage fixes (a parser must make a `PARSED_DOC`, and so on);
   - `config_model`, the settings model;
   - `summary`, one plain sentence saying what it does.
3. `apply(self, inputs, config, ctx)`, which gets the inputs by port name, the settings as
   an instance of your model, and the run's context, and returns the stage's output. A
   payload model, such as a `ParsedDoc`, and a plain dict, such as
   `doc.model_dump(mode="json")`, both work.
4. `@register` on the class.

A mistake in the class, such as a stage with the wrong output or a setting with no
default, is a `TypeError` when the module is imported, so it never reaches a pipeline.

The ports each stage reads:

| Stage | `stage =` | Reads (port: what) | Returns | Example in `my_strategies/` |
|---|---|---|---|---|
| source | `Stage.SOURCE` | nothing; the document is the `location` setting | `raw_file(ctx, data, filename)` | `source.py`: `text_file` |
| parse | `Stage.PARSE` | `file`: a dict with `sha`, `filename`, `path` and `mime` | `ParsedDoc` | `parse.py`: `markdown` |
| clean | `Stage.CLEAN` | `doc`: a `ParsedDoc` | `ParsedDoc` | `clean.py`: `drop_short` |
| chunk | `Stage.CHUNK` | `doc`: a `ParsedDoc` | `ChunkSet` | `chunk.py`: `per_block` |
| store | `Stage.INDEX` | `chunks`: a list of `ChunkSet`, one per document (`variadic=True`) | a function that writes into a folder | `store.py`: `jsonl_store` |
| rewrite | `Stage.QUERY` | nothing; the question is the `text` setting; `doc` if declared | `Query` | `rewrite.py`: `lowercase` |
| search | `Stage.RETRIEVE` | `index`: the store's folder; `query`: a `Query` (`ambient=True`) | `RetrievalResult` | `retrieve.py`: `jsonl_search` |
| rerank | `Stage.RERANK` | `result`: a `RetrievalResult` | `RetrievalResult` | `rerank.py`: `shortest_first` |
| answer | `Stage.USE_CASE` | `result`: a `RetrievalResult`; `doc` if declared | `Output` | `answer.py`: `bullets` |

The embedder is not a stage, so it is not in the table: `embed.py` (`letter_counts`) is its
example, under [Your own embedder](#your-own-embedder). These are every stage
`pandion.catalog()` lists, so the example covers each one. The `route` group of the
catalog holds checks, not stages, and `route.py` (`is_invoice`) is the example of one.

`Stage.ENRICH` and `Stage.QUERY_TRANSFORM` are reserved: no strategy uses them yet, and they are kept so result ids stay stable.

An `ambient=True` port is found for you: the `query` port is filled by the rewrite step
without any wiring. Everything in the table, and `register`, `set_note`, `set_usage`, `get_embedder`
and `raw_file`, comes from `pandion.extend`.

A strategy that calls a model at an address its settings name checks the address with
`guard_endpoint(base_url, public_only=...)`, which raises `EndpointRefused` for a private
or plain-http address when only public ones are allowed, and builds an OpenAI client's
arguments with `openai_client_kwargs`.

A short parser, for a start:

```python
from pathlib import Path

from pydantic import BaseModel
from pandion.extend import ArtifactType, Element, ParsedDoc, PortSpec, Stage, Transform, register

class NoSettings(BaseModel):
    pass

@register
class TxtLines(Transform[NoSettings]):
    name = "txt_lines"
    stage = Stage.PARSE
    inputs = {"file": PortSpec(ArtifactType.RAW_FILE)}
    output = ArtifactType.PARSED_DOC
    config_model = NoSettings
    summary = "One block per line of a text file."

    def apply(self, inputs, config, ctx):
        lines = Path(inputs["file"]["path"]).read_text(encoding="utf-8").splitlines()
        return ParsedDoc(elements=[Element(id=f"l{i}", type="paragraph", text=t, order=i)
                                   for i, t in enumerate(lines) if t.strip()])
```

If your strategy or embedder needs a pip extra, set `extra = "<name>"` on the class, and `pandion install` installs it for any pipeline file that uses it.

### Your own embedder

An embedder is set under `embed:` and not as a step, because the store embeds the pieces
with it and the retriever embeds the question with the same one. To add one, subclass
`pandion.extend.Embedder`, give it a name and its sizes, and write `_embed()`, which returns
one vector per text. The same `@register` adds it, and then `embed: {use: letter_counts}`
picks it.

```python
from pandion.extend import Embedder, register

@register
class LetterCounts(Embedder):
    name = "letter_counts"
    model_id = "local/letter-counts"
    revision = "1"
    native_dim = 26
    max_seq_len = 10_000

    def _embed(self, texts, kind):
        vectors = []
        for t in texts:
            counts = [t.lower().count(chr(97 + i)) for i in range(26)]
            length = sum(c * c for c in counts) ** 0.5 or 1.0  # no letters: avoid dividing by zero
            vectors.append([c / length for c in counts])
        return vectors
```

`kind` is `"document"` for a piece and `"query"` for a question. Return vectors of length 1
(divide each by its length), because search compares them as if they were. A name that is already
taken is refused.

### Your own source

By default each document is a local file given to `p.index.run`. To read documents from
somewhere else, such as a database, a web page or a bucket, write a source step and set it
under `index.source:`. Its settings must have a `location: str = ""` field: each item you
pass to `p.index.run([...])` becomes one document, its id is the item as text, and the
source is run with the item as its `location`. A source without a `location` field is
refused. The source returns `raw_file(ctx, data, filename)`, which keeps the bytes in the
`sources/` folder and hands the parser the same file record the built-in `upload` source does.

```python
from pydantic import BaseModel
from pandion.extend import ArtifactType, Stage, Transform, raw_file, register

class NoteSettings(BaseModel):
    location: str = ""

@register
class Note(Transform[NoteSettings]):
    name = "note"
    stage = Stage.SOURCE
    output = ArtifactType.RAW_FILE
    config_model = NoteSettings
    summary = "Treats the location itself as a short text document."

    def apply(self, inputs, config, ctx):
        return raw_file(ctx, config.location.encode("utf-8"), "note.txt")
```

```yaml
index:
  source: {use: note}
  parse: {use: txt_lines}   # your own parser, from the example above
```

In code it is the `source=` keyword:
`Pipeline(path="./index", source="note", parse="txt_lines", chunk="recursive_character", embed="fake-deterministic", store="lancedb")`.

`p.index.sync` works with local files only (the `upload` source); `p.index.run` works with
any source.

A source can hand over labels with `raw_file(ctx, data, filename, metadata={"cms_type": "invoice"})`.
A route that has a check (such as `metadata`) runs the source step first, so the labels can
choose the document's category. That step is a cache hit when the run goes on.

A source's result is cached by its settings, so by `location`: the same location is read
once and reused. If the content at a location can change, set `cacheable = False` on the
class, and it is read again on every run. The parse after it runs again only when what the
source read has changed; when it is the same, the stored parse and everything after it are
reused.

To search after a run with your own source, call `p.retrieve` or `p.ask` in the same process
as `p.index.run`. Only `upload` has a manifest, written by `p.index.sync`, that a later
process can read.

### A store and the retriever that reads it

A store says what it can be searched by in `provides`, and a retriever says what it needs
from the store in `requires`, on its `index` port. The built-in `lancedb` store provides
`{"backends": ["dense", "fts"], "format": ["store"]}`, and the built-in retrievers
(`dense`, `bm25` and `hybrid_rrf`) each need the backends they search and the `lancedb`
format, because they open a LanceDB table. Pandion compares the two when the pipeline is
read, so a mismatch is refused before anything runs, for example: "retrieve.search uses
'dense', which needs a store with backends dense and format store, but index.store uses
'my_store', which has backends dense and format jsonl." So a new store in another format
brings its own retriever, whose `requires` asks for what that store provides. Name the
format on both sides: it stops your retriever pairing with a store whose files it cannot
read, such as `lancedb`.

```python
class JsonlStore(Transform[JsonlStoreConfig]):
    stage = Stage.INDEX
    provides = {"backends": ["dense"], "format": ["jsonl"]}
    ...

class JsonlSearch(Transform[JsonlSearchConfig]):
    stage = Stage.RETRIEVE
    inputs = {"index": PortSpec(ArtifactType.INDEX), "query": PortSpec(ArtifactType.QUERY, ambient=True)}
    requires = {"index": {"backends": ["dense"], "format": ["jsonl"]}}
    ...
```

A store returns a function that takes a folder and writes the index into it. Do the work,
such as embedding, in `apply()`, so a failure is reported as the store's failure, and let
the function only write files. Pandion keeps the folder with the other results, and the
retriever gets the same folder as `inputs["index"]`, so it reads its files with
`Path(inputs["index"]) / "pieces.jsonl"`. A store with an `embedder` setting gets it from
`embed:`, so write the embedder's name into the folder too, and the retriever can embed
the question with the same one. In `apply()`, get the embedder with the run's model
settings, `get_embedder(name, ctx.extras.get("models"))`, so a model is found where the
pipeline's `models:` section says. To make a new embedder revision build a new index, return
`get_embedder(config.embedder).fingerprint()` from the store's `fingerprint()`.

### A rewrite and an answer

A rewrite step has a `text: str = ""` setting, and Pandion puts the question there when
you call `p.retrieve` or `p.ask`, so the file never sets it. It returns a `Query`: put the
question to search with in `text`, and the question as typed in `original`, which the
answer uses.

An answer step returns `Output(kind=..., payload={...})`. Put the answer as text in
`payload["text"]`, and `p.ask(question).text` gives it back.

A rewrite or an answer gets the parsed document only when it declares a `doc` input:
`inputs = {"doc": PortSpec(ArtifactType.PARSED_DOC, ambient=True, required=False)}`. With
several documents, it gets the first one by id.

Any step can record one plain sentence about what it did with `set_note(ctx, "...")`, for
example a cleaner saying how many blocks it removed. The note is shown with the step's
result, as `StageResult.note`.

A step that calls a model can record what the call used with
`set_usage(ctx, usage, model, requested_model=None)`. `usage` is
`{"input_tokens": ..., "output_tokens": ...}` and `model` is the model id the call went
to. Leave a count as None when the server did not send it. Pass the model id the server
reports when it gives one (`pandion.llm.complete` returns it as `Completion.model`), and
the id you sent as `requested_model`. When the two differ, the usage keeps both, so
`cost()` can still find a price. The usage is shown with the
step's result, as `StageResult.usage`, and in its `node_finished` event, or its
`node_failed` event when the step raises after recording it. A cached run of the step
shows None, since it called no model.

## Loading your strategies

`pandion.plugins.load(project_dir, modules)` is the one loader, also exported as `pandion.extend.load_plugins`. It imports the built-in
strategies, then the installed packages, then your modules, and puts `project_dir` on the
import path only while it does so. Pipeline files and the command line use it; serve, sync and eval will too. Any load
failure stops the process with a `PluginError` that names the module, and a name registered
twice fails with a sentence that names both modules. A `pipeline.yaml` runs code, because
its `plugins:` list imports modules, so never load one from a source you do not trust.

These are the extension points and how steady each one is. Pandion is 0.x, and a Stable
contract changes only after a deprecation in the changelog.

| Level | Extension points |
| --- | --- |
| Stable | Source, route check, access rule, index store, conversation store, Policy |
| Provisional | Step plugins, executor events, online evaluators, the chat turn (`ChatSettings`, `chat_turn`, `fold_summary`) |

Each Stable point has a tested example: a source ([`zip_source.py`](../../examples/pandion/extensions/zip_source.py)),
a route check ([`route.py`](../../examples/pandion/own_strategies/my_strategies/route.py)), an access rule
([`owner_access.py`](../../examples/pandion/extensions/owner_access.py)), an index store
([`json_file_store.py`](../../examples/pandion/extensions/json_file_store.py)) and a Policy
([`policy_example.py`](../../examples/pandion-api/policy_example.py)). a conversation store
([`dict_conversation_store.py`](../../examples/pandion/extensions/dict_conversation_store.py)). An online evaluator ([`answer_length_evaluator.py`](../../examples/pandion/extensions/answer_length_evaluator.py)) is Provisional.

A strategy only works by name once the module that registers it has been imported. There are
three ways to make that happen.

1. Import it in code, before you build the pipeline: `import my_company.rag_steps`.
2. List it under `plugins:` in the pipeline file. A YAML file cannot import anything, so the
   CLI, or a server that reads the file, needs to be told which modules to load.

   ```yaml
   plugins: [my_company.rag_steps]
   path: ./my-index
   index:
     parse: {use: txt_lines}
   ```

   Each module is imported from the folder the pipeline file is in first, the same way a
   relative path is read from it, so a module next to the file works from any folder,
   including with `pandion install`. A module that cannot be imported is a `ConfigError`
   that names the module and the error. `Pipeline.from_dict(data, base=...)` reads the
   same `plugins` key, and looks for the modules in `base` first.
   The `pandion` command also takes `--plugins a,b` for a file that does not list them; see
   [--plugins](cli.md#--plugins).

   `pandion install` imports the modules to read the file, before it installs anything.
   So import a heavy library, such as one that loads a model, inside `apply()` and not at
   the top of the module: then `pandion install` can run before that library is
   installed.
3. Ship it as a package. Add an entry point in the `pandion.strategies` group, and Pandion
   loads the package the first time it looks up a strategy:

   ```toml
   [project.entry-points."pandion.strategies"]
   qdrant = "pandion_qdrant"
   ```

   A package that fails to load gives a warning that names it, and the other strategies keep
   working.

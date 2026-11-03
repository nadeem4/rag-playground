# Errors

The errors Pandion raises and what they mean.

[Manual index](index.md) | Previous: [extend](extend.md)

## Errors

A pipeline file is checked before anything runs. A wrong step or setting is an error that
names where it is and what is accepted. For example, a misspelt setting:

```text
index.chunk (recursive_character) has no setting 'chunk_sise'. Its settings are: chunk_size, chunk_overlap, heading_context.
```

An unknown strategy lists the ones there are:

```text
index.chunk uses 'fixed', which is not a chunk strategy. The chunk strategies are: layout_blocks, markdown_header, recursive_character, sentence_window, token_based.
```

A step in the `retrieve` section is named the same way, for example
`retrieve.search (dense)` or `retrieve.rerank step 2 (cross_encoder)`, and the answer
step as `answer (chat)`. A pipeline written as dicts or classes gets the same messages.

The same checks apply to `pandion.parse`, `pandion.clean`, `pandion.chunk` and
`pandion.rewrite`, where the message starts with "The chunker", "Clean step 1" or "The
query step" instead of the place in the file. A
pipeline file problem is a `pandion.ConfigError`, a `ValueError`.

Every problem in a pipeline file or dict is a `ConfigError` whose message is one line: an
unknown strategy names the strategies there are, and a value a setting does not accept
names the step, the strategy and the setting, for example
`index.chunk (recursive_character): chunk_size: Input should be a valid integer.` An app can
show the message as it is. It need not read the message to place it: when the problem is one
step's, `exc.step` is that step's place in the pipeline file (`index.chunk`,
`index.clean.2`, `retrieve.rerank`, `index.store`, `answer`). Run events name steps by role
instead (`chunk`, `clean.2`, `rerank.1`, and `index` for embed and store), so the two are not
the same text. `exc.use` is its strategy, and `exc.settings` lists
each refused setting with its own sentence, as `{"field", "message"}`. `exc.to_dict()`
gives all of it as JSON. A problem that is no one step's has `step` and `use` None. Calling one stage with a bad value (`pandion.chunk(doc,
use="recursive_character", chunk_size="big")`) raises a `ValueError` with the same kind of
sentence.

A missing extra says which one to install:

```text
The pdfium parser needs pypdfium2. Install it with: pip install "pandion[pdfium]"
```

That is a `pandion.errors.MissingExtra`, an `ImportError`. With `download: never`, a
model that is not on disk raises `pandion.models.ModelNotDownloaded`.

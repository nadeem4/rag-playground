# Run a pipeline from an app

How an app runs a pipeline with settings forms, results by id and progress.

[Manual index](index.md) | Previous: [evaluate](evaluate.md) | Next: [templates-and-projects](templates-and-projects.md)

## Running a pipeline from an app

An app, such as a web server or a command line tool, can do everything through
Pandion's public API. This section lists what it needs. `pandion.evaluate` and
`pandion.compare` take `on_event` and `cancel` too, so a long evaluation can show
progress and be stopped.

`p.extras()` names the extras a pipeline needs (what `pandion install` installs).
`pandion.preload_parser('docling')` loads a parser's models before the first run, as
`preload_embedder` and `preload_reranker` do for theirs.

### Settings forms

`pandion.catalog()` lists every strategy, built in or your own, stage by stage, with its
summary and its settings as a JSON schema with defaults. `pandion.defaults()` names the
strategy a new pipeline starts with for each required part. `pandion.explain(stage, use,
settings)` says in plain words what one strategy will do with those settings, and warns
when they make no sense, without running anything. `catalog()` returns a copy each time,
so changing it changes nothing in Pandion. It also has a `route` entry, which lists the
route checks in the same shape. A check is not a strategy, so `explain` refuses
`"route"` with a `ValueError`.

```python
import pandion

schema = pandion.catalog()["chunk"]["recursive_character"]["config_schema"]
pandion.defaults()["search"]                                     # "hybrid_rrf"
pandion.explain("chunk", "recursive_character", {"chunk_size": 100, "chunk_overlap": 200})
# {"settings": "...", "warning": "Overlap must be smaller than the chunk size ...", "blocking": True, ...}
```

### Results by id

Every `StageResult` has an `artifact_id`. `p.result(id)` reads that result back from the
store later, for example when a page asks for one card's output: a dict for every result
but an index, whose result is its binding (also a dict). An id that is not a result id, or that has no
stored result, is a `KeyError`.

A server that keeps many pipelines under one folder does not need a pipeline to read a
result. `ResultStore` reads, describes and clears what is stored under a `path`:

```python
from pandion import ResultStore

results = ResultStore("./my-index")
results.info(result_id)    # {"id": ..., "type": "chunk_set", "meta": {...}}
results.get(result_id)     # the result, as p.result(result_id) gives it
results.clear()            # {"results": 12, "bytes": 48210, "complete": True}
```

An id that is not 64 lowercase hex characters, or that nothing is stored under, is a
`KeyError` whose message names the id but not the folder, so a server can hand it back.
`clear()` removes `artifacts/` and `embeddings/` and keeps `sources/`. Clearing while a
run is writing under the same path is not supported: the run may fail or leave some of
its results behind. A result cleared while it is being read is a `KeyError`, as if it
was never stored.

### One step, progress, stop, keys and re-runs

`index.run` takes five optional keywords. Without them it runs exactly as before.

```python
import threading

stop = threading.Event()               # set it from another thread to stop the run
report = p.index.run(
    "report.pdf",
    through="chunk",                   # stop after this step; report.index is then None
    on_event=print,                    # every event, with its "document" and "step"
    cancel=stop,
    credentials={"openai_api_key": key},   # for this call only; never stored
    force=True,                        # run every step again, even when it is stored
)
```

An app that keeps uploads under names of its own passes a mapping of document id to file,
so results keep the names people gave their files.

- `through` names the step to stop after: `parse`, `clean` (the last cleaner of the
  document's category, or parse when it has none), `clean.1`, `clean.2` ..., or `chunk`.
  A cleaner the document's category lacks stops it at its last cleaner. A step no
  category has is a `ValueError`. `index` is the whole run.
  The steps above it come from the cache when they ran before.
- `on_event` is called with each event as a plain dict, ready for JSON: `run_started`,
  `node_started`, `node_finished` (with `cache_hit`, the result's `artifact_id` and
  `usage`, the same value as `StageResult.usage`),
  `node_failed` (with the error and `usage`, what the step recorded before it failed),
  `node_skipped` (a step after one that failed),
  `warning` (with a `message`), `run_cancelled` and `run_finished`. To an event about
  one step, Pandion adds `document` (the document id, or None for the index) and
  `step`. Events about several steps name each one as `{"document": ..., "step": ...}`:
  `run_started` has `steps` (every step of the run) and `selected_steps` (the ones
  this run asked for), and `run_cancelled` has `skipped_steps`. The raw ids in
  `node_id`, `nodes`, `selected` and `skipped` are internal and may change; use the
  named fields. Every event about a step also has `stage` (`source`, `parse`, `clean`,
  `chunk`, `embed`, and so on). Events are still Provisional: keys are only ever added,
  never renamed or removed. If the callback raises, the run stops and the exception
  reaches your code. The one exception is an event a strategy emits itself through `ctx.emit` inside
  `apply`: an error the callback raises there is caught like any other step error, so
  that step fails instead of the whole run stopping.
- `trace_id` is any string you choose. `index.run`, `p.retrieve` and `p.ask`
  take it and add it to every event of the call, as `trace_id`, including the events a
  strategy emits itself. It is passed through, not read from the thread, so events from a
  worker thread keep it. Without it the key is absent.
- `cancel` is checked between steps: a step that is running finishes, the rest are
  reported with status `skipped`, and `report.ok` is False.
- `credentials` are the model keys for this call, as for `p.retrieve`.
- `force` runs every step that was asked for again, even when its result is stored.

A single step can emit the same events. `pandion.parse`, `pandion.clean`, `pandion.chunk`
and `pandion.rewrite` take `on_event` and `trace_id`, and give `node_started`, then
`node_finished`, or `node_failed` followed by the error being raised as before. The
`node_id` and `stage` are the stage name (`parse`, `clean`, `chunk`, `query`).

### Search the files a question is about

On a server many people share, one store holds everyone's results, so a search must say
which files it covers. `p.retrieve` and `p.ask` take `documents=`, the same argument
`index.run` takes, and search the index built from exactly those files. Files not yet
indexed with these settings are indexed first; files that were are read from the cache.
It does not change what `p.index` holds. `on_event`, `cancel`, `credentials` and `force`
work as for `index.run`. On a server many people share, always pass `documents=`;
without it the search covers whatever was last indexed in the process.

```python
answer = p.ask("What does chapter 2 say?", documents={"report.pdf": "/uploads/0f3a.pdf"},
               on_event=send_to_browser, cancel=stop)
```

`documents=` decides which index is searched. `where=` narrows the search inside that
index to some of its documents, pages or a section, as in
[Filter a search](index-and-search.md#filter-a-search). Its `document` names must be among `documents=`.

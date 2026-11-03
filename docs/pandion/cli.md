# The pandion command

Every pandion command, the plugins flag, keys and exit codes.

[Manual index](index.md) | Previous: [stores-and-access](stores-and-access.md) | Next: [extend](extend.md)

## The pandion command

The `pandion` command runs a pipeline file without writing any Python. It uses only
Pandion's public API, the same calls an app makes, so what it prints is what `Pipeline`
returns.

```bash
pandion validate pipeline.yaml
pandion strategies --stage chunk
pandion index pipeline.yaml report.pdf notes/
pandion sync pipeline.yaml
pandion forget-user alice --url-env PANDION_CONVERSATIONS_URL --yes
pandion retrieve pipeline.yaml "What is chunking?" --documents report.pdf
pandion ask pipeline.yaml "What is chunking?" --documents report.pdf
pandion eval pipeline.yaml questions.json --documents report.pdf
pandion compare pipeline.yaml --vary chunk.chunk_size=200,400,800 report.pdf --questions questions.json
pandion install pipeline.yaml --print
pandion models pull pipeline.yaml
pandion init my-project --index text --query balanced
pandion questions report.pdf --model claude-haiku-4-5 --count 15 --out questions.json
```

**`pandion validate FILE`** reads the file and checks every step, with no run. It prints
`pipeline.yaml is a valid pipeline.`, or the reason it is not, such as
`pandion: The pipeline file has no index section.`

**`pandion forget-user USER_ID [--store sql] [--url-env VAR] [--yes]`** deletes one user's conversations and memories from a conversation store and prints how many. See [Forget one user](conversations.md#forget-one-user).

**`pandion trace TRACE_ID [--store sql] [--url-env VAR] [--json]`** prints one stored chat trace, and **`pandion report [--since 7d] [--flagged] [--store sql] [--url-env VAR] [--json]`** summarises the stored traces. See [Read traces from the command line](traces.md#read-traces-from-the-command-line). **`pandion review [--evaluate [--only NAME ...] [--sample 1.0] [--rerun] [--judge]] [--since 7d] [--store sql] [--url-env VAR]`** lists the flagged and thumbs-down traces, and with `--evaluate` scores the stored traces with your online evaluators. See [Online evaluation](traces.md#online-evaluation).

**`pandion strategies [--stage STAGE] [--json]`** lists every strategy by stage, each with
its summary, and a `route` group for the route checks. `--stage chunk` shows one stage.
`--json` prints only the names, as JSON.

**`pandion plugins [--json]`** lists every extension point that is loaded: its kind, its name,
the module it came from and its level, which is `stable` or `provisional`. Add `--plugins a,b`
to see your own modules in the list. `--json` prints a list of objects with the keys `kind`,
`name`, `module` and `level`.

**`pandion index FILE DOC... [--sync] [--through STEP]`** indexes files and folders. With
local files (the `upload` source, the default) it runs `p.index.sync`, so it remembers the
documents it indexed for the next command; with any other source it runs `p.index.run`. It
prints one line per document and step, then the index:

```text
report.pdf  source  executed  2 ms
report.pdf  parse  executed  120 ms
report.pdf  chunk  executed  4 ms
index  lancedb  executed  310 ms
```

`--through chunk` stops every document after that step (`parse`, `clean`, `clean.2`,
`chunk` or `index`), so there is no index line, and nothing is remembered. `--sync` also
says, per document, `added`, `changed`, `removed` or `unchanged` since the last index.
A document the sync left out is printed as `failed: ID: REASON`, and the command exits 1
until nothing is left out.

**`pandion sync FILE`** syncs the source named in the file's `source:` block (see
[Name the source in the pipeline file](index-and-search.md#name-the-source-in-the-pipeline-file)) and prints
one JSON line on stdout, so a scheduled job can log it:

```text
{"event": "sync", "ok": true, "added": 2, "changed": 0, "removed": 0, "unchanged": 5, "failed": 0, "duration_s": 3.4, "tokens": 0}
```

The keys are `event`, `ok` (every document is in), `added`, `changed`, `removed`,
`unchanged` and `failed` (counts, never names), `duration_s`, and `tokens` (input plus
output tokens of the run). Each document left out is printed to stderr as
`failed: ID: REASON`. It exits with 0 when every document is in, 1 when a document was left
out, and 2 when the sync was refused: a bad file, no `source:` block, a source that listed
nothing, or another sync running. A cron job should alert on a non-zero exit. In the
refused case the sentence goes to stderr and no summary line is printed.

**`pandion retrieve FILE QUESTION [--k K] [--documents DOC...]`** searches the index and
prints the hits, one per line, as the rank, the score and the start of the piece:

```text
1. 0.8231  The capital of France is Paris. It is on the Seine.
```

`--k` is how many hits the last step keeps; without it the file's `top_k` holds.

**`pandion ask FILE QUESTION [--documents DOC...]`** prints the answer's text: the chat
answer, or the pieces found when the answer step is `search`.

`--documents` names the documents to search, indexing them first through the cache when
needed. Without it, `retrieve` and `ask` search the documents the last `pandion index`
indexed, so name every document each time you index. A pipeline whose source is not local
files remembers nothing from one command to the next, so name the documents again.

**`pandion eval FILE QUESTIONS [--top-k K] [--documents DOC...] [--json] [--baseline BASE [--allow N] | --record-baseline PATH] [--judge [--judge-model ID] [--judge-gate]]`** runs
`pandion.evaluate` on a question set (JSON or CSV, as in
[Evaluate a pipeline](evaluate.md#evaluate-a-pipeline)) and prints the report as Pandion prints it:
one line per question, then the totals. `--top-k` is how many of the top pieces are
checked; left out, it is the `eval` step's default `top_k` (5), as for `pandion.evaluate`. A last line gives the run's cost (see
[Speed and cost](evaluate.md#speed-and-cost)), for example:

```text
Cost: 1.84 s, 2,310 in / 412 out tokens, about $0.0041 (estimate, prices as of 2026-10-15); 2 of 7 steps cached; no price for openrouter/auto
```

A part that is unknown is left out rather than shown as 0: a pipeline with no model step
shows only the time and the cached steps. A priced model whose server sent no token count
is named as "no token count for ...". `--json` prints the report's `to_dict()`
instead, with the `cost()` dict under `"cost"`. It exits with 1 when a question could not
be scored.

**`--baseline FILE [--allow N]`** compares the run with an earlier one, as
[`against`](evaluate.md#compare-with-a-baseline) does, and prints one more line, such as
"Found 8 of 12; the baseline found 9 of 12. Newly missed: q4, q7.", followed by any
notes. It is a per-category gate: it exits with 1 when any category has more than `N`
questions newly missed (0 when `--allow` is left out), and names each failed category and
its newly missed ids, such as `Category "billing" newly missed: q4, q7.` A gain in one
category does not pay for a loss in another. The baseline file is checked before anything
runs, and a missing one exits with 2. When a step can differ between runs (see
[the noise warning](evaluate.md#compare-with-a-baseline)), each newly missed question is asked once more
first, and counts as newly missed only if it is missed again. A line says which were asked
again, such as "Asked again because llm_rerank can differ between runs: q4 (found), q7
(missed again).", and `--json` lists them under `"reasked"` as `{"id", "found"}`.

**Before it searches**, `pandion eval` runs the [stale check](evaluate.md#check-the-question-set-first). When an
expected passage is not in the current parse, it prints "The question set is stale: ... Fix or
rewrite those questions; this is not a retrieval regression." to stderr, searches nothing and
exits with 1; with `--json` it prints `{"stale": [...], "warnings": [...]}` to stdout instead.
A passage longer than any piece is a warning on stderr and the run goes on. `--record-baseline`
checks first too, so a baseline is never made of a stale set. There is no override flag.

**`--record-baseline PATH`** writes this run as a baseline: the report's `to_dict()` plus an
`environment` block (platform, model ids, Pandion version), creating the folders in `PATH`,
and prints `Baseline recorded at PATH (platform linux-x86_64, 12 questions).` It cannot be
combined with `--baseline`, and it writes nothing and exits 1 when a question could not be
scored. To re-record, run it again on purpose. With `--baseline`, a baseline made on
another platform or with other models exits 2 before any search runs, with the sentence
"This baseline was recorded on ...; this run is on ..., so the comparison would not be
fair. Re-record it here with --record-baseline, or run on the machine that recorded it."
A baseline with no `environment` (saved with `--json` before) still works and prints a note.
There is no override flag. In CI:

```bash
pandion eval pipeline.yaml questions.json --record-baseline base.json      # once, where CI runs
pandion eval pipeline.yaml questions.json --baseline base.json --allow 1   # on every change
```

With `--json`, the comparison is under `"regression"` (with `by_category`, and a `gate_ok`
that already counts `--allow`, so it matches the exit code) and the run's `environment` is
under `"environment"`. With `--record-baseline --json`, the "Baseline recorded" line goes
to stderr so stdout stays JSON. `environment` records the default model of a step that
names none (for example `cross-encoder/ms-marco-MiniLM-L-6-v2` for `cross_encoder`).

**`--judge`** also grades each answer against the question's expected `answer` with a model
(see [Judging correctness](evaluate.md#judging-correctness)). It is off by default and costs model calls.
It adds a "Judged correctness" line to the report and `correctness_mean`, `judged`,
`judge_skipped` and `judge_cost` to `--json`, and never changes the exit code on its own.
**`--judge-model ID`** picks the judge's model (default `claude-haiku-4-5`). **`--judge-gate`**,
with `--baseline`, exits 1 when the mean correctness fell more than 0.05 below the baseline's.
Both need `--judge`, and `--judge-gate` needs `--baseline`; otherwise the command exits 2
before it searches.

**`pandion compare FILE --vary SPEC DOC... [--questions QUESTIONS] [--top-k K] [--json]`**
runs `pandion.compare`: the pipeline once per value of one setting, indexing `DOC...`
each time, so every step above the changed one comes from the cache. It prints one line
per variant, each followed by that variant's cost line, and, with `--questions`, the best
one. `--top-k` is how many of the top pieces are checked, the `eval` step's default when
left out, as for `pandion eval`. `--json` prints `to_dict()`, with each variant's `cost()` under `"cost"`.

`--vary` takes `stage.setting=a,b,c`, and each value is read as YAML, so `200` is a
number and `null` is no value:

- `chunk.chunk_size=200,400,800` changes one setting of the chunk step.
- `search.use=dense,bm25` changes the strategy itself; the other settings go back to
  that strategy's own.
- `clean.2.min_chars=20,40` changes a setting of the second clean step. Clean and rerank
  are lists of steps, so name the step by its place, from 1. (`min_chars` belongs to
  `drop_short`, the cleaner in the own_strategies example, where
  `--vary clean.1.min_chars=20,200` works as is.)

The stages `--vary` can name are parse, clean, chunk, enrich, embed, store, rewrite,
search and rerank. Without `--questions`, compare only indexes, and shows each variant's step; it
cannot compare a search, rewrite or rerank step that way, because nothing is searched.

**`pandion install FILE [--print]`** installs the extras the file needs, as described in
[Install what a file needs](install.md#install-what-a-file-needs).

**`pandion models pull FILE [--cache-dir DIR]`** downloads the public model weights the file
needs, ahead of time: the local embedder, each `cross_encoder` reranker at its pinned
revision, and the Docling layout models when the file parses with `docling`. It prints one
line per model, or `This pipeline uses no local model.`, and exits 0. When a download fails
it prints one sentence naming the model and exits 1. It never prints a token. Models go into
`--cache-dir`, else the file's `models.cache_dir`, else the Hugging Face default (Docling
keeps its own models in the Hugging Face default). Run it at Docker build time so the
container starts with `models.download: never`. See [Models](install.md#models).

**`pandion init FOLDER [--index NAME] [--query NAME] [--questions FILE] [--overwrite]`**
writes a project folder from an index and a query template, as described in
[Start a project](templates-and-projects.md#start-a-project), then prints the files it wrote and the next steps.

**`pandion questions DOC --model ID [--count N] [--out FILE] [--model-name NAME] [--base-url URL] [--parser NAME] [--overwrite]`**
parses DOC (with `pdfium` unless `--parser` names another), has the model write up to
`--count` questions (default 15) with
[`write_questions`](evaluate.md#questions-written-for-you), and writes the set to `--out`
(default `questions.json`). It then prints how many questions were kept, each one
dropped and why, how many are tagged `copied`, and the tokens used. To change a
question, edit the file. `--model-name` and `--base-url` are for `openrouter` and
`custom`. An `--out` file that already exists is refused, before any model call, unless
`--overwrite` is given. When no question was kept, it prints the summary, writes no
file, and exits with 1. An error from the model also exits with 1, with the key taken
out of the message.

### --plugins

Every command takes `--plugins a,b`: modules to import before the file is read, from the
current folder first, so the strategies they register can be named in the file. It works
like `plugins:` in the file, for a file that does not list them. A module that cannot be
imported is an error that names it. The worked example in
[examples/pandion/own_strategies/](../../examples/pandion/own_strategies) has a strategy at
every step in its `my_strategies` folder. From that folder:

```bash
pandion strategies --plugins my_strategies --stage chunk   # per_block is in the list
pandion validate copy.yaml --plugins my_strategies         # copy.yaml: pipeline.yaml without its plugins: line
pandion index copy.yaml notes/bees.md notes/bread.md notes/tides.md --plugins my_strategies
pandion ask copy.yaml "What causes the tides?" --documents notes/bees.md notes/bread.md notes/tides.md --plugins my_strategies
```

Without `--plugins`, the second command fails, because `per_block` and the others are not
registered.

### Keys and exit codes

A model's key comes from the environment, never from the file or a flag:
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_COMPATIBLE_API_KEY` and
`OPENROUTER_API_KEY`. Only the ones that are set are passed on, and a key is never
printed.

The command exits with 0 when it is done, 1 when a step failed (the line for that step
says why) or `pandion eval --baseline` found a category with more newly missed questions than `--allow`,
and 2 when the file, a flag or the baseline file is wrong, or the baseline was made on
another platform or with other models (the message starts with `pandion: `).

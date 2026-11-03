# The Pandion manual

Pandion is the engine of RAG Playground as a Python package. The
playground runs on it. Every stage can be run and inspected on its own, and a whole
index can be built from one config file. Each step's result is cached under a hash of its
recipe, so the same files with the same settings are never processed twice.

This guide covers what exists today: parse, clean, chunk, the index, keeping an index up
to date, the rewrite of a question, searching an index with rerankers, asking a question,
evaluating a pipeline on a question set, comparing settings at one stage, and three ways to write the same pipeline: a YAML file, a dict per stage, and classes in
code.

Before each release to PyPI, [checks/pandion-install/](../../checks/pandion-install)
installs the built package in new environments, with and without extras, and tests it there.

## Pages

Read them in this order, or jump to the one you need.

- [install](install.md): How to install Pandion, which extras a pipeline needs, and how models are found.
- [stages](stages.md): Parse, clean, chunk and rewrite, each run on its own.
- [pipeline-file](pipeline-file.md): Every field of the YAML pipeline file, including categories and routes.
- [index-and-search](index-and-search.md): Build an index, keep it up to date, search it, ask a question, and roll out a new one.
- [evaluate](evaluate.md): Evaluate a pipeline on a question set, compare settings, and see speed and cost.
- [use-from-an-app](use-from-an-app.md): How an app runs a pipeline with settings forms, results by id and progress.
- [templates-and-projects](templates-and-projects.md): Three ways to write a pipeline, pipeline templates, and starting a project.
- [conversations](conversations.md): Conversation stores, a chat turn, memory across conversations and answer safety.
- [traces](traces.md): Traces, flags and feedback, online evaluation and promoting a trace to a test.
- [stores-and-access](stores-and-access.md): Who may read a document, and the LanceDB and Qdrant index stores.
- [cli](cli.md): Every pandion command, the plugins flag, keys and exit codes.
- [extend](extend.md): Write a strategy of your own and load it by name.
- [errors](errors.md): The errors Pandion raises and what they mean.
- [Run the example](#run-the-example): the sample scripts in `examples/pandion/`.

## Run the example

[`examples/pandion/`](../../examples/pandion) has a small pipeline file and a script that
indexes two sample PDFs, prints each step's note, then runs again to show every step was
reused. A second script syncs a folder, adds a sample, syncs again, removes it, and
syncs once more. `rewrite_question.py` prints a question as typed and, with
`ANTHROPIC_API_KEY` set, as a model rewrites it. `search_samples.py` indexes two samples,
searches them, prints what each step did and the hits, then searches again to show
every step was reused. `ask_samples.py` asks the samples a question and prints the pieces
found, and with `ANTHROPIC_API_KEY` set, Claude's answer with citations.
`three_styles.py` builds the same pipeline as a file, as dicts and as classes, and prints
that the artifact ids match. A test runs all six, so they stay correct.

[`examples/pandion/own_strategies/`](../../examples/pandion/own_strategies) writes a
strategy for every stage and runs them from a pipeline file (`run_yaml.py`) and mixed with
built-in steps in code (`run_mixed.py`). A test runs both, and the install check runs
`run_yaml.py` and `pandion install --print` on its pipeline file against the built package.

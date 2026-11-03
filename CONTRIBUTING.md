# Contributing

How to set up RAG Playground for development, run the tests and add a strategy or an
endpoint. Releases are in the [release runbook](docs/operations/release.md). For how the
code fits together, see
[docs/architecture.md](docs/architecture.md). If you work on the `pandion` package, read
[docs/pandion/index.md](docs/pandion/index.md) first; it shows how to use the package, and
`examples/pandion/` is tested, so update it when the package's API changes.

## Contents

- [Development setup](#development-setup)
- [Running the tests](#running-the-tests)
- [Styling and fixtures](#styling-and-fixtures)
- [Adding a strategy](#adding-a-strategy)
- [Adding an endpoint](#adding-an-endpoint)
- [Changing a guided step](#changing-a-guided-step)
- [The package boundary](#the-package-boundary)
- [The samples](#the-samples)
- [Releasing](#releasing)

## Development setup

You need [uv](https://docs.astral.sh/uv/) (Python 3.13) and Node.js 22 or newer.

```bash
git clone https://github.com/nadeem4/rag-playground.git && cd rag-playground
uv sync --extra dev
cd playground/frontend && npm install && cd ../..
```

Two extras of `pandion-api` are optional: `pandion-api[metrics]` (Prometheus) and `pandion-api[otel]` (OpenTelemetry). `--extra dev` installs both for the tests.

The repository is a uv workspace with two packages besides the app: `packages/pandion` (the engine, published as `pandion`) and `packages/pandion-api` (the REST layer; on PyPI as `pip install pandion-api`, released from its own tag). `uv sync` installs both from their folders, so an edit in either is live at once.

To work on the web app, run the server in one terminal and Vite in another:

```bash
uv run rag-playground --no-browser --reload
cd playground/frontend && npm run dev
```

Then open http://localhost:5173. Vite proxies `/api` to the server on 127.0.0.1:8000.
`--reload` restarts the server when a Python file changes.

`cd playground/frontend && npm run build` writes `playground/frontend/dist`, which the
Python server serves on http://127.0.0.1:8000.

## Running the tests

```bash
uv run pytest                        # the fast suite, no model downloads
uv run pytest -m models              # the slow tests that load Docling, Qwen3 and bge
cd playground/frontend && npm test   # Vitest
```

`uv run pytest packages/pandion-api/tests` runs pandion-api's own tests. pandion-api may import only Pandion's public API, which `test_api_boundary.py` checks with no allow-list. A test file there is named `test_api_*.py`, so it never shares a name with one of the engine's.

The playground's own tests are in `tests/api/`. The demo's rule tests (`test_demo.py`,
`test_delete_source.py`, `test_source_file.py` and the rest) call `/api/v2` directly: the
old `/api` routes are gone, and so is the module that ran each rule test a second time
against `/api/v2`. `tests/api/test_routes.py` lists the routes the playground serves
under `/api` besides `/api/v2`, and checks that every path the web's clients name is
served.

The smoke test drives the real app in a real browser. It starts its own demo server on a
free port, builds the index, asks a question, runs Compare and Evaluate, then opens every
page at 1440 and 390 px in light and dark. A page that scrolls sideways or logs an error
fails it. It needs the models and a web build, and takes about two minutes:

```bash
uv run --with playwright==1.55.0 playwright install chromium   # once
cd playground/frontend && npm run build && cd ../..
uv run --with playwright==1.55.0 pytest -m smoke
```

The Qdrant store tests run embedded, with no server. To run the conformance suite against a
real Qdrant server too, set `QDRANT_URL` (for example
`QDRANT_URL=http://localhost:6333 uv run pytest packages/pandion/tests/test_index_qdrant.py`).

The tests run on every push and pull request to `main` (`.github/workflows/ci.yml`): the
Python suite, then the web tests and a web build. The `models` and `smoke` tests run in
their own workflow, **Release checks** (`.github/workflows/release-checks.yml`), on
GitHub's machine with the models cached between runs. The Release workflow runs it
before it tags a release. You can run it for any branch, tag or commit:

```bash
gh workflow run "Release checks" -f ref=feat/some-branch
```

The template parity test (`tests/integration/test_template_parity.py`) runs pipeline
template pairs through Pandion and through pandion-api and checks they agree. Under
`-m models` it runs three representative pairs: Text documents with Balanced, Reports with
tables with Best precision, and Scanned PDFs with Exact terms. Set `TEMPLATE_PARITY=all`
to run every pair that needs no key. The **Template parity** workflow
(`.github/workflows/template-parity.yml`) does that every Monday, with the same model
cache as Release checks, and you can start it by hand:

```bash
gh workflow run "Template parity" -f ref=feat/some-branch
TEMPLATE_PARITY=all uv run pytest -m models tests/integration/test_template_parity.py
```

Serve project goldens and the boot check: `pandion init --serve` output is pinned by goldens in
`packages/pandion/tests/golden/serve_project/` (the version pins are hidden in them). After a
change to a serve template, regenerate them with
`PANDION_UPDATE_GOLDENS=1 uv run pytest packages/pandion/tests/test_serve_project.py` and read
the diff. `packages/pandion/tests/test_serve_boot.py` generates a serve project, runs a real
`pandion sync`, starts its app in process and checks `/ready`, `/chat`, the default policy and
the project's own quality test (it takes about two minutes, with no network or model).

The Home terminal test (`tests/integration/test_home_terminal.py`) replays the `pandion init`
run shown on the Home page and checks its two result lines, so Linux confirms the figures.
It runs under `-m models` in Release checks.

To check the `pandion` wheel the way a user would install it, run
`uv run python checks/pandion-install/run_check.py`. It installs the built wheel in new
environments, with and without extras, and tests it there. Add `--with-models` to also
check the first model download. [checks/pandion-install/README.md](checks/pandion-install/README.md)
says what it checks. The **Pandion install check** workflow runs it on pull requests that
change `packages/pandion/`, and you can run it by hand with the `with_models` input to
also test the model download.

Follow test-driven development: write the failing test first, then the code.

## Styling and fixtures

- Every colour, size and radius is a token in `playground/frontend/src/styles/tokens.css`. Tailwind's
  default scales are cleared, so values that are not tokens do not compile. Text sizes are
  in rem, so they follow the browser's font size.
- The typefaces are self-hosted from npm: Atkinson Hyperlegible Next for the interface,
  Source Serif 4 for the document's own words, and JetBrains Mono for numbers and ids. No
  font is fetched from the network at run time.
- The **Dev** menu in the header opens the component inspectors and a token specimen
  page. It is hidden in demo mode.
- The web tests use JSON fixtures generated from the real engine. See
  [Regenerating the fixtures and the lesson recordings](docs/operations/release.md#regenerating-the-fixtures-and-the-lesson-recordings).

## Adding a strategy

A strategy is one Python module. The web app builds its settings form from the config
model, so a new strategy needs no frontend change.

To extend Pandion without changing it (a source, an access rule, an index store, a Policy), copy a tested example from `examples/pandion/extensions/` or `examples/pandion-api/policy_example.py`. Their tests run in the fast suite.

1. Create `packages/pandion/src/pandion/plugins/<stage>/<name>.py` with a Pydantic config
   model and a `Transform` subclass decorated with `@register`. Every step lives in the
   package, the Evaluate step too; the app has no steps of its own. Give every config field a default. Give the class:
   - a `summary` of how the strategy works, in one or two plain sentences;
   - an `explain(config)` that says what these settings will do. Every number, switch and
     choice must change the explanation, unless it is listed in `EXPLAIN_EXEMPT` with a
     comment saying why;
   - for a chunk strategy, `learn`: a one-sentence `hint` and more paragraphs for the
     strategy itself (the key `_strategy`) and for every setting. Build shows them;
   - for a chunk strategy whose size setting does not count tokens, `size_unit`
     (`"characters"`), so `pandion.chunk.stats` and the app say each piece's size the
     way the setting does. `"characters"` and `"tokens"` are the only two values; any
     other is treated as `"tokens"`;
   - for a chunk strategy, `json_schema_extra=SIZE_ROLE` on its size setting and
     `OVERLAP_ROLE` on its overlap setting (from `pandion.plugins.chunk`), so the app's
     Compare can halve the size without knowing the settings' names;
   - if it needs something from the step above it, `requires`, keyed by input port, for
     example `{"index": {"backends": ["fts"]}}`, and `provides` on the producer, for
     example `{"backends": ["dense", "fts"]}`. An unmet requirement is a hard lock: the
     pipeline is refused when it is read, and the app greys the option out and blocks Run. A step whose
     input and output are the same kind of artifact, such as a Clean step, passes on what
     the step above it provides;
   - if it runs without something but degrades, `prefers`, in the same shape, with a
     one-sentence `fallback` saying what happens instead. That is a soft lock: the option
     stays selectable, tagged "Falls back";
   - `deterministic = False` if its output can change between runs (a model call), and
     `cacheable = False` if its output should never be reused, as for chat answers. A
     step after a non-cacheable one runs again only when that step's output changed;
     the executor hashes the output into the next step's id.
2. Add the module to `PLUGIN_MODULES` in `pandion/plugins/__init__.py`. A test fails if a
   plugin module exists but is not listed. The app needs no change: it never names a
   plugin module. Import a heavy library inside the function that uses it, through
   `pandion.errors.require`, so discovering the strategy needs no extra. A package
   strategy also gets a step class, one line in its stage's module (for example
   `Docling = step_class(Stage.PARSE, "docling", __name__)` in
   `packages/pandion/src/pandion/parse.py`), so a pipeline written in code can use it. A
   test fails if a strategy has no class.
3. Run `uv run pytest`. It runs the app's tests in `tests/` and the engine's tests in
   `packages/pandion/tests/`. The contract suite (`tests/contract/`) checks every plugin,
   including that the artifact id is deterministic, that the config round-trips through
   JSON, that the explanation changes with each setting, and, for a chunk strategy, that
   `learn` covers every setting in full sentences with no dashes.
4. Describe it in [docs/app/strategies.md](docs/app/strategies.md) and add it to the table in the
   README.

`packages/pandion/src/pandion/plugins/clean/drop_matching.py` is a small, complete example.

This is for a strategy that ships with Pandion. A strategy of your own does not need to be
in Pandion at all: [examples/pandion/own_strategies/](examples/pandion/own_strategies)
writes one for every stage and loads them with `plugins:` or `--plugins`. If you change
how strategies are written, update that example too; CI runs it.

**Adding a setting to a built-in step.** A result id hashes a step's settings, so a new
field would move every id of that step and rebuild every cache. Give the settings model
`pandion.ids.AddedSettings` as its base and name the field in `added`, with today's
behaviour as its default: it is then left out of the hash while it holds that default.
Changing that default later changes what the step does, so bump the step's `version`.
A subclass keeps its parents' `added` names. The default must be a plain value, not a
`default_factory`, and a name that is not a setting is refused when the class is defined.
`packages/pandion/tests/test_recipe_hash.py` must pass unchanged.

## Adding an endpoint

An endpoint any site would want goes in pandion-api
(`packages/pandion-api/src/pandion_api/routes/`), with its tests in
`packages/pandion-api/tests/`; it may use only Pandion's public API, which
`packages/pandion-api/tests/test_api_boundary.py` checks. A rule only some sites want is a
`Policy` method with a default that allows everything, and the playground's version goes in
`playground/backend/policy.py`, tested on `/api/v2` in `tests/api/`. An endpoint only the playground wants
(a lesson, a sample) goes in `playground/backend/routes/`, and in the `TEACHING` list of
`tests/api/test_routes.py`, which fails on a route under `/api` it does not list. Describe
a new endpoint or Policy method in [docs/pandion-api/index.md](docs/pandion-api/index.md).

A new test of a site rule goes in `tests/api/` (`test_demo.py`, `test_delete_source.py`,
`test_source_file.py` and the rest) and calls the `/api/v2` route the web calls.

## Changing a guided step

The guided run's steps and all their copy are in `playground/frontend/src/state/guide.ts`.
Edit the step there; the result lines that come from a real run are in
`state/guideResult.ts`. `state/guide.test.ts` checks that the copy has no dashes, no
questions and no numbers, so run it after any wording change.

## The package boundary

The app (`playground/backend/`, `playground/frontend/scripts/` and `scripts/`) imports only
Pandion's public API and pandion-api: `pandion`, a stage namespace (`pandion.parse` to `pandion.answer`),
`pandion.extend` and `pandion.evaluation`, each a name in its `__all__`.
`tests/integration/test_package_boundary.py` fails on any other Pandion import, and there
is no allow-list to add to. If the app needs a name that is not public, make it public in
Pandion first: add it to the module's `__all__`, describe it in
[docs/pandion/index.md](docs/pandion/index.md), and add a test for it in `packages/pandion/tests/`.
Tests may still reach inside the engine.

## The samples

The bundled samples live under `samples/<name>/`: the PDF, its question set
(`questions.json`) and `sample.json`. They are written for the playground by
`scripts/make_samples.py`, so they are reproducible and free to share. To regenerate them:

```bash
uv run python scripts/make_samples.py
```

## Releasing

Staging, releasing the app, publishing Pandion and pandion-api to PyPI and recording the Home clips are
in the [release runbook](docs/operations/release.md). Releases need the owner's yes.

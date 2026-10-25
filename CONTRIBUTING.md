# Contributing

How to set up RAG Playground for development, run the tests, add a strategy, cut a
release and record the Home clips. For how the code fits together, see
[docs/architecture.md](docs/architecture.md). If you work on the `pandion` package, read
[docs/pandion.md](docs/pandion.md) first; it shows how to use the package, and
`examples/pandion/` is tested, so update it when the package's API changes.

## Contents

- [Development setup](#development-setup)
- [Running the tests](#running-the-tests)
- [Styling and fixtures](#styling-and-fixtures)
- [Adding a strategy](#adding-a-strategy)
- [Adding an endpoint](#adding-an-endpoint)
- [The package boundary](#the-package-boundary)
- [The samples](#the-samples)
- [Staging](#staging)
- [Releasing](#releasing)
- [Publishing pandion](#publishing-pandion)
- [Recording the Home clips](#recording-the-home-clips)
- [Regenerating the fixtures and the lesson recordings](#regenerating-the-fixtures-and-the-lesson-recordings)

## Development setup

You need [uv](https://docs.astral.sh/uv/) (Python 3.13) and Node.js 22 or newer.

```bash
git clone https://github.com/nadeem4/rag-playground.git && cd rag-playground
uv sync --extra dev
cd playground/frontend && npm install && cd ../..
```

The repository is a uv workspace with two packages besides the app: `packages/pandion` (the engine, published as `pandion`) and `packages/pandion-api` (the REST layer, not published). `uv sync` installs both from their folders, so an edit in either is live at once.

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
  [Regenerating the fixtures and the lesson recordings](#regenerating-the-fixtures-and-the-lesson-recordings).

## Adding a strategy

A strategy is one Python module. The web app builds its settings form from the config
model, so a new strategy needs no frontend change.

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
4. Describe it in [docs/strategies.md](docs/strategies.md) and add it to the table in the
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
a new endpoint or Policy method in [docs/pandion-api.md](docs/pandion-api.md).

A new test of a site rule goes in `tests/api/` (`test_demo.py`, `test_delete_source.py`,
`test_source_file.py` and the rest) and calls the `/api/v2` route the web calls.

## The package boundary

The app (`playground/backend/`, `playground/frontend/scripts/` and `scripts/`) imports only
Pandion's public API and pandion-api: `pandion`, a stage namespace (`pandion.parse` to `pandion.answer`),
`pandion.extend` and `pandion.evaluation`, each a name in its `__all__`.
`tests/integration/test_package_boundary.py` fails on any other Pandion import, and there
is no allow-list to add to. If the app needs a name that is not public, make it public in
Pandion first: add it to the module's `__all__`, describe it in
[docs/pandion.md](docs/pandion.md), and add a test for it in `packages/pandion/tests/`.
Tests may still reach inside the engine.

## The samples

The bundled samples live under `samples/<name>/`: the PDF, its question set
(`questions.json`) and `sample.json`. They are written for the playground by
`scripts/make_samples.py`, so they are reproducible and free to share. To regenerate them:

```bash
uv run python scripts/make_samples.py
```

## Staging

Staging is a private copy of the demo on Hugging Face, `nadeem4nk/rag-playground-staging`.
It runs in demo mode on the same free CPU hardware as the demo, so testing it is testing
what visitors get, without loading your own computer.

- **`main` publishes itself** to staging after every merge (`.github/workflows/staging.yml`).
- **Any branch can be published by hand** before it is merged, to try a pull request:

  ```bash
  gh workflow run "Publish staging" -f ref=feat/some-branch
  ```

- After a publish, the workflow waits until the Space runs that exact commit, read from
  `/api/health`, and fails if the build does not come up. A verified commit gets the
  GitHub commit status `staging` = success, which production requires. One staging
  publish runs at a time; a newer one waits for the one in progress.
- Open it at https://huggingface.co/spaces/nadeem4nk/rag-playground-staging while signed in
  to Hugging Face. It is private, so nobody else can. Its storage starts empty after each
  publish, and it sleeps after about two days without a visit; the first visit wakes it.

`/api/health` answers `{"status": "ok", "version": ..., "commit": ..., "demo": ...}`.
`commit` is the commit the Space was published from (`publish_space.py --commit` sets it
as the Space variable `RAG_PLAYGROUND_COMMIT`). `version` is the published tag
(`--version`, the Space variable `RAG_PLAYGROUND_VERSION`); on staging it is the last
release tag plus the commit, such as `v0.32.1+a171030`.

## Releasing

Production, the public demo, is released **only after the owner's explicit approval**
(his yes, in chat), and **only from a tested staging commit**. Version numbers are
calculated, never chosen.

### Pull request titles

Pull requests are squash-merged, so the title becomes the commit on `main`, and the
release version is calculated from those commits. The title must be a Conventional
Commit: `type(optional scope): description`, with `!` before the colon for a breaking
change. A check (`.github/workflows/pr-title.yml`, `scripts/check_pr_title.py`) fails a
title that is not.

| Type | Meaning | Makes a release |
|---|---|---|
| `feat` | something new a visitor can use | yes, the minor number |
| `fix` | a bug fixed | yes, the patch number |
| `perf` | faster, same behaviour | yes, the patch number |
| `docs`, `chore`, `test`, `ops`, `ci`, `refactor`, `style`, `build` | housekeeping | no |
| any type with `!`, or `BREAKING CHANGE:` in the body | breaking | yes, the minor number before 1.0, the major number after |

Do not bump the version in `pyproject.toml` in a pull request. The tag is the version:
`pyproject.toml`'s version is no longer the source of truth, and `/api/health` reports the
published tag.

### The flow

1. **Merge to `main`.** Staging publishes itself and verifies the build (see
   [Staging](#staging)).
2. **Test on staging.**
3. **Ask the owner.** When he says yes, start the release:

   ```bash
   gh workflow run Release
   ```

   The Release workflow (`.github/workflows/release.yml`), stopping at the first step
   that fails:

   1. Reads the commit staging runs from its `/api/health`, checks it is on `main`, and
      checks it passed staging (`scripts/release_gate.py`).
   2. Calculates the version and the notes from the commits since the last release tag
      (`scripts/next_release.py`, which runs git-cliff with `cliff.toml`). If there is
      only housekeeping, it stops with "Nothing user-facing since vX.Y.Z."
   3. Runs the release checks on that commit: the model tests and the smoke test.
   4. Tags `vX.Y.Z` on that exact commit and creates the GitHub release with the notes.
   5. Starts "Publish the Hugging Face Space" on the new tag, which publishes it,
      verifies the Space runs that commit, the home page answers and a Home clip is a
      real video, not a 131-byte Git LFS pointer, then marks the release **Latest**.

   The version and the notes are at the top of the run's summary.
4. **The day the owner calls it stable,** release 1.0 instead. This is the only version
   choice anyone makes by hand:

   ```bash
   gh workflow run Release -f go_to_1_0_0=true
   ```

### Rolling back

Publish an older release tag. Start the workflow from that tag, because the `production`
environment accepts deployments only from `v*.*.*` tags:

```bash
gh workflow run "Publish the Hugging Face Space" --ref v0.33.0 -f tag=v0.33.0
```

It runs the same gate (a plain release tag that passed staging), the release checks, the
publish and the verification, then marks that release Latest. Publishing needs the
repository secret `HF_TOKEN`, a Hugging Face token with write access. See
[docs/deploy.md](docs/deploy.md#publishing-with-publish_spacepy) for what the publish
script does.

## Publishing pandion

The pandion package goes to PyPI on its own schedule, separate from the app's
releases. Like a production release, it needs the owner's explicit yes for that version.

1. Set the version in `packages/pandion/pyproject.toml` and `pandion.__version__`, in a
   PR. A test fails if the two differ.
2. Push a tag named `pandion-v` and that version, on a commit on main:

   ```bash
   git tag pandion-v0.1.0 && git push origin pandion-v0.1.0
   ```

The **Publish pandion** workflow (`.github/workflows/publish-pandion.yml`) then:

1. checks the tag names the package's version;
2. builds the wheel and the source archive;
3. installs that exact wheel in new environments and tests it there
   (`checks/pandion-install/run_check.py --wheel ... --tag ...`);
4. uploads both files to PyPI.

PyPI trusts this workflow through trusted publishing, so no token is stored in the
repo. The publisher on pypi.org names the repo, the file `publish-pandion.yml` and the
`pypi` environment, so renaming either one breaks publishing. A `pandion-v` tag never
counts as an app release, because the app's release tags must start with `v`.

## Recording the Home clips

Home's clips live in `playground/frontend/public/clips/`: `build.webm`, `compare.webm` and
`evaluate.webm`, each with a dark version (`build-dark.webm` and so on) and a `.jpg`
poster for each. On the System theme the page serves the dark file by media query, with
the light one as the fallback; set to Light or Dark, it plays the matching file.

To record them again:

```bash
cd playground/frontend && npm run build && cd ../..
uv run --with playwright==1.55.0 playwright install chromium                                    # once
uv run --with playwright==1.55.0 --with imageio-ffmpeg python scripts/record_clips.py           # all three
uv run --with playwright==1.55.0 --with imageio-ffmpeg python scripts/record_clips.py compare   # one clip
```

- The script starts its own server in demo mode on port 8231 (`--port` changes it), with
  fresh artifact and source folders in a temp folder, and stops that server when done. It
  refuses to start if something already answers on that port, so it never records against
  another server.
- It uses the Chromium that Playwright installed (in `%LOCALAPPDATA%\ms-playwright` on
  Windows). Pin the Playwright package to the version that matches that browser: 1.55.0
  for chromium-1187.
- Each clip has a setup pass that is not recorded, which loads the sample and runs every
  step once, then a recorded pass on warm results, once in the light theme and once in the
  dark. Compare's recorded pass runs its recipes cold, so the run shows. Clips are
  1280x800, except Build at 1440x900 with the Ask panel docked open.
- All three clips call the model, so they need `ANTHROPIC_API_KEY`, from the environment or
  the repo's `.env`. Demo mode ignores the server's key, so the script sends it with every
  call as the `x-anthropic-api-key` header, as the key panel would. It never prints it.
- Build starts from the Balanced template on Manuals and guides, adds the weather station
  manual, shows each step card, then asks in Search and in Chat and ends on an answer that
  marks what the documents do not cover.
  Evaluate writes questions, runs and scores them, changes one setting, compares with the
  best run and opens a miss.
  Compare opens the Rerank step on the primer, runs three rerankers (LLM, MMR and
  cross-encoder) and ends on the lists, where they differ in found and the LLM one shows
  tokens and cost.
- The script calls `mark()` at the start of each part and writes those seconds, per clip and
  theme, to `playground/frontend/src/routes/clipChapters.json`. Home zips them with its chip
  labels, and a test checks the counts match, so change both together.
- Each clip is cut to start once the page has loaded and is encoded to WebM VP9 with the
  ffmpeg that `imageio-ffmpeg` ships, so no system ffmpeg is needed. The pauses in the
  script set the length, 20 to 35 seconds. It prints each clip's length and size, and warns
  above 4 MB. The poster is a screenshot at the clip's telling moment.

## Regenerating the fixtures and the lesson recordings

The web's JSON fixtures in `playground/frontend/src/api/fixtures/` and the lessons'
recorded runs in `playground/frontend/src/learn/` are produced by scripts, never typed by hand:

```bash
uv run python playground/frontend/scripts/export_fixtures.py   # the web fixtures
uv run python scripts/record_e2e_lesson.py           # src/learn/e2e-run.json
uv run python scripts/record_chunking_comparison.py  # src/learn/chunking-strategies.json
uv run python scripts/record_parsing_lab.py          # src/learn/parsing-lab.json
```

- They run on Pandion's public API and on pandion-api, as any app would. Each pipeline
  is a plain pipeline dict, run by `scripts/lesson_runs.py`: `run_pipeline` indexes a
  PDF (and asks a question) and returns each step's stored result by its step name, and
  `evaluate_pipeline` is `pandion.evaluate` as plain JSON.
- `export_fixtures.py` reads `registry.json` from the app's `GET /api/v2/strategies`, and
  writes `run_events.json` from a `POST /runs` on a pandion-api test client, so the events
  name each step (`step`, `document`) as `/api/v2` sends them. The fixtures run on the
  `fake-deterministic` embedder, so they need no model. A web test that reads a field the
  server no longer sends fails, and is updated to the field it now sends.
- The three lesson recordings need the Docling, RapidOCR and Qwen3 models, which download
  on first use. Run again on the same machine with the same models, a recording leaves its
  file as it is, so `git diff playground/frontend/src/learn` stays empty. The parsing lab is the one
  exception: it records the date and each parse's time in milliseconds, and those change
  on every run. If any other number moves, a setting differs between the old run and the
  new one; fix the pipeline dict until it matches.

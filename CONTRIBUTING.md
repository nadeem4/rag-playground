# Contributing

How to set up RAG Playground for development, run the tests, add a strategy, cut a
release and record the Home clips. For how the code fits together, see
[docs/architecture.md](docs/architecture.md).

## Contents

- [Development setup](#development-setup)
- [Running the tests](#running-the-tests)
- [Styling and fixtures](#styling-and-fixtures)
- [Adding a strategy](#adding-a-strategy)
- [The samples](#the-samples)
- [Staging](#staging)
- [Cutting a release](#cutting-a-release)
- [Recording the Home clips](#recording-the-home-clips)

## Development setup

You need [uv](https://docs.astral.sh/uv/) (Python 3.13) and Node.js 22 or newer.

```bash
git clone https://github.com/nadeem4/rag-playground.git && cd rag-playground
uv sync --extra dev
cd web && npm install && cd ..
```

To work on the web app, run the server in one terminal and Vite in another:

```bash
uv run rag-playground --no-browser --reload
cd web && npm run dev
```

Then open http://localhost:5173. Vite proxies `/api` to the server on 127.0.0.1:8000.
`--reload` restarts the server when a Python file changes.

`cd web && npm run build` writes `web/dist`, which the Python server serves on
http://127.0.0.1:8000.

## Running the tests

```bash
uv run pytest                 # the fast suite, no model downloads
uv run pytest -m models       # the slow tests that load Docling, Qwen3 and bge
cd web && npm test            # Vitest
```

The smoke test drives the real app in a real browser. It starts its own demo server on a
free port, builds the index, asks a question, runs Compare and Evaluate, then opens every
page at 1440 and 390 px in light and dark. A page that scrolls sideways or logs an error
fails it. It needs the models and a web build, and takes about two minutes:

```bash
uv run --with playwright==1.55.0 playwright install chromium   # once
cd web && npm run build && cd ..
uv run --with playwright==1.55.0 pytest -m smoke
```

The tests run on every push and pull request to `main` (`.github/workflows/ci.yml`): the
Python suite, then the web tests and a web build. The `models` and `smoke` tests run in
their own workflow, **Release checks** (`.github/workflows/release-checks.yml`), on
GitHub's machine with the models cached between runs. Publishing to production runs it on
the tag first. You can run it for any branch, tag or commit:

```bash
gh workflow run "Release checks" -f ref=feat/some-branch
```

Follow test-driven development: write the failing test first, then the code.

## Styling and fixtures

- Every colour, size and radius is a token in `web/src/styles/tokens.css`. Tailwind's
  default scales are cleared, so values that are not tokens do not compile. Text sizes are
  in rem, so they follow the browser's font size.
- The typefaces are self-hosted from npm: Atkinson Hyperlegible Next for the interface,
  Source Serif 4 for the document's own words, and JetBrains Mono for numbers and ids. No
  font is fetched from the network at run time.
- The **Dev** menu in the header opens the component inspectors and a token specimen
  page. It is hidden in demo mode.
- The web tests use JSON fixtures generated from the real engine. Regenerate them with
  `uv run python web/scripts/export_fixtures.py`.

## Adding a strategy

A strategy is one Python module. The web app builds its settings form from the config
model, so a new strategy needs no frontend change.

1. Create `plugins/<stage>/<name>.py` with a Pydantic config model and a `Transform`
   subclass decorated with `@register`. Give every config field a default. Give the class:
   - a `summary` of how the strategy works, in one or two plain sentences;
   - an `explain(config)` that says what these settings will do. Every number, switch and
     choice must change the explanation, unless it is listed in `EXPLAIN_EXEMPT` with a
     comment saying why;
   - for a chunk strategy, `learn`: a one-sentence `hint` and more paragraphs for the
     strategy itself (the key `_strategy`) and for every setting. Build shows them;
   - if it needs something from the step above it, `requires`, keyed by input port, for
     example `{"index": {"backends": ["fts"]}}`, and `provides` on the producer, for
     example `{"backends": ["dense", "fts"]}`. An unmet requirement is a hard lock: the
     graph is rejected, and the app greys the option out and blocks Run. A step whose
     input and output are the same kind of artifact, such as a Clean step, passes on what
     the step above it provides;
   - if it runs without something but degrades, `prefers`, in the same shape, with a
     one-sentence `fallback` saying what happens instead. That is a soft lock: the option
     stays selectable, tagged "Falls back";
   - `deterministic = False` if its output can change between runs (a model call), and
     `cacheable = False` if its output should never be reused, as for chat answers.
2. Add the module to `PLUGIN_MODULES` in `plugins/__init__.py`. A test fails if a plugin
   module exists but is not listed.
3. Run `uv run pytest`. The contract suite (`tests/contract/`) checks every plugin,
   including that the artifact id is deterministic, that the config round-trips through
   JSON, that the explanation changes with each setting, and, for a chunk strategy, that
   `learn` covers every setting in full sentences with no dashes.
4. Describe it in [docs/strategies.md](docs/strategies.md) and add it to the table in the
   README.

`plugins/clean/drop_matching.py` is a small, complete example.

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
as the Space variable `RAG_PLAYGROUND_COMMIT`).

## Cutting a release

Production, the public demo, is published **only with the owner's explicit approval**.
Every release goes through staging first, and the production workflow refuses anything
else. The flow:

1. **Merge to `main`.** Staging updates itself and verifies the new build. A verified
   commit gets the GitHub commit status `staging` = success.
2. **Bump the version** in `pyproject.toml` (`version = "X.Y.Z"`), run `uv lock` so the
   project's own entry in `uv.lock` matches, and merge it as `chore: version X.Y.Z`.
   Staging publishes that commit too. Test it there.
3. **Tag that commit and record the release** as a pre-release, which means "not live
   yet":

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   gh release create vX.Y.Z --verify-tag --prerelease --title vX.Y.Z --notes-file notes.md
   ```

4. **Ask the owner.** Nothing goes to production without their go-ahead.
5. **Publish to production:**

   ```bash
   gh workflow run "Publish the Hugging Face Space" -f tag=vX.Y.Z
   ```

   The workflow (`.github/workflows/publish-space.yml`) takes the tag through these gates
   in order, and stops at the first that fails:

   1. **The production gate** (`scripts/release_gate.py`). Only a plain `vX.Y.Z` tag. The
      tag's commit must have the passing `staging` status, or the run stops with "Publish
      this commit to staging and test it first."
   2. **Release checks** on the tag: the model tests and the smoke test.
   3. **Approval.** The publish job uses the GitHub environment `production`, which has the
      owner as required reviewer, so it waits until the owner approves it on the run's
      page.
   4. **Publish and verify.** It runs `scripts/publish_space.py --repo
      nadeem4nk/rag-playground --commit <sha>`, then `scripts/verify_space.py`, which waits
      until the Space runs the tag's commit, checks the home page answers 200, and checks a
      Home clip is a real video, not a 131-byte Git LFS pointer (a pointer means the
      Space's `.gitattributes` lost its LFS rules, and every clip plays blank).
   5. **Mark it Latest.** The tag's GitHub release becomes a full release and **Latest**,
      so Latest always names what the demo runs.

   Publishing an older release tag rolls the demo back the same way. It needs a repository
   secret named `HF_TOKEN`, a Hugging Face token with write access. See
   [docs/deploy.md](docs/deploy.md#publishing-with-publish_spacepy) for what the script
   does.

## Recording the Home clips

Home's clips live in `web/public/clips/`: `build.webm`, `compare.webm` and
`evaluate.webm`, each with a dark version (`build-dark.webm` and so on) and a `.jpg`
poster for each. On the System theme the page serves the dark file by media query, with
the light one as the fallback; set to Light or Dark, it plays the matching file.

To record them again:

```bash
cd web && npm run build && cd ..
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
  dark. Clips are 1280x800, except Build at 1440x900 with the Ask panel docked open at
  698 px so the slope shows.
- Build builds the index, asks with the cross-encoder and ends on the rerank slope.
  Compare shows the setup cards, runs three recipes and ends on the finding sentence.
  Evaluate scores the pipeline, scores it again with Parse set to Fast text and opens a
  miss.
- Each clip is cut to start once the page has loaded and is encoded to WebM VP9 with the
  ffmpeg that `imageio-ffmpeg` ships, so no system ffmpeg is needed. The pauses in the
  script set the length, 8 to 15 seconds. It prints each clip's length and size, and warns
  above 1.5 MB. The poster is a screenshot at the clip's telling moment.

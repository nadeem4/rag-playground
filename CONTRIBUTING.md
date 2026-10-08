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

The tests run on every push and pull request to `main` (`.github/workflows/ci.yml`): the
Python suite, then the web tests and a web build.

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

## Cutting a release

Tagging a release and putting it live are two separate steps. A tag records a version;
the hosted demo changes only when you publish a tag to it.

1. **Bump the version** in `pyproject.toml` (`version = "X.Y.Z"`), then run `uv lock` so
   the project's own entry in `uv.lock` matches. Commit both as `chore: version X.Y.Z`.
2. **Tag, push and record the release** as a pre-release, which means "not live yet":

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   gh release create vX.Y.Z --verify-tag --prerelease --title vX.Y.Z --notes-file notes.md
   ```

   Nothing on the demo changes. Tags can pile up during the week.
3. **Publish the tag you choose** to the demo:

   ```bash
   gh workflow run "Publish the Hugging Face Space" -f tag=vX.Y.Z
   ```

   The workflow (`.github/workflows/publish-space.yml`) checks out that tag and runs
   `scripts/publish_space.py --repo nadeem4nk/rag-playground`, which publishes the files
   committed at the tag to the Space with demo mode on. Then it marks that tag's GitHub
   release as a full release and **Latest**, so Latest always names what the demo runs.
   Publishing an older tag rolls the demo back the same way. It needs a repository secret
   named `HF_TOKEN`, a Hugging Face token with write access; without it the job does
   nothing. It can also be started from the Actions tab. See
   [docs/deploy.md](docs/deploy.md#publishing-with-publish_spacepy) for what the script
   does.
4. **Check the Space** once its build is done:
   - The stage is `RUNNING`:

     ```bash
     curl -s https://huggingface.co/api/spaces/nadeem4nk/rag-playground/runtime
     ```

   - The home page returns 200:

     ```bash
     curl -s -o /dev/null -w "%{http_code}\n" https://nadeem4nk-rag-playground.hf.space/
     ```

   - A clip comes back at full size, hundreds of kilobytes, not a 131-byte Git LFS
     pointer:

     ```bash
     curl -s -o /dev/null -w "%{http_code} %{size_download}\n" https://nadeem4nk-rag-playground.hf.space/clips/build.webm
     ```

     A pointer means the Space's `.gitattributes` lost its LFS rules, and every clip plays
     blank.

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

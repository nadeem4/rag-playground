# Release runbook

How a change reaches staging, how the app is released, how Pandion goes to PyPI, and how the Home clips and fixtures are recorded. App release tags are `vX.Y.Z`. Pandion release tags are `pandion-vX.Y.Z`. In every command below, `X.Y.Z` stands for the version you are working with.

For development setup and tests, see [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Contents

- [Staging](#staging)
- [Releasing](#releasing)
- [Publishing pandion](#publishing-pandion)
- [Recording the Home clips](#recording-the-home-clips)
- [Regenerating the fixtures and the lesson recordings](#regenerating-the-fixtures-and-the-lesson-recordings)

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
release tag plus the commit, such as `vX.Y.Z+abc1234`.

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
gh workflow run "Publish the Hugging Face Space" --ref vX.Y.Z -f tag=vX.Y.Z
```

It runs the same gate (a plain release tag that passed staging), the release checks, the
publish and the verification, then marks that release Latest. Publishing needs the
repository secret `HF_TOKEN`, a Hugging Face token with write access. See
[deploy.md](deploy.md#publishing-with-publish_spacepy) for what the publish
script does.

## Publishing pandion

The pandion package goes to PyPI on its own schedule, separate from the app's
releases. Like a production release, it needs the owner's explicit yes for that version.

1. Set the version in `packages/pandion/pyproject.toml` and `pandion.__version__`, in a
   PR. A test fails if the two differ.
2. Push a tag named `pandion-v` and that version, on a commit on main:

   ```bash
   git tag pandion-vX.Y.Z && git push origin pandion-vX.Y.Z
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

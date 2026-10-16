# The playground backend

This folder is the playground's Python server, imported as `playground.backend`. It is
[pandion-api](../../packages/pandion-api/README.md) with the playground's rules, plus a few
routes and files only the playground needs. [The playground README](../README.md) explains
how it fits with the frontend.

## The modules

- `main.py` builds the app. `create_app` calls `pandion_api.create_app` with
  `PlaygroundPolicy`, which mounts pandion-api's routes under `/api/v2`. It then adds the
  playground's own routes under `/api` and serves the built frontend last.
  `playground.backend.main:app` is the app uvicorn runs.
- `policy.py` holds `PlaygroundPolicy`, the demo's rules as a pandion-api `Policy`. It
  decides who may read a document, checks each upload and each page fetched from a link
  (with a per-browser limit on links an hour), refuses a custom model endpoint on
  the demo, refuses a changed prompt or model revision, and caps the work one run can ask
  for. [docs/pandion-api.md](../../docs/pandion-api.md#the-playground-on-pandion-api) lists
  every rule.
- `demo.py` is demo mode, switched on by `RAG_PLAYGROUND_DEMO=1`. It holds the demo's
  limits: the upload size, pages and count, the lower caps for files that are not PDFs
  (bytes, a zip's unpacked size and parts, an image's pixels), the links a browser may
  ask for in an hour, the runs that may work at once, and the
  questions a run may ask.
- `visitor.py` gives each browser an anonymous id in a cookie. On the demo, that id is
  what keeps a visitor's uploads and runs their own. There is no login.
- `expiry.py` deletes demo uploads a day after they arrive. It never touches a sample.
- `sample_set.py` reads the bundled samples in `samples/`, each with its card, its PDF and
  its questions. A broken sample folder stops the server at startup.
- `static.py` serves the built frontend from `playground/frontend/dist`, and sends a page route the
  browser asks for to `index.html`. An unknown `/api` path stays a JSON 404.
- `warmup.py` loads the first models a run needs in a background thread, so they are
  likely ready when someone presses Run.
- `credentials.py` decides where each provider's API key comes from: the request, then
  the environment, then `.env`. On the demo, only the request.
- `cli.py` is the `rag-playground` command. It starts uvicorn and opens a browser on
  localhost.
- `deps.py` says where the playground keeps its files: the sources and artifacts folders,
  and the web build. It also holds the model settings the app runs with.
- `stage_copy.py` holds the playground's plain words for each step, which the Build page
  shows.
- `routes/` holds the playground-only routes, all under `/api`:
  - `samples.py`: the sample list and each sample's questions.
  - `learn.py`: the data for the lessons.
  - `questions.py`: the question set template to fill in.
  - `templates.py`: `GET /api/templates`, Pandion's pipeline templates
    (`pandion.list_templates`), each with its metadata and pipeline part.
  - `settings.py`: whether demo mode is on, and its limits.
  - `project.py`: `POST /api/project.zip`, Take it home. It writes the pipeline as a
    project with `pandion.new_project` in a temporary folder and returns it as a zip;
    `?preview=1` returns the same files as JSON. No key, document or server path goes in.
  - `health.py`: whether the app is up, and which commit and version it runs.
  - `registry.py`: `GET /api/stages`, what each step is for. Its `served_catalog` also hides read-only and test-only settings from the strategy list pandion-api serves.
  - `sources.py`: adds a sample to the store like an upload, and holds the helpers for
    the demo's upload records.

## The rule: public Pandion and pandion-api only

The backend imports only Pandion's public API and pandion-api. It never reaches into a
private Pandion module or name. `tests/integration/test_package_boundary.py` fails on any
other Pandion import, and there is no allow-list. If the backend needs a name that is not
public, make it public in Pandion first.

The backend's tests are in `tests/api/`.

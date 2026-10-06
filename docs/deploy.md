# Deploy

How to run RAG Playground on your machine, in Docker, or as your own Hugging Face Space,
and what demo mode changes.

## Contents

- [Run it with uv](#run-it-with-uv)
- [Run it with Docker](#run-it-with-docker)
- [Demo mode](#demo-mode)
- [Variables and secrets](#variables-and-secrets)
- [Your own Hugging Face Space](#your-own-hugging-face-space)
- [Publishing with publish_space.py](#publishing-with-publish_spacepy)

## Run it with uv

You need [uv](https://docs.astral.sh/uv/), which fetches Python 3.13 if you do not have
it, Node.js 22 or newer to build the web app once, and about 2 GB of disk for the models.

```bash
git clone https://github.com/nadeem4/rag-playground.git && cd rag-playground
cd web && npm install && npm run build && cd ..
uv run rag-playground
```

The server starts on http://127.0.0.1:8000 and opens your browser. `rag-playground` takes
these options:

| Option | Effect |
|---|---|
| `--port 8080` | Use another port. Without it, the `PORT` environment variable is used if set, else 8000. |
| `--host 0.0.0.0` | Listen on another interface. Without it, `RAG_PLAYGROUND_HOST` is used if set, else 127.0.0.1. A browser opens only when the host is `127.0.0.1`, `localhost` or `::1`. |
| `--no-browser` | Do not open a browser tab. |
| `--reload` | Restart the server when Python files change, for development. |

`--host 0.0.0.0` makes the playground reachable from other machines on your network. It
has no sign in, so only do that on a network you trust.

## Run it with Docker

Docker runs the whole thing without installing Python or Node. From the cloned folder:

```bash
docker build -t rag-playground .
docker run --rm -p 127.0.0.1:8000:8000 -v rag-playground-data:/data rag-playground
```

Then open http://localhost:8000.

The image builds the web app with Node 22, then installs the Python server on Python 3.13
with CPU-only PyTorch. The first build takes a while, and the first run of each model
downloads it. Models, uploads and cached results live under `/data` in the container, so
the named volume keeps them across runs. The container runs as a user named `app`, and
does not turn on demo mode.

### Docker Compose

`docker-compose.yml` does the same with one command, and publishes the port on
`127.0.0.1` only, because the playground has no sign in:

```bash
docker compose up --build
```

- **Keys:** put `ANTHROPIC_API_KEY=...`, `OPENAI_API_KEY=...`, `OPENROUTER_API_KEY=...` or
  `OPENAI_COMPATIBLE_API_KEY=...` in a `.env` file next to `docker-compose.yml` (copy
  `.env.example`). Compose passes them to the container when it starts. They are never
  copied into the image, and it works without a `.env` at all.
- **Another port:** `RAG_PLAYGROUND_PORT=8080 docker compose up` serves it on
  http://localhost:8080.
- **Data:** a named volume holds `/data`. It survives `docker compose down` and rebuilds.
  To delete it, run `docker compose down -v`.

## Demo mode

Demo mode is for a public host that strangers share, such as the Hugging Face Space. It is
on when `RAG_PLAYGROUND_DEMO` is exactly `1`. The playground has no sign in, so demo mode
turns off what is unsafe to share.

**Private, bounded uploads.**

- The server gives each browser an anonymous `rag_visitor` cookie. An upload belongs to
  that browser: no other visitor can list it, see its pages or run on it. Clearing
  cookies loses access to your uploads.
- Uploads are PDFs only, up to 10 MB and 20 pages each, and 3 live files per browser. All
  live uploads together are capped at 200 MB, so the shared disk cannot fill up.
- An upload is deleted 24 hours after it was made. A sweep checks once an hour.
- The bundled samples stay public, and cannot be deleted. They are put back in the store
  each time the server starts, so a restart never loses one.
- A question set uploaded for Evaluate is checked and not kept.
- Page images of an upload are sent as private, so shared caches do not keep them.

**No server keys.** Every key, for every provider, comes only from the request header,
that is, a key the visitor types in the app. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`OPENROUTER_API_KEY` and `OPENAI_COMPATIBLE_API_KEY` in the environment or in `.env` are
ignored, so visitors can never spend the host's keys. Missing-key messages on the demo
never tell a visitor to set a server variable.

**No custom endpoints.** A run or a Compare run with a chat, LLM rerank or LLM rewrite step
set to the custom model is refused with 403, and so is checking a custom endpoint's key:
the server would otherwise send a request to any URL a visitor chose. Behind that, every
model call checks a custom base URL before it is made: on the demo it must be a public
https address on port 443, whose name resolves only to public addresses, and the client
does not follow redirects. The app also leaves "Custom (OpenAI-compatible)" out of every
model choice and the Custom endpoint row out of the key panel. OpenRouter is not a custom
endpoint: its address is fixed, so it works on the demo with a visitor's own key.

**No Dev menu.** The header's Dev menu, with the component inspectors and the token
specimen page, is hidden.

`GET /api/settings/app` returns `{"demo": true, "limits": {...}}` in demo mode, so the app
can say so and state the limits, and `{"demo": false}` otherwise.

With demo mode off, none of this applies: there are no upload limits and no expiry, every
upload is visible to every visitor, server keys are used, custom endpoints such as Ollama
on localhost work, question sets are kept beside their document, and the Dev menu shows.

## Variables and secrets

| Variable | Default | What it does |
|---|---|---|
| `RAG_PLAYGROUND_DEMO` | unset | `1` turns on demo mode. Any other value leaves it off. |
| `PORT` | `8000` | The port, when `--port` is not given. |
| `RAG_PLAYGROUND_HOST` | `127.0.0.1` | The interface, when `--host` is not given. |
| `RAG_PLAYGROUND_SOURCES` | `sources/` in the repo | Where uploads and uploaded question sets are kept. `/data/sources` in Docker. |
| `RAG_PLAYGROUND_ARTIFACTS` | `artifacts/` in the repo | Where cached run results are kept. `/data/artifacts` in Docker. |
| `RAG_PLAYGROUND_EMBED_CACHE` | `.embcache` in the artifacts folder | Where the embedding cache is kept. |
| `HF_HOME` | `~/.cache/huggingface` | Hugging Face's own variable: where models are downloaded. `/data/hf` in Docker. |
| `RAG_PLAYGROUND_PORT` | `8000` | Docker Compose only: the port published on your machine. |

Secrets, each optional and used only with demo mode off:

| Secret | Provider |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic |
| `OPENAI_API_KEY` | OpenAI |
| `OPENROUTER_API_KEY` | OpenRouter |
| `OPENAI_COMPATIBLE_API_KEY` | A custom OpenAI-compatible endpoint |

Locally, put them in the environment or in `.env`; see
[models-and-keys.md](models-and-keys.md#adding-a-key). On a Space, add them as secrets.

`sources/`, `artifacts/` and `.env` are gitignored. `DELETE /api/cache` clears the cached
run results.

## Your own Hugging Face Space

The demo is a Docker Space. Its README is this repo's README with a header that tells
Hugging Face to build the `Dockerfile` and serve port 8000.

### Duplicate the Space

1. Open the [Space](https://huggingface.co/spaces/nadeem4nk/rag-playground) and choose
   **Duplicate this Space** from its menu.
2. Pick an owner, a name, whether it is public or private, and the hardware.
3. In the copy's **Settings**, under variables and secrets:
   - `RAG_PLAYGROUND_DEMO` is `1`, copied from the demo. Set it to `0` to turn demo mode
     off (see [Demo mode](#demo-mode) for what changes), or leave it at `1`.
   - Optionally add `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY` as
     secrets. They are used only with demo mode off.
4. The Space rebuilds and restarts after a change to its settings.

With demo mode off, the copy has no sign in and every visitor sees every upload. Anyone
who can open it can run chat on your keys. If you add keys or upload private files, make
the Space private.

### Hardware

- **The free CPU Space works.** Docling parsing is slow on it, and so is the first run of
  each model, which downloads it. Fast text, the chunkers, search and the small
  cross-encoder are quick.
- **A larger CPU** makes Docling and the embedder faster.
- **A GPU does not help:** the image installs CPU-only PyTorch.

### Storage

Without persistent storage, the Space's disk starts empty on every restart: uploads, the
run cache and the downloaded models are gone, and the models download again on the first
run. The demo runs this way, and its privacy page says so.

The image keeps everything under `/data`, which is where Hugging Face mounts persistent
storage. Turning it on for your copy keeps uploads, the cache and the models across
restarts. On a copy with demo mode on, it also makes the privacy page's line about run
results being gone after a restart untrue.

### Keep a copy updated

A duplicated Space is a separate repo. It does not follow the demo. To bring it up to
date, either:

- duplicate the demo again, and set the variables and secrets again; or
- publish from a clone of the GitHub repo with `scripts/publish_space.py`, below.

## Publishing with publish_space.py

`scripts/publish_space.py` publishes the files committed at `HEAD` to a Space:

```bash
hf auth login
uv run --no-sync python scripts/publish_space.py --repo <user>/rag-playground --dry-run
uv run --no-sync python scripts/publish_space.py --repo <user>/rag-playground
```

- `--dry-run` lists what would be published and stops.
- Only files committed at `HEAD` are published (`git archive`), so `sources/`,
  `artifacts/` and `.env` can never go up. A file no longer at `HEAD` is deleted from the
  Space.
- The Space copy differs from the repo in two places: the README starts with the header
  Spaces need, and `.gitattributes` gains Git LFS rules for binaries (videos, images,
  PDFs, fonts), so the Space's build gets real files instead of LFS pointers.
- It creates the Space if it does not exist, and sets the variable `RAG_PLAYGROUND_DEMO`
  to `1`. **On a copy where you turned demo mode off, set it back to `0` after each
  publish.**

The project's own demo is published by a GitHub workflow when a version tag is pushed. See
[CONTRIBUTING.md](../CONTRIBUTING.md#cutting-a-release).

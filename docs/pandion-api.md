# pandion-api

pandion-api serves Pandion over HTTP. Every endpoint that takes a pipeline takes the
pipeline file's shape as JSON, the same dict `Pipeline.from_dict` reads, so a pipeline is
written one way everywhere: in a YAML file, in code, in a request and in a browser.
Everything a particular site wants to limit (who may read a document, how big an upload
may be, how many runs may work at once) is one `Policy` object. The default allows
everything.

It lives in this repository as a workspace package (`packages/pandion-api/`) and is not
on PyPI yet. RAG Playground's server is pandion-api with the playground's own `Policy`,
plus the playground's teaching routes.

## Contents

- [Run it](#run-it)
- [Where it keeps files](#where-it-keeps-files)
- [Endpoints](#endpoints)
- [Site rules: the Policy](#site-rules-the-policy)
- [What a request cannot set](#what-a-request-cannot-set)
- [Errors](#errors)

## Run it

```python
# serve.py
from pathlib import Path

from pandion_api import ApiSettings, create_app

app = create_app(ApiSettings(data_dir=Path("./pandion-data")))
```

```bash
uvicorn serve:app
```

`ApiSettings` takes `data_dir` (the one folder every request runs under), `models` (a
`pandion.ModelSettings`: the model folder, `download` and the device), `prefix` (where the
routes are mounted, for example `/api/v2`) and `title`.

## Where it keeps files

Every pipeline a request sends runs with `data_dir` as its `path`, so Pandion keeps
`sources/` (each document once, by its fingerprint), `artifacts/` (every step's result)
and `embeddings/` (the embedding cache) there. pandion-api keeps each document's record
in `sources/.meta/` and its question set in `sources/questions/`.

## Endpoints

| Method and path | Does |
|---|---|
| `GET /health` | `{"status": "ok", "pandion": <version>, "pandion_api": <version>}` |

## Site rules: the Policy

Subclass `pandion_api.Policy` and override what your site needs. A method that refuses
raises `fastapi.HTTPException` with the status and the sentence the caller should see.

| Method | Default | Called |
|---|---|---|
| `dependencies()` | `[]` | FastAPI dependencies run on every route |
| `on_startup(app)`, `on_shutdown(app)` | nothing | once each, around serving |

## What a request cannot set

## Errors

# pandion-api example

[pandion-api](../../packages/pandion-api/README.md) serves Pandion over HTTP. You send a
pipeline as JSON, upload documents, start runs and read their results, all with plain
web requests.

Use Pandion directly when your code is Python and runs in one place. Use pandion-api when
the code that needs Pandion is not Python, when a web app calls it from a browser, or when
several clients share one server, one set of documents and one cache.

This folder has two scripts:

- `serve.py` starts pandion-api on its own, with the default Policy, which allows
  everything. Its routes are under `/api/v2`, and it keeps every file in `pandion-data/`
  next to the script. Git ignores that folder.
- `run_pipeline.py` is a client written with `httpx`. It checks the pipeline in
  [`../pandion/cli.yaml`](../pandion/cli.yaml), uploads the bundled
  `chunking-primer.pdf`, indexes it while it follows the run's events, asks one question
  and prints the top hits, then evaluates the pipeline on the sample's question set and
  prints the score. The pipeline uses the fake embedder, so nothing downloads. Its scores
  mean little; it is for trying things out.

## Run it

From the root of the repo, start the server in one terminal:

```bash
uv run python examples/pandion-api/serve.py --port 8000
```

Then run the client in another:

```bash
uv run python examples/pandion-api/run_pipeline.py --url http://127.0.0.1:8000
```

To run a pair of [pipeline templates](../../docs/pandion.md#templates) instead, pass
an index template and a query template. The client then uploads the sample that suits
the index template, asks that sample's first question and evaluates on its question
set. The server downloads the models the templates use on the first run. A template that
needs an API key is refused, because this client sends none. The `web` index template is
refused too, because it has no sample to upload:

```bash
uv run python examples/pandion-api/run_pipeline.py --url http://127.0.0.1:8000 --template tables precision
```

`run_pipeline.py` needs `httpx`. In this repo it is already installed. Elsewhere, run
`pip install httpx`. Stop the server with Ctrl+C.

## The same steps with curl

These run from the root of the repo in a bash shell, against the server above. They use
`uv run python` only to pick one value out of a JSON reply.

```bash
API=http://127.0.0.1:8000/api/v2
PIPELINE='{"index": {"parse": {"use": "pdfium"}, "clean": [{"use": "dedupe_blocks"}],
  "chunk": {"use": "recursive_character", "chunk_size": 400, "chunk_overlap": 40},
  "embed": {"use": "fake-deterministic"}, "store": {"use": "lancedb"}},
  "retrieve": {"search": {"use": "hybrid_rrf", "top_k": 20}, "rerank": [{"use": "mmr", "top_k": 5}]},
  "answer": {"use": "search", "top_k": 3}}'
pick() { uv run python -c "import json, sys; v = json.load(sys.stdin)['$1']; print(v if isinstance(v, str) else json.dumps(v, indent=1))"; }

# Check the pipeline.
curl -s -X POST $API/pipelines/validate -H "Content-Type: application/json" -d "{\"config\": $PIPELINE}"

# Upload the document and keep its id.
SHA=$(curl -s -F "file=@samples/chunking-primer/chunking-primer.pdf;type=application/pdf" $API/documents | pick sha)

# Index it, and follow the run's events to the end.
RUN=$(curl -s -X POST $API/runs -H "Content-Type: application/json" \
  -d "{\"config\": $PIPELINE, \"documents\": [\"$SHA\"]}" | pick run_id)
curl -s -N $API/runs/$RUN/events

# Ask a question, then read the hits in the run's result.
RUN=$(curl -s -X POST $API/ask -H "Content-Type: application/json" \
  -d "{\"config\": $PIPELINE, \"documents\": [\"$SHA\"], \"question\": \"How big should a chunk be?\"}" | pick run_id)
curl -s -N $API/runs/$RUN/events > /dev/null
curl -s $API/runs/$RUN | pick result

# Evaluate with the sample's question set, then read the score.
RUN=$(curl -s -X POST $API/evaluations -H "Content-Type: application/json" \
  -d "{\"config\": $PIPELINE, \"documents\": [\"$SHA\"], \"questions\": $(cat samples/chunking-primer/questions.json)}" | pick run_id)
curl -s -N $API/runs/$RUN/events > /dev/null
curl -s $API/runs/$RUN | pick result
```

Every run answers 202 with a `run_id`. Its events stream from `/runs/{run_id}/events`
and end with `stream_end`. `/runs/{run_id}` then holds the result.

## Add your own rules

The default Policy allows everything. To set your site's rules, subclass `Policy`,
override only the methods you need, and pass it to `create_app`. A method refuses by
raising `HTTPException`. This one refuses uploads over 5 MB:

```python
from pathlib import Path

from fastapi import HTTPException, Request, UploadFile

from pandion_api import ApiSettings, Policy, create_app

LIMIT = 5 * 1024 * 1024


class SmallUploads(Policy):
    async def check_upload(self, file: UploadFile, request: Request) -> bytes:
        data = await file.read(LIMIT + 1)  # never read more than you accept
        if len(data) > LIMIT:
            raise HTTPException(status_code=413, detail="Uploads may be at most 5 MB.")
        return data


app = create_app(ApiSettings(data_dir=Path("./pandion-data"), prefix="/api/v2"), SmallUploads())
```

Every hook is listed in [docs/pandion-api.md](../../docs/pandion-api.md#site-rules-the-policy).
For a full, real Policy, read
[`playground/backend/policy.py`](../../playground/backend/policy.py), the rules of RAG
Playground's hosted demo.

## Tested

[`tests/integration/test_pandion_api_example.py`](../../tests/integration/test_pandion_api_example.py)
runs `run_pipeline.py` against `serve.py`'s app in-process, so this example cannot go
out of date.

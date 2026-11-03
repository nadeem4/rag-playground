# Configuration

Every setting that comes from the environment or from code, in one place. A test (`tests/test_configuration_doc.py`) fails if the code reads a `RAG_PLAYGROUND_*` or `PANDION_*` variable that is not in a table on this page, so this page stays true.

## Contents

- [Environment variables](#environment-variables)
- [Provider keys](#provider-keys)
- [Release and publish tools](#release-and-publish-tools)
- [Serve mode settings in code](#serve-mode-settings-in-code)
- [Settings the app passes to pandion-api](#settings-the-app-passes-to-pandion-api)

## Environment variables

| Variable | Read by | Default | What it does | More |
|---|---|---|---|---|
| `RAG_PLAYGROUND_DEMO` | the app | unset | `1` turns on demo mode. Any other value leaves it off. | [deploy](deploy.md#demo-mode) |
| `RAG_PLAYGROUND_HOST` | the app | `127.0.0.1` | The interface to listen on, when `--host` is not given. | [deploy](deploy.md#run-it-with-uv) |
| `RAG_PLAYGROUND_SOURCES` | the app | `sources/` in the repo | Where uploads and uploaded question sets are kept. `/data/sources` in Docker. | [deploy](deploy.md#variables-and-secrets) |
| `RAG_PLAYGROUND_ARTIFACTS` | the app | `artifacts/` in the repo | Where cached run results are kept. `/data/artifacts` in Docker. | [deploy](deploy.md#variables-and-secrets) |
| `RAG_PLAYGROUND_PORT` | Docker Compose | `8000` | The port published on your machine. | [deploy](deploy.md#run-it-with-docker) |
| `RAG_PLAYGROUND_COMMIT` | the app | empty | The commit a Space was published from. `scripts/publish_space.py --commit` sets it. `/api/health` reports it. | [release](release.md#staging) |
| `RAG_PLAYGROUND_VERSION` | the app | the installed package version | The release tag a Space was published from. `scripts/publish_space.py --version` sets it. `/api/health` reports it. | [release](release.md#staging) |
| `PANDION_CONVERSATIONS_URL` | pandion-api serve mode | unset | A SQLAlchemy url for the conversation and trace store. Without it, serve mode uses a SQLite file in the data folder. | [serve mode](../pandion-api/serve-mode.md#your-users-data) |
| `PANDION_LOG_CONTENT` | pandion-api serve mode | unset | `true` adds the question and the answer to the turn log and to trace span attributes. Without it, they are not logged. | [serve mode](../pandion-api/serve-mode.md#logs-and-traces) |
| `PORT` | the app | `8000` | The port, when `--port` is not given. | [deploy](deploy.md#run-it-with-uv) |
| `HF_HOME` | Hugging Face libraries | `~/.cache/huggingface` | Where models are downloaded. `/data/hf` in Docker. This is Hugging Face's own variable. | [deploy](deploy.md#variables-and-secrets) |

The sources and artifacts folders must sit side by side in one folder, named `sources` and `artifacts`. The server refuses to start otherwise.

## Provider keys

Each key is optional. The app reads it from the environment, then from `.env` at the repo root. On the hosted demo it reads only the request. The `pandion` command reads the same names from the environment.

| Variable | Provider | More |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic | [models and keys](../app/models-and-keys.md#adding-a-key) |
| `OPENAI_API_KEY` | OpenAI | [models and keys](../app/models-and-keys.md#adding-a-key) |
| `OPENROUTER_API_KEY` | OpenRouter | [models and keys](../app/models-and-keys.md#adding-a-key) |
| `OPENAI_COMPATIBLE_API_KEY` | A custom OpenAI-compatible endpoint | [models and keys](../app/models-and-keys.md#adding-a-key) |

## Release and publish tools

These are read by the scripts and workflows in [the release runbook](release.md), not by the running app.

| Variable | Read by | What it does |
|---|---|---|
| `HF_TOKEN` | `scripts/publish_space.py`, `scripts/verify_space.py` | A Hugging Face token. Publishing needs write access. A private Space needs it to be verified. |
| `GITHUB_TOKEN` or `GH_TOKEN` | `scripts/release_gate.py` | Lets the gate read the commit status of staging. |
| `PR_TITLE` | `scripts/check_pr_title.py` | The pull request title to check. The workflow sets it. |
| `ANTHROPIC_API_KEY` | `scripts/record_clips.py` | The key the Home clip recorder sends for Chat. |
| `PANDION_CHECK_VENV` | `checks/pandion-install/` | Internal, CI checks only. The folder of the new environment the install check tests. |
| `PANDION_CHECK_SAMPLES` | `checks/pandion-install/` | Internal, CI checks only. The sample PDFs, joined with the path separator. |

## Serve mode settings in code

Serve mode is set up in code with `pandion_api.ServeSettings`, not with environment variables. The fields and their defaults:

| Field | Default | What it does |
|---|---|---|
| `chat` | `ChatSettings()` | How a turn rewrites, folds and remembers. |
| `retention_days` | `90` | How long a conversation is kept without a new turn. At least 1. |
| `metrics_port` | `None` | The port Prometheus scrapes. `None` turns metrics off. |
| `metrics_on_app` | `False` | Also serve `GET /metrics` on the API port. |
| `turns_per_minute` | `20` | Default turn limit for each user. In memory, per server copy. |
| `active_turns_per_user` | `2` | Turns one user may have running at once. |
| `feedback_per_minute` | `30` | Feedback posts a minute for each user. |
| `feedback_categories` | `()` | The feedback categories the metric may carry as a label. Any other counts as `other`. |
| `max_body_bytes` | `65536` | The largest request body. |
| `turn_deadline_s` | `120.0` | The time one turn may take. |
| `cors_origins` | `()` | Sites allowed to call the API from a browser. Empty means CORS is off. |

Details are in [serve mode](../pandion-api/serve-mode.md#serve-mode-hardened-defaults).

## Settings the app passes to pandion-api

The playground builds one `ApiSettings` in `playground/backend/main.py`: the data folder from the two variables above, models on the CPU, the `/api/v2` prefix and the title "RAG Playground". Another site sets its own. See [the pandion-api reference](../pandion-api/index.md).

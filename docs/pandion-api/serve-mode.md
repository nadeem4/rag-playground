# pandion-api serve mode

This page is part of the [pandion-api reference](../index.md). It covers serve mode: what it serves, who is asking, the hardened defaults, logs, traces, users' data and metrics.

## Serve mode

`create_app` has two modes. The default, `mode="lab"`, is everything above: a client sends a
pipeline with each request. `mode="serve"` is for a site's own users. It loads one pipeline
file once, at startup, and answers `POST /chat`, a one-turn `POST /ask`, and a user's own conversations and memories. No lab route is
mounted, so `/documents`, `/runs`, `/strategies` and the rest are a 404.

```python
from pathlib import Path

from pandion_api import ApiSettings, Policy, ServeSettings, create_app

class MyPolicy(Policy):
    def user_id(self, request):
        return request.state.user  # your own login check sets this

    def roles(self, request):
        return request.state.roles

    def limit(self, request):
        pass  # raise HTTPException(429, "...") to refuse

app = create_app(
    ApiSettings(data_dir=Path("./pandion-data")),
    MyPolicy(),
    mode="serve",
    pipeline="pipeline.yaml",
    conversations=None,           # None: SQL on PANDION_CONVERSATIONS_URL, else a SQLite file in data_dir
    serve=ServeSettings(),        # chat settings, retention_days, metrics_port and the limits below
)
```

Serve refuses to start without a Policy that says who is asking. `create_app` raises a
`ValueError` when the Policy is missing, or when its class does not override all of `user_id`,
`roles` and `limit`; the message names the ones it does not. If one shared identity is what you
want, say so with `Policy.anonymous()`. It is refused when the pipeline file has an `access:`
block, because every caller would be the same person. Lab mode keeps the default Policy.

The index is built beforehand with `pandion sync`, using the same pipeline file and the same
`data_dir`. Serve does not index. At startup it runs one throwaway search so the first user
does not wait for models to load. If that fails, the failure is logged and ignored.

### Who is asking

Serve asks the Policy three more questions on every `/chat` request.

| Method | Default | Called |
|---|---|---|
| `roles(request)` | `None` | the roles of the person asking, matched against the pipeline's `access:` block, so a user only finds what their roles allow. It is never "every role" by default. |
| `user_id(request)` | `"anonymous"` | a stable id. Conversations and memories are kept under it, and another user's conversation id is a 404. The default shares one id between everyone, which suits a demo and no real site. Serve refuses to start with the default. |
| `limit(request)` | allows | before anything runs. Raise `HTTPException(429, "...")` to refuse, for example for a rate limit. |

A Policy is usually a thin check of a signed token your gateway or login service issues, such as a
JWT. [`examples/pandion-api/serve_policy.py`](../../examples/pandion-api/serve_policy.py) shows the
shape with an HMAC-signed token and no extra package.

### Serve mode: hardened defaults

Serve starts safe. Each default below is on until you change it.

| Default | What it does | What turns it off |
|---|---|---|
| Policy required | Startup fails without a Policy that overrides `user_id`, `roles` and `limit`. | `Policy.anonymous()`, on purpose. |
| Generic errors | A caller sees only "Something went wrong. Quote this trace id when you ask for help: ..." The reason is logged at ERROR with the same trace id, under the `pandion_api` logger. A refusal your Policy raises, and a 422 for bad input, keep their own sentence. | Nothing. |
| Keys from the environment | Model keys come only from the server's environment variables. A key header is ignored, and `Policy.key` and `Policy.credentials` are not called. | Nothing. |
| Public endpoints only | A custom model endpoint in the pipeline file must be a public https address, or startup fails. The check resolves DNS, so a host that does not resolve also stops startup. A URL document is held to the same rule. | Nothing. |
| 20 turns a minute | A user past `ServeSettings.turns_per_minute` gets a 429. | A bigger number. |
| 30 feedback posts a minute | A user past `ServeSettings.feedback_per_minute` gets a 429 from `POST /feedback`. | A bigger number. |
| 2 active turns | A user with `ServeSettings.active_turns_per_user` questions being answered gets a 429. | A bigger number. |
| 64 KB request body | A larger body is a 413 before it is parsed. | `ServeSettings.max_body_bytes`. |
| 120 second turn | A turn past `ServeSettings.turn_deadline_s` is cancelled and ends with the generic error. | `ServeSettings.turn_deadline_s`. |
| No docs, no CORS | `/docs`, `/redoc` and `/openapi.json` are a 404. No CORS header is sent. | `ServeSettings.cors_origins`, a list of sites. A `"*"` entry stops startup. |

The limits count in memory, per user id, for one server copy. Under `Policy.anonymous()` every caller shares the id "anonymous", so the default limits (20 turns a minute, 2 active) are server-wide. With several copies, put a shared
limit in `Policy.limit` (a gateway, or Redis). `/health` returns only `{"status": "ok"}` and
`/ready` never says why it is not ready.

### POST /chat

```bash
curl -N http://127.0.0.1:8000/chat \
  -H 'content-type: application/json' \
  -d '{"messages": [{"role": "user", "content": "How long is the notice period?"}], "stream": true}'
```

| Field | Meaning |
|---|---|
| `messages` | 1 to 50 messages, each with a `role` (`user`, `assistant` or `system`) and a `content` of 1 to 8,000 characters. The last one must be from the user, or the answer is a 422. |
| `conversation_id` | Left out, a new conversation starts. Given, the turn continues that conversation. An id that is not this user's is a 404. |
| `stream` | `true` answers as server-sent events. `false` (the default) waits and answers as JSON. |

Only the last message counts. The history is the server's own, kept in the conversation
store, so a client cannot write it. Earlier messages in the request are ignored.

Without `stream`, the answer is `200` with `conversation_id`, `trace_id`, `text`, `sources`
(each with an `id`, a `document`, its `pages` and a `score`, and never the text) and `ok`.
A question that could not be answered is still `200`, with `ok: false`, an empty `text` and
one generic `error` sentence. The `trace_id` finds the reason in the server's log.

With `stream`, each event is one `data:` line of JSON, in this order:

| Event | Holds |
|---|---|
| `chat_rewrite` | `standalone` (the question as it was searched) and `reason` |
| `sources` | the same `sources` list |
| `token` | `text`: the whole answer. The answer step does not stream yet, so there is one `token` event. A client written now keeps working when streaming arrives. |
| `done` | `conversation_id`, `trace_id`, `ok`, `cost` and `timings` |
| `error` | `error` (one generic sentence) and `trace_id`, sent before `done` when the turn failed |
| `queued`, `unqueued` | the turn waits for a free slot when the Policy's `max_active_runs` is reached (`queued` says how many are ahead), then starts |
| `run_error` | the turn crashed in a way the route did not catch; its text goes through `Policy.scrub` |
| `stream_end` | closes the stream |

If the client disconnects, the turn is cancelled and no half turn is stored. After the reply,
the server folds old turns into the running summary and, when `ServeSettings.chat.memory`
is on, keeps facts the user shared. The user never waits for either. Cancel on disconnect applies to streams only: a JSON request runs to its end. A stream cannot be
resumed on another server copy: there is no events route in serve.

### POST /feedback

A user says whether an answer was good. Send the `trace_id` that `/chat` returned:

```bash
curl http://127.0.0.1:8000/feedback \
  -H 'content-type: application/json' \
  -d '{"trace_id": "9f2c...", "value": "down", "category": "wrong_answer", "comment": "It missed page 2."}'
# {"ok": true}
```

| Field | Meaning |
|---|---|
| `trace_id` | The trace of one of this user's own turns. |
| `value` | `up` or `down`. |
| `category` | Optional, up to 40 characters, such as `wrong_answer`. |
| `comment` | Optional, up to 500 characters. It is the user's own text. |

The user comes from the Policy's `user_id`, so the route needs a Policy that says who is asking.
`Policy.anonymous()` gives every caller one identity, and an empty user id is no identity, so both answer 403. A trace
that does not exist and a trace that is another user's are the same 404. A bad `value`, or a
category or comment that is too long, is a 422 with one sentence that does not repeat the text.
A conversation store that keeps no traces (see [Conversations](../pandion/conversations.md#conversations)) answers
501 with "This server's conversation store does not keep traces." One user has one piece of
feedback for each trace, and a newer one replaces the older. The question, the answer and the
comment are never logged or used as a metric label.

### POST /ask, conversations and memories

`POST /ask` takes `{"question": "..."}` (1 to 8,000 characters) and answers once, with no
conversation. It gives the same JSON reply as `/chat`, with `conversation_id` set to `null`,
and stores nothing: no history, no rewrite, no summary, no memory.

Every route below asks the Policy `limit` first, then `user_id`. Anything that is not the
caller's own is a 404, the same as something that does not exist, so a guessed id tells
nothing.

| Route | What it does |
|---|---|
| `GET /conversations` | The user's conversations, newest first: `id`, `title`, `turns`, `updated_at`. |
| `GET /conversations/{id}` | The turns in order. Each has `question`, `answer`, `source_ids`, `trace_id` and `created_at`. The rewrite and the running summary are never shown. |
| `DELETE /conversations/{id}` | Deletes it and answers `204`. A second delete is a 404. |
| `GET /memories` | The user's memories, oldest first. |
| `DELETE /memories/{memory_id}` | Deletes one memory by id and answers `204`. There is no delete-all route. |

The memory routes work even while `ServeSettings.chat.memory` is off, so a user can still
see and delete memories kept while it was on.

Answers are made safer by Pandion, not by the route: sources are fenced in the prompt, and a reply's links and images are removed unless a source holds the same address. The `token` event, the JSON reply and the stored turn all carry the cleaned text. Even so, a client should not load images or follow links in answers automatically. See [Answer safety](../pandion/conversations.md#answer-safety).

### GET /health and GET /ready

`GET /health` says `{"status": "ok"}` and names no version. `GET /ready` is `200
{"ready": true}` when the conversation store opens and the pipeline's index is there, else
`503 {"ready": false}` with no reason. The reason goes to the log.

## Logs and traces

Serve mode writes one JSON object per line to standard error. Each line has `ts`, `level`,
`msg`, `trace_id` and `conversation_id`, plus the fields of its kind:

| Line | Extra fields |
|---|---|
| One per request | `route` (the route template, never the raw path), `method`, `status`, `duration_ms` |
| One per finished or failed step | `stage`, `duration_ms`, `usage` (model and token counts) |
| One per failure | `exc` (the traceback) |
| One per answered turn | `Chat turn answered.` is always logged. Its `question` and `answer` fields are added only when `PANDION_LOG_CONTENT=true` |

The server adds its JSON handler to the `pandion_api` logger only if that logger has no handler yet, so your own logging setup wins. Records still reach the root logger. Text a user wrote or an answer gave is never logged unless you set `PANDION_LOG_CONTENT=true`.

Every response has an `X-Trace-Id` header. The server makes the id for each request and never
trusts one the client sends. The same id is in the `done` event, the error sentence, the stored
turn, every log line and every executor event, so one search finds a whole turn.

To send OpenTelemetry spans, install the extra and set the standard variables:

```bash
pip install "pandion-api[otel]"
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer ..."   # optional, from the environment only
```

With no endpoint set, OpenTelemetry is not imported and the extra is not needed. With an
endpoint but no extra, the server stops at startup and names `pandion-api[otel]`. Each turn
is one `chat` span with one child span per step, named after the step. A step that called a
model has the GenAI attributes `gen_ai.operation.name`, `gen_ai.request.model`,
`gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens`. The span's trace id is the
request's trace id. Question text is a span attribute only when `PANDION_LOG_CONTENT=true`.
A failed step marks its span, and the turn's span, as an error. Spans for sync runs are not
part of release 1.

## Your users' data

Serve keeps each user's conversations and memories in the conversation store, under the user's id.

- **Where the store is.** Set `PANDION_CONVERSATIONS_URL` to a SQLAlchemy url. The store reads it itself, so the url never sits in your code or files. With no variable, serve uses a SQLite file in `data_dir`.
- **Retention.** `ServeSettings(retention_days=90)` is how long a conversation is kept after its newest turn. The server deletes older ones at startup and then every 24 hours, and logs `retention sweep: removed N conversations older than D days`. A sweep that fails is logged and tried again the next day; it never stops the server. Memories are not removed by the sweep. The value must be at least 1.
- **Forget one user.** `pandion forget-user USER_ID --url-env PANDION_CONVERSATIONS_URL --yes` deletes all of that user's conversations, memories, trace records and feedback. See [Forget one user](../pandion/conversations.md#forget-one-user). Backups of the database and the retention of your model providers are out of its reach.
- **Where the data goes.** Fill in the region column for your deployment. The same table is in [privacy.md](../privacy.md#in-a-pandion-server-serve-mode).

| Where your users' data goes | What is sent or kept | Region (yours to record) |
|---|---|---|
| LLM provider | The rewritten question, the retrieved pieces and the history, for the rewrite and the answer |  |
| Remote embedder (if you use one) | The text of your documents and each question |  |
| Judge model (online checks, when used) | The question, the answer and its sources |  |
| OpenTelemetry exporter (if you set an endpoint) | Step names, timings, model names and token counts; the question only when `PANDION_LOG_CONTENT=true` |  |
| Conversation store | Conversations, turns and memories, under the user's id |  |

Run `pip-audit` against your pinned dependencies now and then, so a known security fix does not wait.

### Metrics

Serve mode can expose Prometheus metrics on a port of their own. Install the extra and set
the port. Metrics are off until you do, and then `prometheus_client` is not imported.

```bash
pip install "pandion-api[metrics]"
```

```python
create_app(settings, mode="serve", pipeline="pipeline.yaml", serve=ServeSettings(metrics_port=9464))
```

Port 9464 is the usual choice. Prometheus scrapes it like this:

```yaml
scrape_configs:
  - job_name: pandion
    static_configs:
      - targets: ["your-host:9464"]
```

| Metric | Labels | What it counts |
|---|---|---|
| `requests_total` | `route`, `status` | Requests. `route` is the route template such as `/conversations/{conversation_id}`, and `unmatched` for a path no route has. |
| `step_seconds` | `step` | A histogram of how long each pipeline step took. |
| `tokens_total` | `step`, `kind` | Model tokens. `kind` is `input` or `output`. |
| `cost_estimated_usd_total` | none | Estimated dollars of answered turns. A model with no price adds nothing. |
| `errors_total` | `step` | Steps that failed. |
| `turns_flagged_total` | `category` | Answered turns by flag. `category` is `low_grounding`, `declined` or `not_in_documents`, and a turn with two flags counts in both. See [Traces](../pandion/traces.md#traces). |
| `feedback_total` | `value`, `category` | Feedback saved by `POST /feedback`. `value` is `up` or `down`. `category` is what the user sent when it is on `ServeSettings.feedback_categories` (empty by default), empty when none was sent, and `other` for anything else, so the number of series stays fixed. |

No label ever holds a question, an answer, a user id, a conversation id or a chunk id, so the
number of series stays small. Before this release `turns_flagged_total` used the labels `weak`,
`none` and `not_found`; they are retired, so change any dashboard that filters on them.

Teams usually want three ratios, which you write in your own dashboard. The error rate of a
step is `errors_total` divided by `step_seconds_count + errors_total` for the same step. The
share of flagged turns is `turns_flagged_total` divided by the answered turns, which is the
`/chat` requests with status 200. That count includes replies with `ok: false`, which also
return 200. A request refused by the body size limit (413) is counted with `route="unmatched"`. The cost per turn is the rate of `cost_estimated_usd_total`
divided by that same request rate.

To turn metrics off, leave `metrics_port` as `None`. If the port is taken, the server stops
at startup and says which port. If your gateway blocks a second port, set
`ServeSettings(metrics_on_app=True)` to serve `GET /metrics` on the API port as well. It is a
404 otherwise. Never expose that route to the internet: put it behind your gateway's
network rules. The metrics port listens on every network interface, so firewall it too.


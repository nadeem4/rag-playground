"""Serve mode's logs, trace id and OpenTelemetry spans (docs/pandion-api/serve-mode.md, "Logs and traces").

Every log line is one JSON object. Text a user wrote or an answer gave is only
logged when `PANDION_LOG_CONTENT=true`. One trace id per request is shown in the
`X-Trace-Id` header, the log, the events, the error sentence and the stored turn.
OpenTelemetry is an optional extra (`pandion-api[otel]`) and is imported only
when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
"""

from __future__ import annotations

import importlib
import json
import logging
import os
import time
import uuid
from datetime import datetime, timezone
import threading
from typing import Any

from pandion.extend import MissingExtra

#: Attributes every LogRecord has; anything else on a record came from `extra=`.
_STANDARD = set(vars(logging.LogRecord("", 0, "", 0, "", (), None))) | {"message", "asctime"}

logger = logging.getLogger("pandion_api")


def log_content() -> bool:
    """Whether user and answer text may be logged."""
    return os.environ.get("PANDION_LOG_CONTENT", "").lower() == "true"


def content_fields(**fields: Any) -> dict[str, Any]:
    """`fields` when content logging is on, else nothing."""
    return fields if log_content() else {}


class JsonFormatter(logging.Formatter):
    """One JSON object per line, never a hand-built string."""

    def format(self, record: logging.LogRecord) -> str:
        line: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, timezone.utc).isoformat(),
            "level": record.levelname,
            "msg": record.getMessage(),
            "trace_id": None,
            "conversation_id": None,
        }
        line.update({k: v for k, v in vars(record).items() if k not in _STANDARD})
        if record.exc_info:
            line["exc"] = self.formatException(record.exc_info)
        return json.dumps(line, default=str)


def configure_logging(stream: Any = None) -> None:
    """Send the `pandion_api` loggers to `stream` (stderr) as JSON, once. If the
    logger already has a handler (yours, or an earlier call's), nothing is
    added, and records still propagate to the root logger."""
    if logger.handlers:
        return
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter())
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)


def log_event(e: dict[str, Any], conversation_id: str | None = None) -> None:
    """One step line for an executor `node_finished` event, one error line for `node_failed`."""
    kind = e.get("event")
    if kind not in ("node_finished", "node_failed"):
        return
    failed = kind == "node_failed"
    logger.log(
        logging.ERROR if failed else logging.INFO,
        "Step failed." if failed else "Step finished.",
        extra={
            "trace_id": e.get("trace_id"), "conversation_id": conversation_id, "stage": e.get("stage"),
            "duration_ms": e.get("duration_ms"), "usage": e.get("usage"),
        },
    )


class TraceIdMiddleware:
    """Gives each request a fresh trace id (an incoming one is never trusted),
    puts it in `request.state.trace_id` and the `X-Trace-Id` header, and logs one request line."""

    def __init__(self, app: Any, metrics: Any = None) -> None:
        self.app, self.metrics = app, metrics

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        trace_id = uuid.uuid4().hex
        scope.setdefault("state", {})["trace_id"] = trace_id
        began, status = time.monotonic(), 500

        async def send_with_id(message: Any) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                message["headers"] = [*message.get("headers", []), (b"x-trace-id", trace_id.encode())]
            await send(message)

        try:
            await self.app(scope, receive, send_with_id)
        finally:
            route = scope.get("route")
            if self.metrics:  # an unmatched path is one label, never the raw path
                self.metrics.request(getattr(route, "path", "unmatched"), status)
            logging.getLogger("pandion_api.request").info(
                "Request.",
                extra={
                    "trace_id": trace_id, "route": getattr(route, "path", None), "method": scope["method"],
                    "status": status, "duration_ms": round((time.monotonic() - began) * 1000, 1),
                },
            )


def setup_tracing() -> Any | None:
    """A tracer that exports over OTLP to `OTEL_EXPORTER_OTLP_ENDPOINT`, or None
    (and nothing imported) when that is not set. Headers come only from
    `OTEL_EXPORTER_OTLP_HEADERS`."""
    if not os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
        return None

    def need(name: str) -> Any:
        try:
            return importlib.import_module(name)
        except ImportError as exc:
            raise MissingExtra(
                f'Tracing needs {name}. Install it with: pip install "pandion-api[otel]"'
            ) from exc

    trace = need("opentelemetry.sdk.trace")
    export = need("opentelemetry.sdk.trace.export")
    http = need("opentelemetry.exporter.otlp.proto.http.trace_exporter")
    provider = trace.TracerProvider()
    provider.add_span_processor(export.BatchSpanProcessor(http.OTLPSpanExporter()))
    return provider.get_tracer("pandion_api")


class TurnSpans:
    """The spans of one chat turn: a root `chat` span and a child per finished or
    failed step. A step's span is built from its event (`ts` and `duration_ms`),
    so no span object is open while a step runs in the worker thread."""

    def __init__(self, tracer: Any, trace_id: str, content: bool, question: str | None = None) -> None:
        from opentelemetry import trace

        self._trace, self._tracer = trace, tracer
        parent = trace.NonRecordingSpan(
            trace.SpanContext(
                trace_id=int(trace_id, 16), span_id=int.from_bytes(os.urandom(8), "big") or 1,
                is_remote=True, trace_flags=trace.TraceFlags(trace.TraceFlags.SAMPLED),
            )
        )
        self._root = tracer.start_span("chat", context=trace.set_span_in_context(parent))
        if content and question is not None:
            self._root.set_attribute("pandion.question", question)
        self._context = trace.set_span_in_context(self._root)
        self._failed = False
        self._open = True
        self._lock = threading.Lock()

    def on_event(self, e: dict[str, Any]) -> None:
        kind = e.get("event")
        if kind not in ("node_finished", "node_failed"):
            return
        with self._lock:  # a child span must not end after its root
            if self._open:
                self._step(kind, e)

    def _step(self, kind: str, e: dict[str, Any]) -> None:
        end = float(e.get("ts") or time.time())
        start = end - float(e.get("duration_ms") or 0) / 1000
        span = self._tracer.start_span(str(e.get("stage")), context=self._context, start_time=int(start * 1e9))
        usage = e.get("usage")
        if usage:
            span.set_attribute("gen_ai.operation.name", "chat")
            if usage.get("model"):
                span.set_attribute("gen_ai.request.model", str(usage["model"]))
            span.set_attribute("gen_ai.usage.input_tokens", usage.get("input_tokens") or 0)
            span.set_attribute("gen_ai.usage.output_tokens", usage.get("output_tokens") or 0)
        if kind == "node_failed":
            self._failed = True
            span.set_status(self._trace.Status(self._trace.StatusCode.ERROR))
        span.end(end_time=int(end * 1e9))

    def finish(self, ok: bool) -> None:
        """End the root span. A second call does nothing."""
        with self._lock:
            if not self._open:
                return
            self._open = False
            if not ok or self._failed:
                self._root.set_status(self._trace.Status(self._trace.StatusCode.ERROR))
            self._root.end()

"""Serve mode's Prometheus metrics (docs/pandion-api.md, "Metrics").

Labels are only route template, status, step name, token kind, flag name,
feedback value and a feedback category from the list the operator set in
`ServeSettings.feedback_categories` (else "other"). No question, answer, user id, conversation id or chunk id is ever a
label. The client library is the optional extra `pandion-api[metrics]` and is
imported only when a `Metrics` object is made.
"""

from __future__ import annotations

import importlib
from typing import Any

from pandion.extend import MissingExtra



def _client() -> Any:
    try:
        return importlib.import_module("prometheus_client")
    except ImportError as exc:
        raise MissingExtra(
            'Metrics need prometheus_client. Install with: pip install "pandion-api[metrics]"'
        ) from exc


class Metrics:
    """The counters and histogram of one serve app, in a registry of their own."""

    def __init__(self, registry: Any = None, categories: tuple[str, ...] = ()) -> None:
        self._categories = frozenset(categories)
        prom = _client()
        self.registry = registry or prom.CollectorRegistry()
        r = self.registry
        self._requests = prom.Counter("requests_total", "Requests by route template and status.", ["route", "status"], registry=r)
        self._seconds = prom.Histogram("step_seconds", "Seconds a pipeline step took.", ["step"], buckets=(.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10, 30, 60, 120), registry=r)
        self._tokens = prom.Counter("tokens_total", "Model tokens by step and kind.", ["step", "kind"], registry=r)
        self._cost = prom.Counter("cost_estimated_usd_total", "Estimated dollars spent on answered turns.", registry=r)
        self._errors = prom.Counter("errors_total", "Failed steps.", ["step"], registry=r)
        self._flagged = prom.Counter("turns_flagged_total", "Answered turns by flag: low_grounding, declined or not_in_documents.", ["category"], registry=r)
        self._feedback = prom.Counter("feedback_total", "Feedback by value and category.", ["value", "category"], registry=r)

    def request(self, route: str, status: int) -> None:
        """Count one request. `route` is the route template, never the raw path."""
        self._requests.labels(route=route, status=str(status)).inc()

    def on_event(self, e: dict[str, Any]) -> None:
        """Consume the executor's events, the same ones the log and the spans get."""
        kind, step = e.get("event"), str(e.get("stage"))
        if kind == "node_failed":
            self._errors.labels(step=step).inc()
        elif kind == "node_finished":
            self._seconds.labels(step=step).observe(float(e.get("duration_ms") or 0) / 1000)
            usage = e.get("usage") or {}
            for name, key in (("input", "input_tokens"), ("output", "output_tokens")):
                if usage.get(key):
                    self._tokens.labels(step=step, kind=name).inc(usage[key])

    def turn_done(self, answer: Any, flags: Any = ()) -> None:
        """Add an answered turn's estimated cost and its flags (`TurnResult.flags`)."""
        dollars = answer.cost().get("dollars")
        if dollars:
            self._cost.inc(dollars)
        for flag in flags:
            self._flagged.labels(category=flag).inc()

    def feedback(self, value: str, category: str) -> None:
        """Count one saved piece of feedback. A category not on the operator's list is "other"; none stays empty."""
        if category and category not in self._categories:
            category = "other"
        self._feedback.labels(value=value, category=category).inc()


def start_server(metrics: Metrics, port: int) -> tuple[Any, Any]:
    """Serve `metrics` on `port`; return the server and its thread, to stop at shutdown.
    A port that is taken stops startup with a plain sentence."""
    try:
        return _client().start_http_server(port, registry=metrics.registry)
    except OSError as exc:
        raise RuntimeError(
            f"Metrics could not start: port {port} is already in use. "
            "Choose another with ServeSettings(metrics_port=...), or pass metrics_port=None to turn metrics off."
        ) from exc


def stop_server(server: Any, thread: Any) -> None:
    """Stop the server `start_server` returned, and free its port."""
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)

"""Serve mode's Prometheus metrics (docs/pandion-api.md, "Metrics").

Labels are only route template, status, step name, token kind and grounding
category. No question, answer, user id, conversation id or chunk id is ever a
label. The client library is the optional extra `pandion-api[metrics]` and is
imported only when a `Metrics` object is made.
"""

from __future__ import annotations

import importlib
from typing import Any

from pandion.extend import MissingExtra

#: The grounding labels that mean a reply may be wrong, counted per turn.
FLAGGED = ("weak", "none", "not_found")


def _client() -> Any:
    try:
        return importlib.import_module("prometheus_client")
    except ImportError as exc:
        raise MissingExtra(
            'Metrics need prometheus_client. Install with: pip install "pandion-api[metrics]"'
        ) from exc


class Metrics:
    """The counters and histogram of one serve app, in a registry of their own."""

    def __init__(self, registry: Any = None) -> None:
        prom = _client()
        self.registry = registry or prom.CollectorRegistry()
        r = self.registry
        self._requests = prom.Counter("requests_total", "Requests by route template and status.", ["route", "status"], registry=r)
        self._seconds = prom.Histogram("step_seconds", "Seconds a pipeline step took.", ["step"], registry=r)
        self._tokens = prom.Counter("tokens_total", "Model tokens by step and kind.", ["step", "kind"], registry=r)
        self._cost = prom.Counter("cost_estimated_usd_total", "Estimated dollars spent on answered turns.", registry=r)
        self._errors = prom.Counter("errors_total", "Failed steps.", ["step"], registry=r)
        self._flagged = prom.Counter("turns_flagged_total", "Answered turns with a weak, none or not_found claim.", ["category"], registry=r)

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

    def turn_done(self, answer: Any) -> None:
        """Add an answered turn's estimated cost and its flagged claims."""
        dollars = answer.cost().get("dollars")
        if dollars:
            self._cost.inc(dollars)
        stats = getattr(getattr(answer, "output", None), "payload", {}).get("stats") or {}
        for category in FLAGGED:
            if stats.get(category):
                self._flagged.labels(category=category).inc()


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

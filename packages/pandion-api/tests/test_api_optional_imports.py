"""The OpenTelemetry extra is optional: without an endpoint nothing is imported, and a missing extra says how to install it."""

import subprocess
import sys

import pytest

from pandion.extend import MissingExtra
from pandion_api.observability import setup_tracing


def test_no_endpoint_means_no_tracer_and_no_otel_import():
    code = (
        "import os, sys; os.environ.pop('OTEL_EXPORTER_OTLP_ENDPOINT', None)\n"
        "from pandion_api.observability import setup_tracing\n"
        "assert setup_tracing() is None\n"
        "assert not [m for m in sys.modules if m.startswith('opentelemetry')], 'imported'\n"
    )
    subprocess.run([sys.executable, "-c", code], check=True)


def test_missing_extra_names_pandion_api_otel(monkeypatch):
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318")
    monkeypatch.setitem(sys.modules, "opentelemetry.sdk.trace", None)
    with pytest.raises(MissingExtra, match=r"pandion-api\[otel\]"):
        setup_tracing()

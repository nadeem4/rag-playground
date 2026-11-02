"""Metrics on their own port: off by default on the API port, one sentence for a busy port, a clean stop."""

import socket
import sys
import urllib.request

import pytest

pytest.importorskip("prometheus_client")
from apihelpers import make_serve_client
from pandion.extend import MissingExtra
from pandion_api import ServeSettings
from test_api_chat import StubPipeline, say


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def client(tmp_path, **kw):
    c = make_serve_client(tmp_path, indexed=False, serve=ServeSettings(**kw))
    c.app.state.pipeline = StubPipeline()
    return c


def scrape(port):
    return urllib.request.urlopen(f"http://127.0.0.1:{port}/metrics", timeout=5).read().decode()


def test_metrics_are_served_on_their_own_port(tmp_path):
    port = free_port()
    with client(tmp_path, metrics_port=port) as c:
        say(c)
        text = scrape(port)
    assert 'requests_total{route="/chat",status="200"} 1.0' in text
    assert "step_seconds" in text or "cost_estimated_usd_total" in text


def test_metrics_is_a_404_on_the_api_port_by_default(tmp_path):
    with client(tmp_path, metrics_port=free_port()) as c:
        assert c.get("/metrics").status_code == 404


def test_metrics_on_app_serves_the_text_format(tmp_path):
    with client(tmp_path, metrics_port=None, metrics_on_app=True) as c:
        say(c)
        r = c.get("/metrics")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/plain")
    assert "requests_total" in r.text


def test_a_busy_port_stops_startup_with_a_sentence(tmp_path, monkeypatch):
    def busy(port, **kwargs):  # Windows lets a second socket bind a taken port, so the OS error is simulated
        raise OSError("Address already in use")

    monkeypatch.setattr("prometheus_client.start_http_server", busy)
    with pytest.raises(RuntimeError, match="port 9464 is already in use"):
        with client(tmp_path, metrics_port=9464):
            pass


def test_metrics_off_starts_nothing(tmp_path):
    with client(tmp_path, metrics_port=None) as c:
        assert c.get("/metrics").status_code == 404
        assert c.app.state.metrics is None


def test_the_port_server_stops_at_shutdown(tmp_path):
    port = free_port()
    with client(tmp_path, metrics_port=port):
        scrape(port)
    with socket.socket() as s:
        s.bind(("127.0.0.1", port))  # free again


def test_missing_extra_names_pandion_api_metrics(tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "prometheus_client", None)
    with pytest.raises(MissingExtra, match=r"pandion-api\[metrics\]"):
        client(tmp_path, metrics_port=free_port())


def test_ask_and_a_failed_turn_still_count_their_cost(tmp_path):
    with client(tmp_path, metrics_port=None, metrics_on_app=True) as c:
        c.app.state.pipeline = StubPipeline(dollars=0.5)
        c.post("/ask", json={"question": "Notice period?"})
        c.app.state.pipeline = StubPipeline(ok=False, dollars=0.25)
        say(c)
        text = c.get("/metrics").text
    assert "cost_estimated_usd_total 0.75" in text

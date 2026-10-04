"""The clip recorder never records against a server it did not start."""

import importlib.util
import socket
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location(
    "record_clips", Path(__file__).resolve().parents[1] / "scripts" / "record_clips.py"
)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_refuses_to_start_when_the_port_already_answers(monkeypatch, tmp_path):
    def no_popen(*a, **k):
        raise AssertionError("a server was started on a port in use")

    monkeypatch.setattr(_mod.subprocess, "Popen", no_popen)
    with socket.socket() as other:
        other.bind(("127.0.0.1", 0))
        other.listen()
        port = other.getsockname()[1]
        with pytest.raises(SystemExit, match="already answers"):
            _mod.start_server(port, tmp_path)


def test_stops_waiting_when_its_own_server_exits(monkeypatch, tmp_path):
    class Exited:
        returncode = 1

        def poll(self):
            return 1

        def terminate(self):
            pass

    monkeypatch.setattr(_mod.subprocess, "Popen", lambda *a, **k: Exited())
    with pytest.raises(SystemExit, match="exited"):
        _mod.start_server(_free_port(), tmp_path)


def test_has_a_compare_clip_ready_for_the_new_page():
    assert set(_mod.CLIPS) == {"build", "compare", "evaluate"}

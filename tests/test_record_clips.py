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


def test_compare_takes_start_cold_so_the_recipes_run_on_camera():
    assert _mod.COLD_TAKES == {"compare"}


def test_has_a_compare_clip_ready_for_the_new_page():
    assert set(_mod.CLIPS) == {"build", "compare", "evaluate"}


class _Locator:
    """Records how the script finds and presses things, as a Playwright page would be driven."""

    def __init__(self, log, path):
        self.log = log
        self.path = path

    def get_by_role(self, role, name=None, **kw):
        label = name.pattern if hasattr(name, "pattern") else name
        return _Locator(self.log, [*self.path, (role, label)])

    def click(self, **kw):
        self.log.append(self.path)


def test_the_reranker_is_chosen_through_the_picker_not_a_button():
    log = []
    page = _Locator(log, [])
    _mod.pick_reranker(page, "Cross-encoder")
    _mod.pick_reranker(page, "No reranker")
    trigger, option, trigger2, option2 = log
    # The Picker's trigger is named by its label first, then the current pick.
    assert trigger == [("button", "^Reranker")] == trigger2
    assert option == [("listbox", None), ("option", "^Cross\\-encoder")]
    assert option2 == [("listbox", None), ("option", "^No\\ reranker")]
    # No step still presses the old segmented buttons.
    source = (Path(__file__).resolve().parents[1] / "scripts" / "record_clips.py").read_text(encoding="utf8")
    assert 'name="Cross-encoder"' not in source
    assert 'name="None"' not in source


def test_build_clip_is_wide_enough_for_the_slope_beside_the_docked_panel():
    # 16:10 like the other clips, so Home's frame fits; wide enough that the dock can take 698 px,
    # over the 640 px the comparison needs to set the two lists side by side with the slope.
    assert _mod.size_for("build") == {"width": 1440, "height": 900}
    assert _mod.size_for("compare") == _mod.size_for("evaluate") == {"width": 1280, "height": 800}
    assert _mod.DOCK_SEED == {"open": True, "side": "right", "width": 698}
    assert 1440 - 380 - 360 - 2 == _mod.DOCK_SEED["width"]

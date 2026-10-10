"""The Space copy: README gains the Space header, the Dockerfile turns demo mode on."""

import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "publish_space", Path(__file__).resolve().parents[1] / "scripts" / "publish_space.py"
)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
space_readme, DEMO_VAR = _mod.space_readme, _mod.DEMO_VAR


def test_readme_starts_with_space_header_and_keeps_the_body():
    out = space_readme("# RAG Playground\n\nBody.\n")
    header, body = out.split("---\n", 2)[1:]
    assert "sdk: docker" in header
    assert "app_port: 8000" in header
    assert "license: mit" in header
    # The share preview uses our own banner, not a generated card.
    assert "thumbnail: https://huggingface.co/spaces/" in header and "banner.png" in header
    assert body.lstrip("\n") == "# RAG Playground\n\nBody.\n"


def test_demo_mode_is_a_space_variable_not_a_baked_in_image():
    """Whoever duplicates the Space can turn demo mode off; the image stays neutral."""
    assert DEMO_VAR == ("RAG_PLAYGROUND_DEMO", "1")
    assert "RAG_PLAYGROUND_DEMO" not in (_mod.ROOT / "Dockerfile").read_text(encoding="utf-8")


def test_a_publish_removes_files_no_longer_in_the_repo(monkeypatch):
    """A file deleted from the repo must leave the Space too.

    On 2026-10-04 a component deleted in v0.21.0 stayed on the Space; v0.24.0
    removed a helper it imported, and the Space's own build failed on it.
    """
    import sys
    import types

    calls: dict[str, dict] = {}

    class FakeApi:
        def space_info(self, *a, **k):
            return types.SimpleNamespace(private=False)

        def create_repo(self, *a, **k):
            pass

        def add_space_variable(self, *a, **k):
            pass

        def upload_folder(self, **kwargs):
            calls["upload"] = kwargs

    monkeypatch.setitem(sys.modules, "huggingface_hub", types.SimpleNamespace(HfApi=FakeApi))
    monkeypatch.setattr(sys, "argv", ["publish_space.py", "--repo", "someone/space"])
    _mod.main()
    assert calls["upload"]["delete_patterns"] == ["*"]


def test_binaries_are_tracked_by_lfs_in_the_space(tmp_path):
    """The Space's Docker build checks files out with its .gitattributes.

    On 2026-10-05 a publish replaced the Space's .gitattributes with the repo's,
    which has no LFS rules, so the build copied 131-byte LFS pointers in place of
    the Home clips and every clip played blank.
    """
    _mod.export_tree(tmp_path)
    attrs = (tmp_path / ".gitattributes").read_text(encoding="utf-8")
    for ext in ("webm", "mp4", "jpg", "jpeg", "png", "gif", "webp", "pdf", "woff2", "lance", "ico"):
        assert f"*.{ext} filter=lfs diff=lfs merge=lfs -text" in attrs, ext
    # The repo's own text rule still holds.
    assert "* text=auto eol=lf" in attrs


class _NotFound(Exception):
    """Stands in for huggingface_hub's RepositoryNotFoundError; matched by name."""


_NotFound.__name__ = "RepositoryNotFoundError"


def _fake_api(monkeypatch, exists: bool, private: bool = False):
    import sys
    import types

    calls: dict[str, list] = {"create": [], "vars": [], "upload": []}

    class FakeApi:
        def space_info(self, repo_id, **k):
            if not exists:
                raise _NotFound(repo_id)
            return types.SimpleNamespace(private=private)

        def create_repo(self, *a, **k):
            calls["create"].append(k)

        def add_space_variable(self, repo_id, key, value, **k):
            calls["vars"].append((key, value))

        def upload_folder(self, **kwargs):
            calls["upload"].append(kwargs)

    monkeypatch.setitem(sys.modules, "huggingface_hub", types.SimpleNamespace(HfApi=FakeApi))
    return calls


def test_private_creates_a_new_space_private(monkeypatch):
    import sys

    calls = _fake_api(monkeypatch, exists=False)
    monkeypatch.setattr(sys, "argv", ["publish_space.py", "--repo", "someone/staging", "--private"])
    _mod.main()
    assert calls["create"] and calls["create"][0]["private"] is True


def test_without_private_a_new_space_is_public(monkeypatch):
    import sys

    calls = _fake_api(monkeypatch, exists=False)
    monkeypatch.setattr(sys, "argv", ["publish_space.py", "--repo", "someone/space"])
    _mod.main()
    assert calls["create"][0]["private"] is False


def test_an_existing_space_keeps_its_visibility_and_a_mismatch_is_warned(monkeypatch, capsys):
    import sys

    calls = _fake_api(monkeypatch, exists=True, private=False)
    monkeypatch.setattr(sys, "argv", ["publish_space.py", "--repo", "someone/staging", "--private"])
    _mod.main()
    assert calls["create"] == []
    assert "is public" in capsys.readouterr().out


def test_commit_is_set_as_a_space_variable(monkeypatch):
    import sys

    calls = _fake_api(monkeypatch, exists=True)
    monkeypatch.setattr(sys, "argv", ["publish_space.py", "--repo", "someone/space", "--commit", "abc1234"])
    _mod.main()
    assert ("RAG_PLAYGROUND_COMMIT", "abc1234") in calls["vars"]
    assert ("RAG_PLAYGROUND_DEMO", "1") in calls["vars"]



def test_version_is_set_as_a_space_variable(monkeypatch):
    """The tag is the version: /api/health reports RAG_PLAYGROUND_VERSION."""
    import sys

    calls = _fake_api(monkeypatch, exists=True)
    monkeypatch.setattr(sys, "argv", ["publish_space.py", "--repo", "someone/space", "--version", "v0.33.0"])
    _mod.main()
    assert ("RAG_PLAYGROUND_VERSION", "v0.33.0") in calls["vars"]

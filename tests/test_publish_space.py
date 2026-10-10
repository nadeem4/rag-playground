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

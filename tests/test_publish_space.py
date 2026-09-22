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
    assert body.lstrip("\n") == "# RAG Playground\n\nBody.\n"


def test_demo_mode_is_a_space_variable_not_a_baked_in_image():
    """Whoever duplicates the Space can turn demo mode off; the image stays neutral."""
    assert DEMO_VAR == ("RAG_PLAYGROUND_DEMO", "1")
    assert "RAG_PLAYGROUND_DEMO" not in (_mod.ROOT / "Dockerfile").read_text(encoding="utf-8")

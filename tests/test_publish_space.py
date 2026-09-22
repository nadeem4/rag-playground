"""The Space copy: README gains the Space header, the Dockerfile turns demo mode on."""

import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "publish_space", Path(__file__).resolve().parents[1] / "scripts" / "publish_space.py"
)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
space_dockerfile, space_readme = _mod.space_dockerfile, _mod.space_readme


def test_readme_starts_with_space_header_and_keeps_the_body():
    out = space_readme("# RAG Playground\n\nBody.\n")
    header, body = out.split("---\n", 2)[1:]
    assert "sdk: docker" in header
    assert "app_port: 8000" in header
    assert "license: mit" in header
    assert body.lstrip("\n") == "# RAG Playground\n\nBody.\n"


def test_dockerfile_turns_demo_mode_on_before_the_command():
    src = 'FROM python:3.13-slim\nEXPOSE 8000\nCMD ["rag-playground"]\n'
    out = space_dockerfile(src)
    assert "ENV RAG_PLAYGROUND_DEMO=1\n" in out
    assert out.index("RAG_PLAYGROUND_DEMO") < out.index("CMD")
    assert out.replace("ENV RAG_PLAYGROUND_DEMO=1\n", "") == src

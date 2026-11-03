"""The serve half of `new_project`: a folder to build into a container image.

Fixed files (serve.py, policy.py, the Dockerfile, .dockerignore, .gitignore and
tests/test_quality.py) are copied as they are from `pandion/templates/serve/`.
Only pipeline.yaml, pyproject.toml, .env.example, evals/ and the README are
written for the pipeline. No key, no folder of the machine that wrote them and
no document goes into any of them.
"""

from __future__ import annotations

import json
from importlib.resources import files
from pathlib import Path
from typing import Any

import yaml

FIXED = ("serve.py", "policy.py", "Dockerfile", ".dockerignore", ".gitignore", "tests/test_quality.py")


def _template(name: str) -> str:
    resource = files("pandion.templates.serve")
    for part in name.split("/"):
        resource = resource.joinpath(part)
    return resource.read_text(encoding="utf-8")


def write_evals(categories_questions: dict[str, Any] | None) -> str | None:
    """evals/questions.json: every category's questions in one set, each tagged
    `category:<name>` so the gate can count them per category. None when no
    category has a question."""
    from pandion.questions import load_questions

    merged: list[dict[str, Any]] = []
    for category, questions in (categories_questions or {}).items():
        loaded = load_questions(questions) if questions["questions"] else {"questions": []}
        for q in loaded["questions"]:
            q = {**q, "tags": [*(q.get("tags") or []), f"category:{category}"]}
            if loaded.get("document") and not q.get("document"):
                q["document"] = loaded["document"]
            merged.append(q)
    return json.dumps({"questions": merged}, indent=2, ensure_ascii=False) + "\n" if merged else None


def write_serve_project(
    folder: Path, p: Any, data: dict[str, Any], *, questions: Any = None,
    categories_questions: dict[str, Any] | None = None, source: str = "./docs",
    index_store: str = "lancedb", index_url: str = "./index", readme_extra: str = "",
) -> list[Path]:
    """Write the serve project for the pipeline `p` (`data` is its dict) into `folder`."""
    rendered = {
        "pipeline.yaml": yaml.safe_dump(data, sort_keys=False, allow_unicode=True),
        "pyproject.toml": "",
        ".env.example": "",
        "README.md": "",
    }
    evals = write_evals(categories_questions)
    if evals is not None:
        rendered["evals/questions.json"] = evals
    texts = {**{name: _template(name) for name in FIXED}, **rendered}

    written = []
    for name, text in texts.items():
        path = folder / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")
        written.append(path)
    return written

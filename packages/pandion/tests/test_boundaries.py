"""The package stands on its own: nothing in it imports the app.

The RAG Playground (`api`, `plugins`, `providers`) depends on pandion, never
the other way round. `core` is listed too, because that is where the engine
lived before it moved here.
"""

from __future__ import annotations

import ast
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src" / "pandion"
APP = {"api", "plugins", "providers", "core"}


def imported_modules(path: Path) -> list[tuple[int, str]]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    found: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found += [(node.lineno, alias.name) for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            found.append((node.lineno, node.module))
    return found


def test_the_package_imports_nothing_from_the_app():
    offenders = [
        f"{path.relative_to(SRC)}:{line} {module}"
        for path in sorted(SRC.rglob("*.py"))
        for line, module in imported_modules(path)
        if module.split(".")[0] in APP
    ]
    assert not offenders, "pandion must not import the app: " + ", ".join(offenders)

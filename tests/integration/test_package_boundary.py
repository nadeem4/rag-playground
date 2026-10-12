"""The app uses only pandion's public names.

A module or name that starts with an underscore is private to the package and
may change without notice. The app (`api`, `plugins`, `scripts`)
must not import one, so that the package can change its insides freely and the
playground keeps testing the same API a package user gets.
"""

from __future__ import annotations

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
APP_DIRS = ("api", "plugins", "scripts")


def private_pandion_imports(source: str) -> list[str]:
    """Every private pandion module or name imported in `source`."""
    found: list[str] = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            modules = [alias.name for alias in node.names]
            names: list[str] = []
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            modules = [node.module]
            names = [alias.name for alias in node.names]
        else:
            continue
        for module in modules:
            parts = module.split(".")
            if parts[0] != "pandion":
                continue
            if any(part.startswith("_") for part in parts):
                found.append(f"{node.lineno} {module}")
            found += [f"{node.lineno} {module}.{n}" for n in names if n.startswith("_")]
    return found


def test_a_private_module_or_name_is_caught():
    assert private_pandion_imports("from pandion.ids import _reject_nonfinite") == [
        "1 pandion.ids._reject_nonfinite"
    ]
    assert private_pandion_imports("import pandion._secret") == ["1 pandion._secret"]
    assert private_pandion_imports("from pandion.ids import short_id") == []


def test_the_app_imports_only_public_pandion_names():
    offenders = [
        f"{path.relative_to(ROOT)}:{hit}"
        for folder in APP_DIRS
        for path in sorted((ROOT / folder).rglob("*.py"))
        for hit in private_pandion_imports(path.read_text(encoding="utf-8"))
    ]
    assert not offenders, "the app imports private pandion names: " + ", ".join(offenders)

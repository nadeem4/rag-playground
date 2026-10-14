"""pandion-api uses only Pandion's public API, with no allow-list (spec rule 1).

The public API is `pandion.__all__`, each stage namespace's `__all__`,
`pandion.extend.__all__` and `pandion.evaluation.__all__`. An import of any
other pandion module or name fails here, and so does `pandion.<name>` for a
name that is not in `pandion.__all__`.
"""

from __future__ import annotations

import ast
import importlib
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src" / "pandion_api"

PUBLIC_MODULES = (
    "pandion",
    "pandion.parse",
    "pandion.clean",
    "pandion.chunk",
    "pandion.rewrite",
    "pandion.retrieve",
    "pandion.rerank",
    "pandion.answer",
    "pandion.extend",
    "pandion.evaluation",
)


def pandion_uses(source: str) -> list[str]:
    """Every pandion import in `source` as "module:name" ("module:*" for `import
    module`), and every `pandion.<name>` attribute as "pandion:<name>"."""
    found: list[str] = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            found += [f"{a.name}:*" for a in node.names if a.name.split(".")[0] == "pandion"]
        elif (
            isinstance(node, ast.ImportFrom)
            and node.level == 0
            and node.module
            and node.module.split(".")[0] == "pandion"
        ):
            found += [f"{node.module}:{a.name}" for a in node.names]
        elif isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "pandion":
            found.append(f"pandion:{node.attr}")
    return found


def is_public(entry: str) -> bool:
    module, name = entry.split(":")
    if module not in PUBLIC_MODULES:
        return False
    if name == "*":
        return module == "pandion"
    return name in importlib.import_module(module).__all__


def test_the_check_tells_an_engine_name_from_a_public_one():
    assert pandion_uses("from pandion.graph import Graph") == ["pandion.graph:Graph"]
    assert not is_public("pandion.graph:Graph")
    assert not is_public("pandion.graph:*")
    assert pandion_uses("import pandion\npandion.config") == ["pandion:*", "pandion:config"]
    assert not is_public("pandion:config")
    assert is_public("pandion:Pipeline") and is_public("pandion:*")
    assert is_public("pandion.extend:Stage") and is_public("pandion.evaluation:trace")


def test_pandion_api_uses_only_public_pandion_names():
    offenders = [
        f"{path.relative_to(SRC)}: {entry}"
        for path in sorted(SRC.rglob("*.py"))
        for entry in pandion_uses(path.read_text(encoding="utf-8"))
        if not is_public(entry)
    ]
    assert not offenders, "pandion-api uses engine names: " + ", ".join(offenders)

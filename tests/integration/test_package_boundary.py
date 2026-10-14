"""The app uses only pandion's public names.

The app, its scripts and the fixture exporter use only Pandion's public API and
pandion-api. There is no allow-list: part 5 deleted it.
"""

from __future__ import annotations

import ast
import importlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
APP_DIRS = ("playground/backend", "playground/frontend/scripts", "scripts")


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


#: The public API: a consumer may import from these modules any name in their
#: __all__ (spec rule 1). `import pandion` itself is public.
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

def pandion_imports(source: str) -> list[str]:
    """Every pandion import in `source`, as "module:name", or "module:*" for `import module`."""
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
    return found


def is_public(entry: str) -> bool:
    """True when `entry` is a name in the __all__ of a public module."""
    module, name = entry.split(":")
    if module not in PUBLIC_MODULES:
        return False
    return name == "*" or name in importlib.import_module(module).__all__


def engine_imports() -> set[str]:
    """Every import of a pandion name that is not public, across the app and its scripts."""
    return {
        entry
        for folder in APP_DIRS
        for path in sorted((ROOT / folder).rglob("*.py"))
        for entry in pandion_imports(path.read_text(encoding="utf-8"))
        if not is_public(entry)
    }


def test_an_engine_import_is_told_apart_from_a_public_one():
    assert pandion_imports("from pandion.graph import Graph\nimport pandion") == [
        "pandion.graph:Graph",
        "pandion:*",
    ]
    assert not is_public("pandion.graph:Graph")
    assert is_public("pandion:Pipeline")
    assert is_public("pandion.extend:register")
    assert is_public("pandion:*")


def test_the_app_imports_no_engine_name():
    found = sorted(engine_imports())
    assert not found, (
        "the app imports Pandion names that are not public: "
        + ", ".join(found)
        + ". Use pandion's public API (pandion, a stage namespace, pandion.extend, "
        "pandion.evaluation) or pandion-api, or make the name public in Pandion first."
    )


def test_the_cli_imports_only_public_pandion_names():
    cli = ROOT / "packages" / "pandion" / "src" / "pandion" / "cli.py"
    private = [entry for entry in pandion_imports(cli.read_text(encoding="utf-8")) if not is_public(entry)]
    assert not private, "the CLI imports names that are not public: " + ", ".join(private)


def test_the_app_loads_no_plugin_module_by_name():
    """An import by string (`importlib.import_module("pandion.plugins.x")`) is
    not an import statement, so the test above cannot see it. Pandion loads
    its own plugins; the app never names them."""
    found = [
        f"{path.relative_to(ROOT)}:{node.lineno}"
        for folder in APP_DIRS
        for path in sorted((ROOT / folder).rglob("*.py"))
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8")))
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and node.value.startswith("pandion.plugins")
    ]
    assert not found, "the app names Pandion's plugin modules: " + ", ".join(found)

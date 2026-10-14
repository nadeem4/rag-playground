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

import pytest

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
    module`), and every dotted read off a name an import bound to a pandion
    module (`import pandion`, `import pandion as p`, `import pandion.extend as x`,
    `from pandion import extend`) as "module:<name>": the chain is followed
    through public modules (`p.extend.Stage` is "pandion.extend:Stage") and the
    first name past them is the one checked."""
    tree = ast.parse(source)
    bound: dict[str, str] = {}
    found: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                if a.name.split(".")[0] != "pandion":
                    continue
                found.append(f"{a.name}:*")
                if a.asname:
                    bound[a.asname] = a.name
                else:
                    bound["pandion"] = "pandion"
        elif (
            isinstance(node, ast.ImportFrom)
            and node.level == 0
            and node.module
            and node.module.split(".")[0] == "pandion"
        ):
            for a in node.names:
                found.append(f"{node.module}:{a.name}")
                if f"{node.module}.{a.name}" in PUBLIC_MODULES:
                    bound[a.asname or a.name] = f"{node.module}.{a.name}"
    inner = {id(n.value) for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
    for node in ast.walk(tree):
        if not isinstance(node, ast.Attribute) or id(node) in inner:
            continue
        chain: list[str] = []
        part: ast.expr = node
        while isinstance(part, ast.Attribute):
            chain.insert(0, part.attr)
            part = part.value
        if not isinstance(part, ast.Name) or part.id not in bound:
            continue
        module = bound[part.id]
        while chain and f"{module}.{chain[0]}" in PUBLIC_MODULES:
            module = f"{module}.{chain.pop(0)}"
        if chain:
            found.append(f"{module}:{chain[0]}")
    return found


def is_public(entry: str) -> bool:
    module, name = entry.split(":")
    if module not in PUBLIC_MODULES:
        return False
    if name == "*":
        return True
    if module == "pandion" and f"pandion.{name}" in PUBLIC_MODULES:
        return True
    return name in importlib.import_module(module).__all__


def test_the_check_tells_an_engine_name_from_a_public_one():
    assert pandion_uses("from pandion.graph import Graph") == ["pandion.graph:Graph"]
    assert not is_public("pandion.graph:Graph")
    assert not is_public("pandion.graph:*")
    assert pandion_uses("import pandion\npandion.config") == ["pandion:*", "pandion:config"]
    assert not is_public("pandion:config")
    assert is_public("pandion:Pipeline") and is_public("pandion:*")
    assert is_public("pandion.extend:Stage") and is_public("pandion.evaluation:trace")


def test_an_alias_does_not_hide_an_engine_name():
    assert pandion_uses("import pandion as p\np.graph") == ["pandion:*", "pandion:graph"]
    assert not is_public("pandion:graph")
    assert pandion_uses("import pandion.extend as x\nx.Stage\nx.registry") == [
        "pandion.extend:*",
        "pandion.extend:Stage",
        "pandion.extend:registry",
    ]
    assert is_public("pandion.extend:Stage") and not is_public("pandion.extend:registry")
    assert pandion_uses("import os as pandion_like\npandion_like.path") == []


def test_a_public_module_may_be_imported_whole():
    assert pandion_uses("import pandion.extend\npandion.extend.Stage") == ["pandion.extend:*", "pandion.extend:Stage"]
    assert is_public("pandion.extend:*") and is_public("pandion:extend")
    assert not is_public("pandion.graph:*")


def offenders(source: str) -> list[str]:
    return [entry for entry in pandion_uses(source) if not is_public(entry)]


@pytest.mark.parametrize(
    ("source", "caught"),
    [
        ("import pandion.extend\npandion.extend.registry", "pandion.extend:registry"),
        ("import pandion as p\np.extend.registry", "pandion.extend:registry"),
        ("from pandion import extend\nextend.registry", "pandion.extend:registry"),
        ("from pandion import extend as x\nx.registry", "pandion.extend:registry"),
        ("import pandion\npandion.graph.Graph", "pandion:graph"),
    ],
)
def test_an_engine_name_behind_a_public_module_is_caught(source, caught):
    assert offenders(source) == [caught]


@pytest.mark.parametrize(
    "source",
    [
        "import pandion\npandion.extend.Stage",
        "import pandion.extend\npandion.extend.Stage",
        "import pandion as p\np.extend.Stage.name",
        "from pandion import extend\nextend.Stage",
        "from pandion import extend as x\nx.Stage",
        "from pandion.extend import Stage",
        "import pandion\npandion.Pipeline.from_dict",
    ],
)
def test_the_public_forms_pass(source):
    assert pandion_uses(source) and offenders(source) == []


def test_pandion_api_uses_only_public_pandion_names():
    assert list(SRC.rglob("*.py")), f"no Python files under {SRC}: the check would pass on nothing"
    offenders = [
        f"{path.relative_to(SRC)}: {entry}"
        for path in sorted(SRC.rglob("*.py"))
        for entry in pandion_uses(path.read_text(encoding="utf-8"))
        if not is_public(entry)
    ]
    assert not offenders, "pandion-api uses engine names: " + ", ".join(offenders)

"""The app uses only pandion's public names.

A module or name that starts with an underscore is private to the package and
may change without notice. The app (`api`, `scripts`)
must not import one, so that the package can change its insides freely and the
playground keeps testing the same API a package user gets.
"""

from __future__ import annotations

import ast
import importlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
APP_DIRS = ("api", "scripts")


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
)

#: Engine imports the app and its scripts still make, as "module:name". This
#: list may only shrink: a new engine import fails the first test below, and a
#: line the app no longer needs fails the second, so it is deleted in the same
#: commit as its last use. Part 5 deletes the list.
ENGINE_IMPORTS: frozenset[str] = frozenset(
    {
        "pandion.artifacts:ArtifactType",
        "pandion.embedding_cache:EmbeddingCache",
        "pandion.endpoints:EndpointRefused",
        "pandion.endpoints:guard_endpoint",
        "pandion.events:Emit",
        "pandion.events:event",
        "pandion.executor:run",
        "pandion.executor:sweep",
        "pandion.graph:Edge",
        "pandion.graph:Graph",
        "pandion.graph:GraphValidationError",
        "pandion.graph:Node",
        "pandion.llm:openai_client_kwargs",
        "pandion.models:ModelSettings",
        "pandion.models:preload_embedder",
        "pandion.models:preload_reranker",
        "pandion.payloads:ChunkSet",
        "pandion.payloads:Output",
        "pandion.payloads:Query",
        "pandion.payloads:RetrievalResult",
        "pandion.plugins.chunk:DocView",
        "pandion.plugins.chunk:count_tokens",
        "pandion.plugins.parse:docling",
        "pandion.ports:PortSpec",
        "pandion.ports:RunContext",
        "pandion.ports:Stage",
        "pandion.registry:Registry",
        "pandion.registry:UnknownTransformError",
        "pandion.registry:register",
        "pandion.registry:registry",
        "pandion.sources:Sources",
        "pandion.storage:META",
        "pandion.storage:Store",
        "pandion.textmatch:loosen",
        "pandion.textmatch:normalise",
        "pandion.textmatch:normalise_with_offsets",
        "pandion.transform:Explanation",
        "pandion.transform:Transform",
    }
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


def test_the_app_imports_the_engine_only_from_the_allow_list():
    new = sorted(engine_imports() - ENGINE_IMPORTS)
    assert not new, (
        "the app imports engine names that are not public and not on the allow-list: "
        + ", ".join(new)
        + ". Import them from pandion's public API (pandion, a stage namespace, "
        "pandion.extend), or make them public first."
    )


def test_the_allow_list_has_no_line_the_app_no_longer_needs():
    stale = sorted(ENGINE_IMPORTS - engine_imports())
    assert not stale, (
        "delete these from ENGINE_IMPORTS, the app no longer imports them: " + ", ".join(stale)
    )

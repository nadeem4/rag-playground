"""Read a pipeline dict step by step, for a site's rules (see Policy.check_run).

Every function here reads the pipeline file's shape, as `Pipeline.to_dict`
gives it, and the strategies' settings as `pandion.catalog()` describes them.
"""

from __future__ import annotations

import copy
from typing import Any

import pandion

#: (section, key, stage) for each step that is one block.
SINGLE = (
    ("index", "source", "source"),
    ("index", "parse", "parse"),
    ("index", "chunk", "chunk"),
    ("index", "store", "index"),
    ("retrieve", "rewrite", "query"),
    ("retrieve", "search", "retrieve"),
)
#: (section, key, stage) for each step that is a list of blocks.
LISTS = (("index", "clean", "clean"), ("retrieve", "rerank", "rerank"))


def _block(block: Any) -> dict[str, Any] | None:
    return block if isinstance(block, dict) and isinstance(block.get("use"), str) else None


def _section(config: dict[str, Any], name: str) -> dict[str, Any]:
    section = config.get(name)
    return section if isinstance(section, dict) else {}


def _blocks(config: dict[str, Any]) -> list[tuple[str, str, dict[str, Any]]]:
    """(where, stage, block) for every step in `config`; each block is the dict in `config`."""
    found: list[tuple[str, str, dict[str, Any]]] = []
    # index.embed is not visited: to_dict folds the embedder's settings into it,
    # and no embedder has a read-only setting or a custom endpoint today.
    for section, key, stage in SINGLE:
        block = _block(_section(config, section).get(key))
        if block:
            found.append((f"{section}.{key}", stage, block))
    for section, key, stage in LISTS:
        blocks = _section(config, section).get(key)
        for n, block in enumerate(blocks if isinstance(blocks, list) else [], start=1):
            if _block(block):
                found.append((f"{section}.{key}.{n}", stage, block))
    answer = _block(config.get("answer"))
    if answer:
        found.append(("answer", "use_case", answer))
    return found


def steps(config: dict[str, Any]) -> list[tuple[str, str, str, dict[str, Any]]]:
    """(where, stage, use, settings) for every step in `config`."""
    return [
        (where, stage, block["use"], {k: v for k, v in block.items() if k != "use"})
        for where, stage, block in _blocks(config)
    ]


def _properties(catalog: dict[str, Any], stage: str, use: str) -> dict[str, Any]:
    return catalog.get(stage, {}).get(use, {}).get("config_schema", {}).get("properties", {})


def custom_endpoint_steps(config: dict[str, Any], catalog: dict[str, Any] | None = None) -> list[str]:
    """The steps set to call a model at an address the request chose (an
    OpenAI-compatible endpoint): a server would send a request there."""
    catalog = catalog if catalog is not None else pandion.catalog()
    found = []
    for where, stage, use, settings in steps(config):
        field = _properties(catalog, stage, use).get("model") or {}
        providers = field.get("x-providers") or {}
        model = settings.get("model")
        if isinstance(model, str) and providers.get(model) == "openai_compatible":
            found.append(where)
    return found


def changed_read_only_settings(config: dict[str, Any], catalog: dict[str, Any] | None = None) -> list[str]:
    """Every setting marked readOnly (a prompt, a model revision) set to anything but its default."""
    catalog = catalog if catalog is not None else pandion.catalog()
    found = []
    for where, stage, use, settings in steps(config):
        for key, prop in _properties(catalog, stage, use).items():
            if prop.get("readOnly") and key in settings and settings[key] != prop.get("default"):
                found.append(f"{where}.{key}")
    return found


def without_read_only(config: dict[str, Any], catalog: dict[str, Any] | None = None) -> dict[str, Any]:
    """A copy of `config` without any setting marked readOnly (a prompt, a model
    revision), so each takes its default wherever the copy is read."""
    catalog = catalog if catalog is not None else pandion.catalog()
    out = copy.deepcopy(config)
    for _, stage, block in _blocks(out):
        for key, prop in _properties(catalog, stage, block["use"]).items():
            if prop.get("readOnly"):
                block.pop(key, None)
    return out

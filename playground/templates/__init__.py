"""Pipeline templates: starting points for a kind of document and a kind of question.

A document template (documents/*.yaml) holds the index side of a pipeline:
parse, clean, chunk, embed and store. A question template (questions/*.yaml)
holds the retrieve side and the answer. Each file also has a `template:` block
with its name, a one-line summary and what it is good for; a document template
names the bundled sample that suits it.

`compose` joins one of each into a full Pandion pipeline, in the pipeline
file's shape, without the `template:` blocks. It reads YAML only, so the
backend and the examples can both use it without reaching into Pandion.
"""

from __future__ import annotations

import copy
from functools import cache
from pathlib import Path
from typing import Any

import yaml

FOLDER = Path(__file__).resolve().parent
FAMILIES = ("documents", "questions")

#: Steps that call a chat model, so a pipeline with one needs an API key.
KEYED = {"llm_rewrite", "llm_rerank", "chat"}


@cache
def _load(family: str) -> dict[str, dict[str, Any]]:
    if family not in FAMILIES:
        raise ValueError(f"There is no template family '{family}'. The families are: {', '.join(FAMILIES)}.")
    return {
        file.stem: yaml.safe_load(file.read_text(encoding="utf-8"))
        for file in sorted((FOLDER / family).glob("*.yaml"))
    }


def load(family: str) -> dict[str, dict[str, Any]]:
    """Every template of `family` ("documents" or "questions"), by file name
    without .yaml, each as its file holds it. The result is a copy."""
    return copy.deepcopy(_load(family))


def _part(family: str, name: str) -> dict[str, Any]:
    found = load(family)
    if name not in found:
        kind = family[:-1]
        raise ValueError(f"There is no {kind} template named '{name}'. The {kind} templates are: {', '.join(found)}.")
    return {key: value for key, value in found[name].items() if key != "template"}


def compose(document: str, question: str, path: str = "./pandion-index") -> dict[str, Any]:
    """The full pipeline made of the `document` and `question` templates, named
    by file name, with `path` as the folder Pandion keeps its files in."""
    return {"path": path, **_part("documents", document), **_part("questions", question)}


def needs_key(question: str) -> bool:
    """True when the `question` template calls a chat model, which needs an API key."""
    part = _part("questions", question)
    steps = [part["retrieve"].get("rewrite"), *_listed(part["retrieve"].get("rerank")), part.get("answer")]
    return any(isinstance(step, dict) and step.get("use") in KEYED for step in steps)


def _listed(value: Any) -> list[Any]:
    return value if isinstance(value, list) else [value]

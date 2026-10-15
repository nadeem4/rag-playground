"""Pipeline templates: starting points for a kind of document and a kind of question.

A document template (templates/documents/*.yaml) sets the index side of a
pipeline: parse, clean, chunk, embed and store. A question template
(templates/questions/*.yaml) sets the retrieve side and the answer. Each file
also has a `template:` block with its name, a one-line summary and what it is
good for; a document template names the RAG Playground sample that suits it.

`list_templates` lists both families; `compose_template` joins one of each into
a full pipeline in the pipeline file's shape, ready for `Pipeline.from_dict`.
"""

from __future__ import annotations

import copy
from functools import cache
from pathlib import Path
from typing import Any

import yaml

FOLDER = Path(__file__).resolve().parent / "templates"
FAMILIES = ("documents", "questions")

#: Steps that call a chat model, so a pipeline with one needs an API key.
KEYED = {"llm_rewrite", "llm_rerank", "chat"}


@cache
def _files(family: str) -> dict[str, dict[str, Any]]:
    return {f.stem: yaml.safe_load(f.read_text(encoding="utf-8")) for f in sorted((FOLDER / family).glob("*.yaml"))}


def _needs_key(part: dict[str, Any]) -> bool:
    retrieve = part.get("retrieve") or {}
    rerank = retrieve.get("rerank")
    steps = [retrieve.get("rewrite"), *(rerank if isinstance(rerank, list) else [rerank]), part.get("answer")]
    return any(isinstance(step, dict) and step.get("use") in KEYED for step in steps)


def _entry(name: str, data: dict[str, Any], family: str) -> dict[str, Any]:
    part = {key: value for key, value in data.items() if key != "template"}
    entry = {"id": name, **data["template"], "pipeline": part}
    if family == "questions":
        entry["needs_key"] = _needs_key(part)
    return copy.deepcopy(entry)


def list_templates() -> dict[str, list[dict[str, Any]]]:
    """Both families, "documents" and "questions". Each template is its id (the
    file name), its name, summary and good_for, a document template's sample, a
    question template's needs_key, and `pipeline`, the part it sets."""
    return {family: [_entry(n, d, family) for n, d in _files(family).items()] for family in FAMILIES}


def _part(family: str, name: str) -> dict[str, Any]:
    found = _files(family)
    if name not in found:
        kind = family[:-1]
        raise ValueError(f"There is no {kind} template named '{name}'. The {kind} templates are: {', '.join(found)}.")
    return _entry(name, found[name], family)["pipeline"]


def compose_template(document: str, question: str, path: str = "./pandion-index") -> dict[str, Any]:
    """The pipeline made of the `document` and `question` templates, by id, with
    `path` as the folder its files go in: `Pipeline.from_dict(compose_template(...))`."""
    return {"path": path, **_part("documents", document), **_part("questions", question)}

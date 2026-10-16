"""Run one stage on its own, without a pipeline or a store.

These calls are for trying a stage: they run the strategy directly and cache
nothing. A pipeline runs the same strategies through the executor and the
store, which caches every step by its recipe hash.
"""

from __future__ import annotations

import hashlib
import mimetypes
import tempfile
import time
import types
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from pandion.formats import check_readable
from pandion.payloads import ChunkSet, ParsedDoc, Query
from pandion.plugins import discover
from pandion.ports import RunContext, Stage
from pandion.registry import UnknownTransformError, registry
from pandion.results import StageResult


def parse(source: str | Path, *, use: str, **config: Any) -> StageResult:
    """Parse one file with the parser named `use` and its settings.

    `config` holds the parser's settings by name, as in its config model, for
    example `pandion.parse("a.pdf", use="docling", do_ocr=True)`.
    """
    discover()
    cls, settings = _strategy(Stage.PARSE, use, config, where="The parser")
    path = Path(source)
    check_readable(use, path.name)
    raw = {
        "sha": hashlib.sha256(path.read_bytes()).hexdigest(),
        "filename": path.name,
        "path": str(path),
        "mime": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
    }
    with tempfile.TemporaryDirectory(prefix="pandion-") as scratch:
        ctx = RunContext(output_dir=Path(scratch), emit=lambda e: None, tmp=Path(scratch))
        started = time.perf_counter()
        payload = cls().apply({"file": raw}, settings, ctx)
        duration_ms = (time.perf_counter() - started) * 1000
    return StageResult(
        stage=str(Stage.PARSE),
        transform=use,
        output=ParsedDoc.model_validate(payload),
        duration_ms=duration_ms,
        note=ctx.extras.get("meta", {}).get("note"),
        usage=ctx.extras.get("meta", {}).get("usage"),
    )


def clean(doc: ParsedDoc | StageResult, *, steps: list[dict[str, Any]]) -> StageResult:
    """Run cleaners on one parsed document, one after another, in the order given.

    Each step names its cleaner with `use` and holds its settings by name, for
    example `pandion.clean(doc, steps=[{"use": "drop_matching", "pattern": "Draft"}])`.
    `doc` may be a `ParsedDoc` or the result of `pandion.parse`. The note has one
    line per step, `name: what it removed`, in the order the steps ran. `usage`
    is that of the last step that recorded one.
    """
    discover()
    current = doc.output if isinstance(doc, StageResult) else doc
    planned = [_clean_step(n, step) for n, step in enumerate(steps, start=1)]
    notes: list[str] = []
    usage = None
    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="pandion-") as scratch:
        for cls, settings in planned:
            ctx = RunContext(output_dir=Path(scratch), emit=lambda e: None, tmp=Path(scratch))
            out = cls().apply({"doc": current}, settings, ctx)
            current = out if isinstance(out, ParsedDoc) else ParsedDoc.model_validate(out)
            note = ctx.extras.get("meta", {}).get("note")
            if note:
                notes.append(f"{cls.name}: {note}")
            usage = ctx.extras.get("meta", {}).get("usage") or usage
    return StageResult(
        stage=str(Stage.CLEAN),
        transform=", ".join(cls.name for cls, _ in planned),
        output=current,
        duration_ms=(time.perf_counter() - started) * 1000,
        note="\n".join(notes) or None,
        usage=usage,
    )


def chunk(doc: ParsedDoc | StageResult, *, use: str, **config: Any) -> StageResult:
    """Cut one parsed document into pieces with the chunker named `use`.

    `config` holds the chunker's settings by name, as in its config model, for
    example `pandion.chunk(doc, use="recursive_character", chunk_size=400)`.
    `doc` may be a `ParsedDoc` or the result of `pandion.parse` or `pandion.clean`.
    """
    discover()
    cls, settings = _strategy(Stage.CHUNK, use, config, where="The chunker")
    current = doc.output if isinstance(doc, StageResult) else doc
    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="pandion-") as scratch:
        ctx = RunContext(output_dir=Path(scratch), emit=lambda e: None, tmp=Path(scratch))
        out = cls().apply({"doc": current}, settings, ctx)
    return StageResult(
        stage=str(Stage.CHUNK),
        transform=use,
        output=out if isinstance(out, ChunkSet) else ChunkSet.model_validate(out),
        duration_ms=(time.perf_counter() - started) * 1000,
        note=ctx.extras.get("meta", {}).get("note"),
        usage=ctx.extras.get("meta", {}).get("usage"),
    )


def rewrite(
    question: str,
    *,
    use: str,
    doc: ParsedDoc | StageResult | None = None,
    credentials: dict[str, str] | None = None,
    **config: Any,
) -> StageResult:
    """Turn one question into the query retrieval searches with.

    `use="text"` keeps the question as typed; `use="llm_rewrite"` asks a chat
    model to restate it in the document's words, keeping the question as typed
    in `Query.original`. `config` holds the step's settings by name, for
    example `pandion.rewrite(q, use="llm_rewrite", style="keywords")`. `doc`, a
    `ParsedDoc` or the result of `pandion.parse` or `pandion.clean`, lets the
    model read the start of the document. A model's key goes in `credentials`
    (for example `{"anthropic_api_key": ...}`), never in the settings.
    """
    discover()
    cls, settings = _strategy(
        Stage.QUERY, use, {**config, "text": question}, where="The query step"
    )
    if isinstance(doc, StageResult):
        doc = doc.output
    inputs = {} if doc is None else {"doc": doc}
    with tempfile.TemporaryDirectory(prefix="pandion-") as scratch:
        ctx = RunContext(output_dir=Path(scratch), emit=lambda e: None, tmp=Path(scratch))
        if credentials:
            ctx.extras["credentials"] = dict(credentials)
        started = time.perf_counter()
        out = cls().apply(inputs, settings, ctx)
    return StageResult(
        stage=str(Stage.QUERY),
        transform=use,
        output=Query.model_validate(out),
        duration_ms=(time.perf_counter() - started) * 1000,
        note=ctx.extras.get("meta", {}).get("note"),
        usage=ctx.extras.get("meta", {}).get("usage"),
    )


class StageModule(types.ModuleType):
    """A module that can be called: its `run`.

    `pandion.parse`, `pandion.clean`, `pandion.chunk` and `pandion.rewrite` are
    modules that hold their stage's step classes (`from pandion.parse import
    Docling`), and calling one runs its stage on its own, as before:
    `pandion.parse("a.pdf", use="pdfium")`.
    """

    def __call__(self, *args: Any, **kwargs: Any) -> StageResult:
        return self.run(*args, **kwargs)


def _clean_step(number: int, step: dict[str, Any]):
    """Look up one step's cleaner and check its settings, before anything runs."""
    settings = dict(step)
    use = settings.pop("use", None)
    if not use:
        raise ValueError(f"Clean step {number} does not say which cleaner to use.")
    return _strategy(Stage.CLEAN, use, settings, where=f"Clean step {number}")


def _strategy(stage: Stage, use: str, settings: dict[str, Any], *, where: str):
    """Find the strategy named `use` for `stage` and check its settings by name.

    The config models accept unknown fields, so a misspelt setting would be
    ignored without this check. `where` starts each message, so it names the
    step the caller asked for.
    """
    try:
        cls = registry.get(stage, use)
    except UnknownTransformError as exc:
        known = ", ".join(sorted(registry.all_for(stage)))
        raise UnknownTransformError(
            f"{where} uses '{use}', which is not a {stage} strategy. "
            f"The {stage} strategies are: {known}."
        ) from exc
    unknown = sorted(set(settings) - set(cls.config_model.model_fields))
    if unknown:
        names = ", ".join(f"'{name}'" for name in unknown)
        known = ", ".join(cls.config_model.model_fields)
        raise ValueError(
            f"{where} ({use}) has no setting {names}. Its settings are: {known}."
        )
    try:
        return cls, cls.config_model(**settings)
    except ValidationError as exc:
        raise ValueError(f"{where} ({use}): {_problems(exc)}.") from None


def _problems(exc: ValidationError) -> str:
    """Pydantic's errors on one line: each setting, and what is wrong with it."""
    return "; ".join(
        f"{'.'.join(map(str, e['loc'])) or 'settings'}: {e['msg'].rstrip('.')}"
        for e in exc.errors()
    )

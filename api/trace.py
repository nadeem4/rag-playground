"""Why did this miss? Follow one question's answer down the pipeline.

The eval step says whether the answer sentence was in the top k pieces. This
says where it was lost: in the parsed text, after each cleaner, inside one
piece, among the pieces that came back, after a reranker, or above the cut.
The steps are checked in order and the trace stops at the first one that no
longer holds the answer; the steps after it are not checked.

Matching is the eval step's own: exact containment, then its normalised form
(line hyphens rejoined, whitespace collapsed, case folded). A parsed text that
holds every word of the answer in order, but with other text between them, is
"broken" rather than "missing", and the evidence shows which words are which.
That is what a parser that reads straight across two columns does.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from core.payloads import ChunkSet, RetrievalResult
from plugins.chunk import DocView
from plugins.use_case.eval import _normalise

#: How far apart the answer's words may be spread and still count as one
#: broken sentence, as a multiple of the answer's own length in words.
SPREAD = 3
#: Words of context shown either side of a broken answer.
CONTEXT = 12
#: How many of the answer's first and last words find the pieces it was cut into.
EDGE = 4
#: Fewer words than this in the parsed text suggests a scanned page.
SCANNED = 20

FIX = {
    "parse_broken": "Use a parser that reads the page layout, such as Docling, then evaluate again.",
    "parse_missing": "Try another parser, or turn on OCR if the page is scanned.",
    "clean": "Turn that cleaner off, or change its settings.",
    "chunk": "Use bigger pieces, more overlap, or cut By sentence.",
    "search": "Try keyword or hybrid search, or rewrite the question.",
    "rerank": "Try another reranker, or keep more pieces after reranking.",
    "top_k": "Add a reranker, or check more pieces.",
}

_PUNCT = re.compile(r"^\W+|\W+$")


@dataclass
class StepInput:
    """A step's plain name and its output payload."""

    name: str
    payload: Any


def ordinal(n: int) -> str:
    if 10 <= n % 100 <= 20:
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def _holds(text: str, golds: list[str]) -> bool:
    normalised = _normalise(text)
    return any(g in text or _normalise(g) in normalised for g in golds)


def _word(w: str) -> str:
    return _PUNCT.sub("", w).casefold()


def _broken(text: str, golds: list[str]) -> list[dict[str, str]] | None:
    """The answer's words in order with other text between them, as parts; None when not there."""
    words = re.sub(r"-\s*\n\s*", "", text).split()
    keys = [_word(w) for w in words]
    best: tuple[int, list[int]] | None = None
    for gold in golds:
        want = [k for k in (_word(w) for w in gold.split()) if k]
        if not want:
            continue
        limit = SPREAD * len(want)
        for start, key in enumerate(keys):
            if key != want[0]:
                continue
            picked = [start]
            j = start
            for w in want[1:]:
                j += 1
                while j < len(keys) and j - start < limit and keys[j] != w:
                    j += 1
                if j >= len(keys) or j - start >= limit:
                    break
                picked.append(j)
            if len(picked) == len(want) and (best is None or picked[-1] - picked[0] < best[0]):
                best = (picked[-1] - picked[0], picked)
    if best is None:
        return None
    picked = best[1]
    chosen = set(picked)
    first, last = picked[0], picked[-1]
    lo, hi = max(0, first - CONTEXT), min(len(words), last + 1 + CONTEXT)
    parts: list[dict[str, str]] = []

    def add(kind: str, word: str) -> None:
        if parts and parts[-1]["kind"] == kind:
            parts[-1]["text"] += " " + word
        else:
            parts.append({"kind": kind, "text": word})

    for i in range(lo, hi):
        if i < first or i > last:
            add("context", words[i])
        else:
            add("answer" if i in chosen else "other", words[i])
    return parts


def _first(result: RetrievalResult, golds: list[str]) -> int | None:
    """The rank of the first hit that holds the answer."""
    for hit in result.hits:
        if _holds(hit.chunk.text, golds):
            return hit.rank
    return None


def trace(
    *,
    golds: list[str],
    parse: StepInput,
    cleans: list[StepInput],
    chunks: Any,
    retrieve: Any,
    final: Any | None,
    rerank_name: str | None,
    top_k: int,
) -> dict[str, Any]:
    golds = [g for g in (g.strip() for g in golds) if g]
    steps: list[dict[str, Any]] = []
    lost: str | None = None
    fix: str | None = None
    finding = "Found. The answer came through every step."

    def step(stage: str, name: str, status: str, sentence: str, evidence: Any = None) -> None:
        steps.append({"stage": stage, "name": name, "status": status, "sentence": sentence, "evidence": evidence})

    def skip(stage: str, name: str) -> None:
        step(stage, name, "not_checked", "Not checked.")

    # Parse.
    text = DocView.of(parse.payload).text
    if _holds(text, golds):
        step("parse", "Parse", "pass", "The answer sentence is in the parsed text.")
    else:
        parts = _broken(text, golds)
        if parts:
            step("parse", "Parse", "lost", "The answer's words are here, in order, with other text between them.",
                 {"kind": "broken", "parts": parts})
            finding = (f"Lost at Parse. {parse.name} put other text in the middle of the answer sentence, "
                       "so no later step can find it.")
            fix = FIX["parse_broken"]
        elif len(text.split()) < SCANNED:
            step("parse", "Parse", "lost",
                 "The parsed text has almost no words, so the page may be scanned.")
            finding = f"Lost at Parse. {parse.name} found almost no text."
            fix = FIX["parse_missing"]
        else:
            step("parse", "Parse", "lost", "The answer's words are not in the parsed text.")
            finding = f"Lost at Parse. The answer is not in the text {parse.name} produced."
            fix = FIX["parse_missing"]
        lost = "parse"

    # Clean, each step in order.
    for clean in cleans:
        if lost:
            skip("clean", "Clean")
            continue
        if _holds(DocView.of(clean.payload).text, golds):
            step("clean", "Clean", "pass", f"Still there after {clean.name}.")
        else:
            step("clean", "Clean", "lost", f"Parse had it, and {clean.name} removed it.")
            finding = f"Lost at Clean. {clean.name} removed the block that held the answer."
            fix = FIX["clean"]
            lost = "clean"

    # Chunk.
    piece: int | None = None
    if lost:
        skip("chunk", "Chunk")
    else:
        pieces = ChunkSet.model_validate(chunks).chunks
        holding = [i for i, c in enumerate(pieces) if _holds(c.text, golds)]
        if holding:
            piece = holding[0] + 1
            step("chunk", "Chunk", "pass", f"Whole inside piece {piece} of {len(pieces)}.")
        else:
            gold_words = golds[0].split()
            head = " ".join(gold_words[:EDGE])
            tail = " ".join(gold_words[-EDGE:])
            starts = [i for i, c in enumerate(pieces) if _holds(c.text, [head])]
            ends = [i for i, c in enumerate(pieces) if _holds(c.text, [tail])]
            if starts and ends and ends[-1] > starts[0]:
                a, b = starts[0] + 1, ends[-1] + 1
                step("chunk", "Chunk", "lost",
                     f"The answer is cut across pieces {a} and {b}, so no single piece holds it.")
                finding = f"Lost at Chunk. The answer is cut across pieces {a} and {b}."
            else:
                step("chunk", "Chunk", "lost", "No piece holds the whole answer.")
                finding = "Lost at Chunk. No piece holds the whole answer."
            fix = FIX["chunk"]
            lost = "chunk"

    # Search: the retrieve step's own order.
    rank: int | None = None
    label = f"piece {piece}" if piece else "the answer"
    if lost:
        skip("search", "Search")
    else:
        found = RetrievalResult.model_validate(retrieve)
        rank = _first(found, golds)
        n = len(found.hits)
        if rank is None:
            step("search", "Search", "lost",
                 f"Piece {piece} holds the answer, but it was not among the {n} "
                 f"{'piece' if n == 1 else 'pieces'} that came back.")
            finding = f"Lost at Search. Piece {piece} holds the answer, but search did not return it."
            fix = FIX["search"]
            lost = "search"
        else:
            step("search", "Search", "pass", f"{label.capitalize()} came back {ordinal(rank)} of {n}.")

    # Rerank, when there is one.
    if rerank_name and final is not None:
        if lost:
            skip("rerank", "Rerank")
        else:
            after = RetrievalResult.model_validate(final)
            rank = _first(after, golds)
            n = len(after.hits)
            if rank is None:
                step("rerank", "Rerank", "lost",
                     f"{rerank_name} kept {n} {'piece' if n == 1 else 'pieces'}, and {label} was not among them.")
                finding = f"Lost at Rerank. {rerank_name} dropped {label}."
                fix = FIX["rerank"]
                lost = "rerank"
            else:
                step("rerank", "Rerank", "pass", f"After {rerank_name}, {label} is {ordinal(rank)} of {n}.")

    # Top k: the pieces the reader would look at.
    name = f"Top {top_k}"
    checked = f"{top_k} {'piece' if top_k == 1 else 'pieces'} checked"
    if lost:
        skip("top_k", name)
    elif rank is not None and rank <= top_k:
        step("top_k", name, "pass", f"{ordinal(rank)}, inside the {checked}.")
    else:
        below = f"{label.capitalize()} came back {ordinal(rank or 0)}, below the {checked}."
        step("top_k", name, "lost", below)
        finding = f"Lost at {name}. {below}"
        fix = FIX["top_k"]
        lost = "top_k"

    return {"finding": finding, "lost_at": lost, "fix": fix, "golds": golds, "steps": steps}

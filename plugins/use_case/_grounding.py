"""Sentence-id grounding (I-19): the model points, and we quote.

Any model can cite this way, not only one with a citations API:

1. `number_sources` cuts every retrieved chunk into sentences and gives each an
   id, `"<chunk>.<sentence>"`, both 1-based. The prompt shows the ids.
2. The model answers and puts the ids it relied on in brackets after each
   claim, like `[2.2]` or `[2.2][4.1]`.
3. `parse_answer` splits the answer at each run of markers. The text before a
   run is a claim with those ids; trailing text with no marker is a claim with
   none. Markers are stripped from what is shown, and an id that was never
   shown to the model is counted and dropped.
4. `ground` checks each claim against the sentences with the index's own
   embedder, so the quote is always our text, never the model's:

   - `cited`: it has ids, and the best cosine to its cited sentences reaches
     the threshold;
   - `weak`: it has ids, but none of them reaches the threshold;
   - `similarity`: no ids (and none invented), but some shown sentence reaches the threshold, and
     the best one becomes its citation;
   - `none`: no ids and nothing reaches the threshold, or every id it gave was invented.

   A piece with no letters or digits (". ") is not a claim: its label is None.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Sequence

from plugins.use_case._sentences import split_sentences

#: One marker, and a run of adjacent markers (spaces allowed between them).
MARKER = re.compile(r"\[(\d+)\.(\d+)\]")
RUN = re.compile(r"\[\d+\.\d+\](?:[ \t]*\[\d+\.\d+\])*")
#: Text that may follow a run and belongs to the claim before it, so the space
#: before the run goes: "claim [1.1]." reads "claim.".
_TIGHT = re.compile(r"$|[.,;:!?)\]]")

Embed = Callable[[list[str]], Sequence[Sequence[float]]]


@dataclass(frozen=True)
class Sentence:
    chunk_index: int  # 0-based position in the chunk list
    start: int  # offsets into that chunk's text
    end: int
    text: str


@dataclass
class Claim:
    text: str
    ids: list[str] = field(default_factory=list)
    #: How many of the claim's markers named no shown sentence (invented ids).
    invalid: int = 0


@dataclass
class GroundedClaim:
    text: str
    label: str | None  # "cited" | "weak" | "similarity" | "none" | None
    #: (sentence id, cosine) per citation, in the order the model gave them.
    citations: list[tuple[str, float]] = field(default_factory=list)


def number_sources(chunks: Sequence[Any]) -> tuple[str, dict[str, Sentence]]:
    """The prompt block and the id table. `chunks` need only a `.text`."""
    table: dict[str, Sentence] = {}
    blocks: list[str] = []
    for c, chunk in enumerate(chunks, start=1):
        lines = [f"Source {c}:"]
        for s, (start, end) in enumerate(split_sentences(chunk.text), start=1):
            sid = f"{c}.{s}"
            table[sid] = Sentence(c - 1, start, end, chunk.text[start:end])
            lines.append(f"[{sid}] {' '.join(chunk.text[start:end].split())}")
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks), table


def parse_answer(text: str, table: dict[str, Sentence]) -> tuple[list[Claim], int]:
    """(claims, unknown_ids) from an answer with `[c.s]` markers."""
    claims: list[Claim] = []
    unknown = 0
    pos = 0
    for run in RUN.finditer(text):
        before = text[pos : run.start()]
        if _TIGHT.match(text, run.end()):
            before = before.rstrip()
        ids: list[str] = []
        invalid = 0
        for a, b in MARKER.findall(run.group()):
            sid = f"{int(a)}.{int(b)}"
            if sid not in table:
                invalid += 1
            elif sid not in ids:
                ids.append(sid)
        unknown += invalid
        claims.append(Claim(before, ids, invalid))
        pos = run.end()
    if text[pos:]:
        claims.append(Claim(text[pos:], []))
    return claims, unknown


def ground(
    claims: Sequence[Claim],
    table: dict[str, Sentence],
    embed: Embed,
    threshold: float,
) -> list[GroundedClaim]:
    """Label every claim; see the module docstring for the rules."""
    real = [i for i, c in enumerate(claims) if _is_claim(c.text)]
    ids = list(table)
    claim_vecs = _unit(embed([claims[i].text.strip() for i in real])) if real else []
    sent_vecs = (
        dict(zip(ids, _unit(embed([table[i].text for i in ids])))) if real and ids else {}
    )

    out = [GroundedClaim(c.text, None) for c in claims]
    for i, vec in zip(real, claim_vecs):
        claim = claims[i]
        if claim.ids:
            sims = [(sid, _dot(vec, sent_vecs[sid])) for sid in claim.ids]
            best = max(s for _, s in sims)
            out[i].label = "cited" if best >= threshold else "weak"
            out[i].citations = sims
            continue
        if claim.invalid:
            # The model tried to cite and invented the id: flag it, never rescue it.
            out[i].label = "none"
            continue
        best_id, best = None, -math.inf
        for sid in ids:
            s = _dot(vec, sent_vecs[sid])
            if s > best:
                best_id, best = sid, s
        if best_id is not None and best >= threshold:
            out[i].label = "similarity"
            out[i].citations = [(best_id, best)]
        else:
            out[i].label = "none"
    return out


def _is_claim(text: str) -> bool:
    return any(ch.isalnum() for ch in text)


def _unit(vectors: Sequence[Sequence[float]]) -> list[list[float]]:
    out = []
    for v in vectors:
        norm = math.sqrt(sum(x * x for x in v))
        out.append([x / norm for x in v] if norm else list(v))
    return out


def _dot(a: Sequence[float], b: Sequence[float]) -> float:
    return float(sum(x * y for x, y in zip(a, b)))

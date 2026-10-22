"""Evaluate a pipeline on a question set, and compare settings: the public names.

A question set is the JSON format the bundled samples use (a list of
questions, or an object with a "questions" list), or a CSV file with the same
columns, or the same list in code. Each question has `question` and at least
one gold passage (`gold_answer` or `gold_answers`): the sentence in the
document that answers it. `id`, `answer`, `tags` and `document` are optional. A question that names its
`document` (by id, filename or content hash) is found only in a piece from
that document; one that names none is found in a piece from any.
`trace` follows one question's answer down a finished run and says the first step
that lost it. `evaluate` asks every question in a set and runs `trace` for every miss.
`report.against(baseline)` says which questions a run newly missed or newly found.
`compare` runs a pipeline once per variant of one stage and evaluates each.
See docs/pandion.md, "Evaluate a pipeline" and "Compare settings".
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
import statistics
import threading
from dataclasses import asdict, dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Callable

from pandion.config import ConfigError, _block, from_dict, to_dict
from pandion.cost import STAGE_ORDER, total_cost
from pandion.cost import cost as _cost
from pandion.events import event
from pandion.payloads import ChunkSet, Query, RetrievalResult
from pandion.pipeline import IndexReport, Pipeline, Retrieval
from pandion.plugins import discover
from pandion.plugins.answer.eval import EvalConfig
from pandion.plugins.chunk import DocView
from pandion.ports import Stage
from pandion.questions import (
    GOLD_SEPARATOR,
    QuestionSetError,
    check_questions,
    check_questions_across,
    load_questions,
    parse_question_set,
)
from pandion.question_writer import write_questions
from pandion.registry import registry
from pandion.results import StageResult
from pandion.textmatch import first_matches
from pandion.trace import StepInput, _holds, trace

__all__ = [
    "COMPARE_STAGES",
    "DEFAULT_TOP_K",
    "Comparison",
    "Comparisons",
    "EvaluationReport",
    "GOLD_SEPARATOR",
    "GoldFound",
    "QuestionResult",
    "QuestionSetError",
    "Regression",
    "StepInput",
    "best",
    "check_questions",
    "check_questions_across",
    "compare",
    "document_text",
    "documents_named",
    "evaluate",
    "find_gold",
    "load_baseline",
    "load_questions",
    "paragraph_spans",
    "parse_question_set",
    "regression",
    "trace",
    "write_questions",
]


#: How many of the top pieces count when looking for the answer, unless a
#: caller says: the eval step's own default, so `evaluate`, `compare` and an
#: app reading the catalog agree.
DEFAULT_TOP_K: int = EvalConfig.model_fields["top_k"].default


def document_text(doc: Any) -> str:
    """A parsed document's text, as the chunkers cut it and as `check_questions`
    looks for gold passages in it. `doc` is a ParsedDoc, what `pandion.parse`
    returns, or a stored parse result."""
    if isinstance(doc, StageResult):
        doc = doc.output
    return DocView.of(doc).text


def paragraph_spans(doc: Any) -> list[tuple[int, int]]:
    """Where each paragraph starts and ends in `document_text(doc)`, in order."""
    if isinstance(doc, StageResult):
        doc = doc.output
    return [(e.md_start, e.md_end) for e in DocView.of(doc).rendered if e.type == "paragraph"]


@dataclass(frozen=True)
class GoldFound:
    """Where `find_gold` found a gold passage: the place of the first text that
    holds any of them, the passage it holds, and how it matched ("exact",
    "normalized" or "reworded", as the eval step reports it)."""

    index: int
    gold: str
    match: str


def find_gold(golds: list[str], texts: list[str]) -> GoldFound | None:
    """The first of `texts` that holds any of the gold passages, by the eval
    step's own rule, or None when none does. `texts` are pieces in the order a
    reader meets them, such as a retrieval's hits; where one piece holds
    several passages, the first passage in `golds` is the one named."""
    placed = sorted((first[0], n, first[1]) for n, first in enumerate(first_matches(golds, texts)) if first)
    if not placed:
        return None
    index, n, kind = placed[0]
    return GoldFound(index=index, gold=golds[n], match=kind)


@dataclass
class QuestionResult:
    """One question's verdict.

    `found` and `rank` are the eval step's: the answer is in the top `top_k`
    pieces, and the rank of the first piece that holds it. For a miss,
    `lost_at` is the first step that lost the answer (parse, clean, chunk,
    search, rerank or top_k) and `trace` says why, step by step, with the
    document it was traced in. `score` is the eval step's whole payload.
    `error` says which retrieval step failed, when one did; the question is
    then left out of the rates. `retrieval` is what `p.retrieve` returned.
    A question with no `id` in the set is named by its place, "question 3".
    `document` is the document the question names, by its content hash (its
    location, for a source other than upload), or None when it names none.
    """

    id: str
    question: str
    golds: list[str]
    tags: list[str]
    found: bool
    rank: int | None
    lost_at: str | None
    trace: dict[str, Any] | None
    score: dict[str, Any]
    error: str | None = None
    retrieval: Retrieval | None = field(default=None, repr=False)
    document: str | None = None

    @property
    def result_id(self) -> str | None:
        """The artifact id of the retrieval's final result (the last
        reranker's, or the search's), or None when retrieval failed."""
        if self.retrieval is None or not self.retrieval.ok:
            return None
        return self.retrieval._steps()[-1].artifact_id

    def to_dict(self) -> dict[str, Any]:
        """Plain JSON, without the retrieval, but with its final result's id
        (`result_id`), so the hit rows can be fetched by id."""
        return {
            "id": self.id,
            "question": self.question,
            "golds": list(self.golds),
            "tags": list(self.tags),
            "found": self.found,
            "rank": self.rank,
            "lost_at": self.lost_at,
            "trace": self.trace,
            "score": dict(self.score),
            "error": self.error,
            "result_id": self.result_id,
            "document": self.document,
        }


@dataclass
class EvaluationReport:
    """Every question's verdict, at `top_k` pieces checked, and the totals."""

    top_k: int
    questions: list[QuestionResult]
    #: A cancel stopped the run before every question was asked.
    cancelled: bool = False
    #: The searched documents' content hashes (or locations, for a source
    #: other than upload), sorted.
    document_shas: list[str] = field(default_factory=list)
    #: The retrieval steps that may give a different result each run, such as llm_rerank.
    nondeterministic: list[str] = field(default_factory=list)

    @property
    def total(self) -> int:
        return len(self.questions)

    @property
    def found(self) -> int:
        return sum(q.found for q in self.questions)

    def _steps(self) -> list[StageResult]:
        return [s for q in self.questions if q.retrieval is not None for s in q.retrieval._costed()]

    def cost(
        self,
        prices: dict[str, tuple[float, float]] | None = None,
        *,
        since: str | None = None,
        before: str | None = None,
    ) -> dict[str, Any]:
        """Seconds, tokens, estimated dollars and the cache share of every
        question's search; see `pandion.cost.cost`. `prices` replaces
        `pandion.llm.PRICES`; `since` and `before` keep part of each run."""
        return _cost(self._costed(), prices, since=since, before=before)

    def _costed(self) -> list[StageResult]:
        return self._steps()

    def totals(self) -> dict[str, Any]:
        """The numbers for the whole set; see `_totals`."""
        return _totals(self.questions)

    def by_tag(self) -> dict[str, dict[str, Any]]:
        """The same numbers for the questions carrying each tag."""
        tags = sorted({tag for q in self.questions for tag in q.tags})
        return {tag: _totals([q for q in self.questions if tag in q.tags]) for tag in tags}

    def by_document(self) -> list[dict[str, Any]]:
        """The same numbers for the questions naming each document, in the
        order the set first names them, then for the questions naming none.
        Each entry's `document` is the one in `QuestionResult.document`. A
        document no question names has no entry, nor do the questions naming
        none when every question names one."""
        named = list(dict.fromkeys(q.document for q in self.questions if q.document is not None))
        out = [{"document": d, **_totals([q for q in self.questions if q.document == d])} for d in named]
        unnamed = [q for q in self.questions if q.document is None]
        if unnamed:
            out.append({"document": None, **_totals(unnamed)})
        return out

    def __str__(self) -> str:
        """One plain line per question, then the totals."""
        lines = [_line(q) for q in self.questions]
        t = self.totals()
        total = f"Found {t['found']} of {t['scored']}"
        if t["scored"]:
            total += f" ({t['hit_rate']:.0%}). Mean reciprocal rank {t['mrr']:.2f}."
        else:
            total += "."
        failed = t["total"] - t["scored"]
        if failed:
            total += f" {failed} question{'' if failed == 1 else 's'} could not be scored."
        out = [*lines, total]
        if self.cancelled:
            out.append("Stopped before every question was asked.")
        return "\n".join(out)

    def to_dict(self) -> dict[str, Any]:
        """Plain JSON: the totals, the totals by tag and by document, and every question, with
        what `against` needs to compare a later run with this one: the
        question set's fingerprint, the document shas and `top_k`."""
        return {
            "top_k": self.top_k,
            "cancelled": self.cancelled,
            "questions_fingerprint": _fingerprint([q.to_dict() for q in self.questions]),
            "document_shas": list(self.document_shas),
            "nondeterministic": list(self.nondeterministic),
            **self.totals(),
            "by_tag": self.by_tag(),
            "by_document": self.by_document(),
            "questions": [q.to_dict() for q in self.questions],
        }

    def against(self, baseline: EvaluationReport | dict[str, Any] | str | Path) -> Regression:
        """This run compared with `baseline`: an earlier report, its `to_dict()`,
        or the path of a file `pandion eval --json` wrote. Questions are paired
        by id, or by their text when the set gave them no id. See `Regression`."""
        return regression(self, baseline)


@dataclass
class Regression:
    """What `EvaluationReport.against` returns.

    `compared` questions are in both runs; `found_before` and `found_now`
    count the found ones among them. `newly_missed` and `newly_found` are
    their ids. `unmatched` names the questions only one run asked: this
    run's first, then the baseline's. `partial` is True when the question
    sets or `top_k` differ, and `notes` says so, and warns when a step that
    is not deterministic may have made a question miss by chance.
    """

    found_before: int
    found_now: int
    compared: int
    newly_missed: list[str]
    newly_found: list[str]
    unmatched: list[str]
    partial: bool
    notes: list[str]

    def ok(self, allow: int = 0) -> bool:
        """At most `allow` questions were newly missed."""
        return len(self.newly_missed) <= allow

    def to_dict(self) -> dict[str, Any]:
        return {**asdict(self), "ok": self.ok()}

    def __str__(self) -> str:
        line = f"Found {self.found_now} of {self.compared}; the baseline found {self.found_before} of {self.compared}."
        if self.newly_missed:
            line += " Newly missed: " + ", ".join(self.newly_missed) + "."
        if self.newly_found:
            line += " Newly found: " + ", ".join(self.newly_found) + "."
        return "\n".join([line, *self.notes])


#: A question with no id in its set is named by its place, which moves when the set is reordered.
_POSITIONAL = re.compile(r"question \d+")


def _fingerprint(questions: list[dict[str, Any]]) -> str:
    """A hash of the questions and their gold passages, whatever their order."""
    entries = sorted(json.dumps([q["question"], sorted(q["golds"])]) for q in questions)
    return hashlib.sha256(json.dumps(entries).encode("utf-8")).hexdigest()


def load_baseline(baseline: EvaluationReport | dict[str, Any] | str | Path) -> dict[str, Any]:
    """A baseline for `against` as a report's dict: from a report, a dict, or
    a file `pandion eval --json` wrote. A missing or wrong file is a
    ValueError with a plain sentence."""
    return _report(baseline, "The baseline")


def _report(report: EvaluationReport | dict[str, Any] | str | Path, name: str) -> dict[str, Any]:
    """`load_report` for a report `name` names in its refusal."""
    if isinstance(report, EvaluationReport):
        return report.to_dict()
    if isinstance(report, (str, Path)):
        name = str(report)
        try:
            report = json.loads(Path(report).read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise ValueError(
                f"There is no baseline file at {name}. Save one with pandion eval ... --json > {name}."
            ) from None
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError(f"{name} cannot be read as JSON: {exc}") from None
    if not isinstance(report, dict) or not isinstance(report.get("questions"), list):
        raise ValueError(
            f"{name} is not an evaluation report. Save one with pandion eval ... --json, "
            "or pass a report or its to_dict()."
        )
    return report


def regression(
    now: EvaluationReport | dict[str, Any], baseline: EvaluationReport | dict[str, Any] | str | Path
) -> Regression:
    """`now` compared with `baseline`, as `EvaluationReport.against` compares
    them: each a report or its `to_dict()`, and the baseline also the path of
    a file `pandion eval --json` wrote. A dict needs only what the comparison
    reads: `top_k`, and each question's `id`, `question`, `found` and `error`,
    with the set's `questions_fingerprint` or every question's `golds`. A
    report that is not one is a ValueError with a plain sentence."""
    return _regression(_report(now, "The run to compare"), load_baseline(baseline))


def _key(q: dict[str, Any]) -> tuple[str, str]:
    return ("text", q["question"]) if _POSITIONAL.fullmatch(q["id"]) else ("id", q["id"])


def _regression(now: dict[str, Any], before: dict[str, Any]) -> Regression:
    """Pair the questions by id, then the rest by text, then count and name the changes."""
    partner: dict[int, dict[str, Any]] = {}  # index in now -> baseline question
    taken: set[int] = set()  # id() of paired baseline questions
    by_id = {b["id"]: b for b in before["questions"] if _key(b)[0] == "id"}
    for n, q in enumerate(now["questions"]):
        b = by_id.get(q["id"]) if _key(q)[0] == "id" else None
        if b is not None and id(b) not in taken:
            partner[n] = b
            taken.add(id(b))
    for n, q in enumerate(now["questions"]):
        if n in partner:
            continue
        b = next((b for b in before["questions"] if id(b) not in taken and b["question"] == q["question"]), None)
        if b is not None:
            partner[n] = b
            taken.add(id(b))
    unmatched = [q["id"] for n, q in enumerate(now["questions"]) if n not in partner]
    unmatched += [b["id"] for b in before["questions"] if id(b) not in taken]
    every = [(now["questions"][n], b) for n, b in sorted(partner.items())]
    pairs = [(q, b) for q, b in every if q.get("error") is None and b.get("error") is None]
    notes: list[str] = []
    errored = len(every) - len(pairs)
    if errored:
        notes.append(
            f"{errored} question{' could' if errored == 1 else 's could'} not be scored and "
            f"{'is' if errored == 1 else 'are'} left out."
        )
    fingerprint = before.get("questions_fingerprint") or _fingerprint(before["questions"])
    partial = fingerprint != (now.get("questions_fingerprint") or _fingerprint(now["questions"]))
    if partial:
        notes.append(
            f"The question sets differ, so only the {len(pairs)} questions both runs share are compared."
        )
    if before.get("top_k") != now.get("top_k"):
        partial = True
        notes.append(
            f"The baseline checked the top {before.get('top_k')} pieces and this run the top "
            f"{now.get('top_k')}, so the counts are not like for like."
        )
    if before.get("document_shas") and before["document_shas"] != now.get("document_shas"):
        notes.append("The documents differ from the baseline's.")
    shaky = sorted({*now.get("nondeterministic", []), *before.get("nondeterministic", [])})
    if shaky:
        notes.append(
            f"{', '.join(shaky)} can give a different result each run, so a newly missed "
            "question may be noise. Run it again before you trust the change."
        )
    return Regression(
        found_before=sum(b["found"] for _, b in pairs),
        found_now=sum(q["found"] for q, _ in pairs),
        compared=len(pairs),
        newly_missed=[q["id"] for q, b in pairs if b["found"] and not q["found"]],
        newly_found=[q["id"] for q, b in pairs if q["found"] and not b["found"]],
        unmatched=unmatched,
        partial=partial,
        notes=notes,
    )


def best(reports: list[EvaluationReport] | list[dict[str, Any]]) -> list[int]:
    """The places of the best reports, every one tied for first: the highest
    hit rate (found out of scored), then the highest mean reciprocal rank.
    Each is a report or its `to_dict()` (only its totals are read). Empty
    when no report was scored or none found an answer. `compare` names its
    best variant by this rule."""
    totals = [r.totals() if isinstance(r, EvaluationReport) else r for r in reports]
    scored = [n for n, t in enumerate(totals) if t.get("scored")]
    if not any(totals[n].get("found") for n in scored):
        return []

    def key(n: int) -> tuple[float, float]:
        return (totals[n].get("hit_rate") or 0.0, totals[n].get("mrr") or 0.0)

    top = key(max(scored, key=key))
    return [n for n in scored if key(n) == top]


def _line(q: QuestionResult) -> str:
    """One question's verdict in plain words."""
    if q.error is not None:
        return f"{q.id} error: {q.error}"
    if q.found:
        return f"{q.id} found at rank {q.rank}"
    finding = (q.trace or {}).get("finding") or f"Lost at {q.lost_at}."
    return f"{q.id} missed. {finding}"


def _totals(questions: list[QuestionResult]) -> dict[str, Any]:
    """Hit rate, mean reciprocal rank, recall and ranks, over the scored questions.

    The same arithmetic as the Evaluate page's metrics: a question whose
    retrieval failed is not scored; a miss counts zero towards the mean
    reciprocal rank; recall counts gold passages and is None when every
    question has one; the ranks are the found questions'.
    """
    scored = [q for q in questions if q.error is None]
    n = len(scored)
    found = [q for q in scored if q.found]
    ranks = sorted(q.rank for q in found if q.rank is not None)
    golds_total = sum(q.score.get("golds_total", 0) for q in scored)
    golds_found = sum(q.score.get("golds_found", 0) for q in scored)
    several = any(q.score.get("golds_total", 0) > 1 for q in scored)
    return {
        "total": len(questions),
        "scored": n,
        "found": len(found),
        "hit_rate": len(found) / n if n else None,
        "mrr": sum(1 / q.rank for q in found if q.rank) / n if n else None,
        "recall": golds_found / golds_total if several and golds_total else None,
        "mean_rank": sum(ranks) / len(ranks) if ranks else None,
        "median_rank": float(statistics.median(ranks)) if ranks else None,
    }


def evaluate(
    p: Pipeline,
    questions: str | Path | list[dict] | dict,
    top_k: int = DEFAULT_TOP_K,
    documents: Any = None,
    *,
    credentials: dict[str, str] | None = None,
    on_event: Callable[[dict[str, Any]], None] | None = None,
    cancel: threading.Event | None = None,
) -> EvaluationReport:
    """Search for every question in `questions` and say whether the answer came back.

    `questions` is a question set: a path to a JSON or CSV file in the format
    the bundled samples use, or the same list (or dict) in code. It is checked
    before anything runs. `top_k` is how many of the top pieces count, which
    is what a reader would look at. With `documents` (what `index.run`
    takes), each question searches exactly those documents, indexed first
    through the cache when needed; without it, the search covers what `p.index`
    indexed last. Each question is scored by the `eval` step, the one the
    playground's Evaluate page runs, and a miss is traced down the steps to
    the first one that lost it. A question that names its `document` (by id,
    filename or content hash) is found only in a piece from that document,
    and its miss is traced there; one naming a document that is not searched
    is a QuestionSetError before anything runs. A question naming none is
    found in a piece from any document. (With a source other than upload, a
    question names a document by its location or the location's last part,
    but the content is not known before it is read, so there a named question
    is found in any document too.) A model's key goes in
    `credentials`, as for `p.retrieve`.

    `on_event` gets every event of every search, with the question's id under
    "question", and a "question_finished" event after each question. `cancel`
    stops before the next question; the report then says it was cancelled.
    """
    if top_k < 1:
        raise ValueError(
            "top_k must be at least 1: it is how many of the top pieces are checked for the answer."
        )
    if p.retrieval is None:
        raise ValueError(
            "evaluate needs a pipeline with a retrieve section, because it searches "
            "for every question. Add a retrieve section with at least a search step."
        )
    asked = load_questions(questions)["questions"]
    resolved = p.index._documents(documents) if documents is not None else None
    owners: list[str | None] = [None] * len(asked)
    searched: dict[str, Any] = {}
    if any(q["document"] for q in asked):
        searched = resolved if resolved is not None else p.index.indexed()
        owners = documents_named(asked, searched)
    discover()
    step = registry.get(Stage.USE_CASE, "eval")
    settings = step.config_model(top_k=top_k)
    index: IndexReport | None = None
    results: list[QuestionResult] = []
    cancelled = False
    for n, (q, owner) in enumerate(zip(asked, owners), start=1):
        if cancel is not None and cancel.is_set():
            cancelled = True
            break
        qid = q["id"] or f"question {n}"
        emit = None
        if on_event is not None:
            def emit(e: dict[str, Any], qid: str = qid) -> None:
                on_event({**e, "question": qid})
        retrieval = p.retrieval._retrieve(
            q["question"], None, resolved, credentials=credentials, on_event=emit, cancel=cancel
        )
        if not retrieval.ok and cancel is not None and cancel.is_set():
            cancelled = True
            break
        sha = getattr(searched[owner], "sha", None) if owner is not None else None
        common = {
            "id": qid, "question": q["question"], "golds": q["gold_answers"], "tags": q["tags"],
            "document": None if owner is None else sha or owner,
        }
        if not retrieval.ok:
            result = QuestionResult(
                **common, found=False, rank=None, lost_at=None, trace=None, score={},
                error=_failure(retrieval), retrieval=retrieval,
            )
        else:
            query = Query(text=q["question"], gold_answers=q["gold_answers"])
            score = step().apply(
                {"result": _only(retrieval.result.model_dump(mode="json"), sha), "query": query.model_dump(mode="json")},
                settings,
                None,
            )["payload"]
            miss = None
            if not score["hit"]:
                if index is None:
                    index = p.index._index(
                        resolved if resolved is not None else p.index.indexed(),
                        credentials=credentials,
                        remember=False,
                    )
                miss = _trace(index, retrieval, {**q, "document": owner}, top_k, sha)
            result = QuestionResult(
                **common, found=score["hit"], rank=score["rank"],
                lost_at=miss["lost_at"] if miss else None, trace=miss, score=score,
                retrieval=retrieval,
            )
        results.append(result)
        if on_event is not None:
            on_event(event(
                "question_finished", question=qid, number=n, total=len(asked),
                found=result.found, error=result.error,
            ))
    return EvaluationReport(
        top_k=top_k, questions=results, cancelled=cancelled,
        document_shas=_shas(p, resolved), nondeterministic=_nondeterministic(results),
    )


#: The registry stage of each retrieval step, by its name in `Retrieval.stages`.
_RETRIEVAL_STAGES = {"rewrite": Stage.QUERY, "search": Stage.RETRIEVE, "rerank": Stage.RERANK}


def _shas(p: Pipeline, documents: dict[str, Any] | None) -> list[str]:
    """The searched documents' content hashes, or locations for a source other than upload."""
    if documents is None:
        try:
            documents = p.index.indexed()
        except ValueError:
            return []
    return sorted(getattr(d, "sha", d) for d in documents.values())


def _nondeterministic(results: list[QuestionResult]) -> list[str]:
    """The names of the retrieval steps that are not deterministic, such as llm_rerank."""
    retrieval = next((q.retrieval for q in results if q.retrieval is not None), None)
    if retrieval is None:
        return []
    steps = [("rewrite", retrieval.stages["rewrite"]), ("search", retrieval.stages["search"])]
    steps += [("rerank", s) for s in retrieval.stages["rerank"]]
    names: list[str] = []
    for role, step in steps:
        cls = registry.all_for(_RETRIEVAL_STAGES[role]).get(step.transform)
        if cls is not None and not cls.deterministic and step.transform not in names:
            names.append(step.transform)
    return names


def _failure(retrieval: Retrieval) -> str:
    """Which retrieval step failed, and the last line of its error."""
    steps = [retrieval.index, retrieval.stages["rewrite"], retrieval.stages["search"], *retrieval.stages["rerank"]]
    failed = next((s for s in steps if s.status == "failed"), None)
    if failed is None:
        return "Retrieval did not finish."
    lines = (failed.error or "").strip().splitlines()
    return f"The {failed.stage} step ({failed.transform}) failed: {lines[-1] if lines else 'it gave no reason'}"


def documents_named(questions: list[dict[str, Any]], documents: dict[str, Any]) -> list[str | None]:
    """The document each question names, as its id in `documents` ({document
    id: stored file or location}, what `p.index.indexed()` returns), or None
    for a question naming none. A question names a document by its id, its
    filename (for a location, its last part) or its content hash (for a stored
    file). A name that is none of `documents`, or a filename two of them
    share, is a QuestionSetError naming the question."""
    out: list[str | None] = []
    for n, question in enumerate(questions, start=1):
        name = question.get("document") or ""
        if not name:
            out.append(None)
            continue
        if name in documents:
            out.append(name)
            continue
        hits = [d for d, f in documents.items() if getattr(f, "sha", None) == name]
        hits = hits or [d for d, f in documents.items() if _filename(f) == name]
        if len(hits) > 1:
            raise QuestionSetError(
                f"Question {n} names the document {name}, and {len(hits)} of the documents searched "
                f"have that name: {', '.join(hits)}. Name it by its id instead."
            )
        if not hits:
            raise QuestionSetError(
                f"Question {n} names the document {name}, which is not one of the documents "
                f"searched: {', '.join(sorted(documents))}."
            )
        out.append(hits[0])
    return out


def _filename(document: Any) -> str:
    """A stored file's name, or the last part of a location."""
    if isinstance(document, str):
        return PurePosixPath(document.replace("\\", "/")).name
    return getattr(document, "filename", "")


def _only(result: Any, sha: str | None) -> Any:
    """A retrieval result (as JSON) in which only the pieces from the document
    with this content hash can hold an answer: every other piece keeps its
    place, so the top k is still the reader's top k, but its text is empty.
    With no sha, the result as it is."""
    if sha is None or result is None:
        return result
    out = RetrievalResult.model_validate(result).model_dump(mode="json")
    for hit in out["hits"]:
        if hit["chunk"]["doc_id"] != sha:
            hit["chunk"]["text"] = ""
    return out


def _document_for(index: IndexReport, question: dict[str, Any]) -> str:
    """The document a miss is traced in: the one the question names when it
    is indexed, else the first whose pieces hold a gold passage whole, else
    the first whose parsed text holds one, else the first by id."""
    if question.get("document") in index.documents:
        return question["document"]
    golds = question["gold_answers"]
    ids = sorted(index.documents)
    for doc_id in ids:
        step = index.documents[doc_id].stages.get("chunk")
        chunks = step.output if step is not None else None
        if chunks is not None and any(_holds(c.text, golds) for c in ChunkSet.model_validate(chunks).chunks):
            return doc_id
    for doc_id in ids:
        parsed = index.documents[doc_id].stages["parse"].output
        if parsed is not None and _holds(DocView.of(parsed).text, golds):
            return doc_id
    return ids[0]


def _trace(
    index: IndexReport, retrieval: Retrieval, question: dict[str, Any], top_k: int, sha: str | None = None
) -> dict[str, Any]:
    """The miss trace over one document's index steps and the retrieval.

    With several rerankers, the trace checks the last one, whose result the
    eval step scored. With `sha`, the content hash of the question's own
    document, only that document's pieces can hold the answer, as in the score.
    """
    doc_id = _document_for(index, question)
    stages = index.documents[doc_id].stages
    cleans = sorted((k for k in stages if k.startswith("clean.")), key=lambda k: int(k.split(".")[1]))
    reranks = retrieval.stages["rerank"]
    found = trace(
        golds=question["gold_answers"],
        parse=StepInput(stages["parse"].transform, stages["parse"].output),
        cleans=[StepInput(stages[k].transform, stages[k].output) for k in cleans],
        chunks=stages["chunk"].output,
        retrieve=_only(retrieval.stages["search"].output, sha),
        final=_only(reranks[-1].output, sha) if reranks else None,
        rerank_name=reranks[-1].transform if reranks else None,
        top_k=top_k,
    )
    return {**found, "document": doc_id}


#: The stages compare can vary, and the section of the pipeline file each is in.
COMPARE_STAGES: dict[str, str] = {
    "parse": "index",
    "clean": "index",
    "chunk": "index",
    "enrich": "index",
    "embed": "index",
    "store": "index",
    "rewrite": "retrieve",
    "search": "retrieve",
    "rerank": "retrieve",
}


def _check_through(pipeline: Pipeline, stage: str, through: str) -> None:
    """A ValueError when `through` names no step of `pipeline` (as `index.run`
    says it) or stops before the varied `stage`, which would leave nothing to compare."""
    pipeline.index._last_step(through)
    stop = STAGE_ORDER[through.split(".")[0]]
    if stop < STAGE_ORDER[stage]:
        raise ValueError(
            f"through='{through}' stops before the {stage} step, so there would be nothing "
            f"to compare. Stop at the {stage} step or after it."
        )


@dataclass
class Comparison:
    """One variant: the pipeline with that stage changed, its index run, and
    its evaluation when there were questions."""

    stage: str
    variant: Any
    pipeline: Pipeline
    index: IndexReport
    report: EvaluationReport | None

    @property
    def outputs(self) -> dict[str, StageResult]:
        """The varied step's result: per document for parse, clean (the last
        cleaner) and chunk; under "index" for embed and store; empty for a
        retrieval stage, whose results are in `report`."""
        if self.stage in ("embed", "store"):
            return {"index": self.index.index}
        if COMPARE_STAGES[self.stage] != "index":
            return {}
        out: dict[str, StageResult] = {}
        for doc_id, document in self.index.documents.items():
            keys = [k for k in document.stages if k == self.stage or k.startswith(f"{self.stage}.")]
            if keys:
                out[doc_id] = document.stages[max(keys, key=lambda k: int(k.split(".")[1]) if "." in k else 0)]
        return out

    def _steps(self) -> list[StageResult]:
        return [*self.index._steps(), *(self.report._steps() if self.report is not None else [])]

    def cost(
        self,
        prices: dict[str, tuple[float, float]] | None = None,
        *,
        since: str | None = None,
        before: str | None = None,
    ) -> dict[str, Any]:
        """Seconds, tokens, estimated dollars and the cache share of this
        variant's index run and evaluation; see `pandion.cost.cost`.
        `cost(since=results.varied_from)` is this variant's own cost: the
        varied step and the steps after it."""
        return _cost(self._costed(), prices, since=since, before=before)

    def _costed(self) -> list[StageResult]:
        return self._steps()

    @property
    def settings(self) -> str:
        """The variant in short: each step's name and the settings it was given."""
        block = _block(self.variant)
        blocks = block if isinstance(block, list) else [block]
        return ", ".join(_short(b) for b in blocks) or "none"

    @property
    def index_stopped(self) -> bool:
        """A cancel stopped the index run: a step was skipped and none failed."""
        steps = [s for d in self.index.documents.values() for s in d.stages.values()]
        if self.index.index is not None:
            steps.append(self.index.index)
        statuses = {s.status for s in steps}
        return "skipped" in statuses and "failed" not in statuses

    @property
    def cancelled(self) -> bool:
        """A cancel stopped this variant, in its index run or its evaluation."""
        if self.report is not None and self.report.cancelled:
            return True
        return not self.index.ok and self.index_stopped

    def __str__(self) -> str:
        """One plain line: the stage, the variant in short, and how it did."""
        if not self.index.ok:
            outcome = "stopped" if self.index_stopped else "the index run failed"
        elif self.report is None:
            outcome = "indexed, no questions asked"
        else:
            t = self.report.totals()
            outcome = f"found {t['found']} of {t['scored']}"
            if self.report.cancelled:
                outcome += " (stopped early)"
        return f"{self.stage} {self.settings}: {outcome}"

    def to_dict(self) -> dict[str, Any]:
        """Plain JSON: the variant, whether its index run worked, each varied
        step's result id and status, and the evaluation."""
        return {
            "stage": self.stage,
            "variant": _block(self.variant),
            "ok": self.index.ok,
            "cancelled": self.cancelled,
            "outputs": {
                key: {"artifact_id": s.artifact_id, "status": s.status, "transform": s.transform}
                for key, s in self.outputs.items()
            },
            "report": self.report.to_dict() if self.report is not None else None,
        }


def _short(block: Any) -> str:
    """One step's block as its name and settings, such as
    "recursive_character chunk_size=800"."""
    if not isinstance(block, dict):
        return str(block)
    settings = " ".join(f"{key}={value}" for key, value in block.items() if key != "use")
    return f"{block.get('use')} {settings}".strip()


class Comparisons(list[Comparison]):
    """What `compare` returns: a list of `Comparison`, one per variant, that
    prints one plain line per variant and the best one. The best has the
    highest hit rate (found out of scored), then the highest mean reciprocal
    rank. A variant a cancel stopped is never the best. A slice such as
    `results[:2]` is a plain list."""

    #: A cancel stopped compare before every variant ran.
    cancelled: bool = False
    #: The stage `compare` was told to vary, such as "rerank" or "chunk";
    #: None for a list built by hand.
    varied_from: str | None = None

    def _scored(self) -> list[Comparison]:
        return [
            c for c in self
            if c.report is not None and not c.cancelled and c.report.totals()["scored"]
        ]

    @property
    def best(self) -> list[Comparison]:
        """The best comparisons, every one tied for first, in order; empty when
        no variant finished and was scored, or none found an answer."""
        scored = self._scored()
        return [scored[n] for n in best([c.report for c in scored])]

    def cost(
        self,
        prices: dict[str, tuple[float, float]] | None = None,
        *,
        since: str | None = None,
        before: str | None = None,
    ) -> dict[str, Any]:
        """The cost of every variant together, each step counted once; see
        `pandion.total_cost`. `before=self.varied_from` is the cost of the
        shared steps, measured once."""
        return total_cost(self, prices=prices, since=since, before=before)

    def to_dict(self) -> dict[str, Any]:
        """Plain JSON: every comparison's `to_dict()`, and the best as their
        places in the list."""
        best = self.best
        return {
            "comparisons": [c.to_dict() for c in self],
            "best": [n for n, c in enumerate(self) if any(c is b for b in best)],
            "cancelled": self.cancelled,
        }

    def __str__(self) -> str:
        lines = [str(c) for c in self]
        best = self.best
        if best:
            t = best[0].report.totals()
            line = f"Best: {best[0].settings}, found {t['found']} of {t['scored']}"
            if len(best) > 1:
                line += ", tied with " + " and ".join(c.settings for c in best[1:])
            lines.append(line + ".")
        elif self._scored():
            lines.append("No variant found an answer.")
        if self.cancelled or any(c.cancelled for c in self):
            lines.append("Stopped before every variant had finished.")
        return "\n".join(lines)


def compare(
    p: Pipeline,
    stage: str,
    variants: list[Any],
    documents: str | Path | list[str | Path],
    questions: str | Path | list[dict] | dict | None = None,
    *,
    top_k: int = DEFAULT_TOP_K,
    credentials: dict[str, str] | None = None,
    on_event: Callable[[dict[str, Any]], None] | None = None,
    cancel: threading.Event | None = None,
    through: str | None = None,
) -> Comparisons:
    """Run `p` once per variant, with only `stage` changed, and evaluate each.

    A variant is what the pipeline file takes for that stage: a block such as
    {"use": "recursive_character", "chunk_size": 800}, a name, a step class,
    or for clean and rerank a list of them. Every variant is checked before
    any runs. Each one indexes `documents` against the same store, so every
    step above the changed one is a cache hit after the first variant. With
    `questions`, each variant is evaluated (see `evaluate`); without them,
    each result holds the changed step's output, and a retrieval stage
    cannot be compared, because nothing is searched. The best variant is the
    one with the highest hit rate (answers found out of questions scored),
    then the highest mean reciprocal rank; see `Comparisons.best`.

    `on_event` gets every event, with the variant's number (from 1) under
    "variant" and the number of variants under "variants"; `cancel` starts no
    further variant, and the result says it was cancelled.

    `through` stops each variant's index run after that step, as
    `index.run(through=...)` does, so comparing chunkers need not embed
    anything. It is only for a comparison without questions, and it must not
    stop before the varied step.
    """
    section = COMPARE_STAGES.get(stage)
    if section is None:
        raise ValueError(
            f"compare varies one of {', '.join(COMPARE_STAGES)}; '{stage}' is not one of them."
        )
    if not variants:
        raise ValueError("compare needs at least one variant: the settings to try at that stage.")
    if section == "retrieve" and questions is None:
        raise ValueError(
            f"Comparing {stage} needs questions: without them nothing is searched, "
            f"so there is no {stage} result to compare."
        )
    if through is not None and questions is not None:
        raise ValueError(
            "through is only for a comparison without questions: answering a question needs "
            "the whole index, so leave through out or leave the questions out."
        )
    asked = load_questions(questions)["questions"] if questions is not None else None
    base = to_dict(p.config)
    pipelines: list[Pipeline] = []
    for n, variant in enumerate(variants, start=1):
        block = _block(copy.deepcopy(variant))
        if stage in ("clean", "rerank") and isinstance(block, dict):
            block = [block]
        data = copy.deepcopy(base)
        data.setdefault(section, {})[stage] = block
        try:
            pipelines.append(Pipeline._of(from_dict(data, base=p.config.path)))
        except ConfigError as exc:
            raise ConfigError(f"variant {n}: {exc}", step=exc.step, use=exc.use, settings=exc.settings) from None
    if through is not None:
        for pipeline in pipelines:
            _check_through(pipeline, stage, through)
    results = Comparisons()
    results.varied_from = stage
    for n, (variant, pipeline) in enumerate(zip(variants, pipelines), start=1):
        if cancel is not None and cancel.is_set():
            results.cancelled = True
            break
        emit = None
        if on_event is not None:
            def emit(e: dict[str, Any], n: int = n) -> None:
                on_event({**e, "variant": n, "variants": len(variants)})
        index = pipeline.index.run(
            documents, through=through, on_event=emit, cancel=cancel, credentials=credentials
        )
        report = None
        if asked is not None and index.ok:
            report = evaluate(
                pipeline, asked, top_k, credentials=credentials, on_event=emit, cancel=cancel
            )
            results.cancelled = results.cancelled or report.cancelled
        results.append(Comparison(stage=stage, variant=variant, pipeline=pipeline, index=index, report=report))
        if cancel is not None and cancel.is_set():
            results.cancelled = True
            break
    return results

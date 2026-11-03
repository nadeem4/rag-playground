"""`pandion review`: what the batch evaluators and the flags leave for a person to read.

Provisional. It reads traces and prints; the scoring is `run_evaluators`. `promote`
is the one writer: it adds a trace to a question set so the miss can be tested again.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from pandion.online import ReviewResult
from pandion.trace_record import TraceRecord
from pandion.trace_report import _clean

#: The question is cut to this many characters in the listing.
_SHOWN = 80


def parse_sample(text: str) -> float:
    """`0.02`, `2%` or `1`, as a fraction from 0 to 1. Anything else is a ValueError."""
    try:
        value = float(text[:-1]) / 100 if text.strip().endswith("%") else float(text)
    except ValueError:
        value = -1
    if not 0 <= value <= 1:
        raise ValueError(f"--sample '{text}' is not a share from 0 to 1 (such as 0.02) or from 0% to 100%.")
    return value


def needs_a_look(t: TraceRecord) -> bool:
    return bool(t.flags) or any(f.value == "down" for f in t.feedback)


def format_review_list(traces: list[TraceRecord]) -> str:
    """One line a flagged or thumbs-down trace, newest first, with the question cut short."""
    rows = [t for t in traces if needs_a_look(t)]
    if not rows:
        return "No flagged or thumbs-down traces."
    lines = []
    for t in rows:
        notes = list(t.flags) + (["thumbs down"] if any(f.value == "down" for f in t.feedback) else [])
        question = _clean(t.question).replace("\n", " ")
        question = question if len(question) <= _SHOWN else question[: _SHOWN - 1] + "..."
        lines.append(f"{t.trace_id}  {t.created_at}  {', '.join(notes)}  {question}")
    lines.append("Read one with: pandion trace TRACE_ID")
    return "\n".join(lines)


def format_review_result(r: ReviewResult) -> tuple[str, str]:
    """The summary for stdout, and the failures for stderr (by exception type only)."""
    out = [f"{label}: {n} scored" for label, n in r.by_evaluator.items()]
    out.append(f"{r.traces} traces read, {r.scored} scored, {r.skipped} skipped.")
    err = [
        f"{label}: {sum(kinds.values())} failed ({', '.join(f'{kind}: {n}' for kind, n in sorted(kinds.items()))})"
        for label, kinds in r.failures.items()
    ]
    if r.judge_dollars:
        out.append(f"Judge cost: about ${r.judge_dollars:.4f} (estimate).")
    return "\n".join(out), "\n".join(err)


class Promoted(BaseModel):
    trace_id: str
    #: False when the file already held a case for this trace.
    added: bool
    question: str
    #: How many earlier turns the case carries (0 unless the trace was a follow-up).
    history_turns: int = 0
    #: With a pipeline: one sentence saying whether the miss is in retrieval or in the answer. Else "".
    diagnosis: str = ""

    def __str__(self) -> str:
        head = (f"Added trace {self.trace_id} to the question set" if self.added
                else f"Trace {self.trace_id} is already in the question set")
        if self.history_turns:
            head += f" with {self.history_turns} earlier turn(s) of history"
        hint = " Each expected passage is a whole cited passage: trim it to the sentence that answers." if self.added else ""
        return head + "." + hint + (f"\n{self.diagnosis}" if self.diagnosis else "")


def _history(store: Any, trace: TraceRecord) -> list[dict[str, str]]:
    """The turns before this trace's turn in its conversation, as `{question, answer}` pairs."""
    conversation = store.load(trace.conversation_id, trace.user_id)
    pairs: list[dict[str, str]] = []
    for turn in conversation.turns if conversation is not None else []:
        if turn.trace_id == trace.trace_id:
            return pairs
        pairs.append({"question": turn.question, "answer": turn.answer})
    return []  # the turn is not in the conversation (expired or deleted): no history to carry


def _read_cases(path: Path) -> tuple[Any, list]:
    if not path.exists():
        return [], []
    try:
        body = json.loads(path.read_text(encoding="utf-8-sig"))
    except ValueError:
        raise ValueError(f"{path} is not a JSON question set, so a case cannot be added to it. Promote into a .json file.") from None
    cases = body.get("questions") if isinstance(body, dict) else body
    if not isinstance(cases, list):
        raise ValueError(f"{path} has no list of questions to add to.")
    return body, cases


def _diagnose(p: Any, case: dict, credentials: dict | None) -> str:
    from pandion import evaluation

    stale = evaluation.stale_check(p, [case], credentials=credentials)
    if not stale.ok:
        return "The cited passage is no longer in the document as the pipeline reads it, so fix the question set first."
    question = evaluation.evaluate(p, [case], credentials=credentials).questions[0]
    if question.error:
        return "Could not tell where the miss is: the search failed."
    if not question.found:
        return "This is a retrieval miss: the search does not return the passage the answer cited."
    return "Retrieval finds the cited passage, so the miss is in the answer step."


def promote(store: Any, trace_id: str, questions_path: str | Path, *, p: Any = None, credentials: dict | None = None) -> Promoted:
    """Add the trace as a case to a JSON question set: its standalone question, the earlier
    turns when it was a follow-up, and the passages it cited as the expected ones.

    A trace already in the file (same id) is not added twice. With a pipeline `p`, also
    says whether the miss is in retrieval or in the answer. Raises ValueError (a sentence)
    for a missing trace, a trace with no stored passages, or a file that is not a JSON set.
    """
    trace = store.trace(trace_id)
    if trace is None:
        raise ValueError(f"There is no trace '{trace_id}' in the store.")
    if not trace.sources:
        raise ValueError(
            f"Trace '{trace_id}' has no stored passages (it was saved before traces kept them, or it cited none), so there is nothing to expect."
        )
    path = Path(questions_path)
    body, cases = _read_cases(path)
    case: dict[str, Any] = {
        "id": trace.trace_id, "question": trace.question,
        "gold_answers": [s.text for s in trace.sources], "tags": ["promoted"],
    }
    history = _history(store, trace)
    if history:
        case["history"] = history  # with history the case keeps the question as asked, so evaluate replays the rewrite
    else:
        case["question"] = trace.standalone or trace.question
    added = all(c.get("id") != trace.trace_id for c in cases if isinstance(c, dict))
    if added:
        cases.append(case)
        out = cases if isinstance(body, list) else {**body, "questions": cases}
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    diagnosis = _diagnose(p, case, credentials) if p is not None else ""
    return Promoted(trace_id=trace.trace_id, added=added, question=case["question"], history_turns=len(history), diagnosis=diagnosis)

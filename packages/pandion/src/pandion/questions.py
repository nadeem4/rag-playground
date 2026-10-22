"""Question sets: the file format, reading one from a file or from code, and the check.

**One parser, two file shapes.** JSON because the app speaks it, CSV because
people keep question sets in spreadsheets. Both come out as the same validated
structure, so everything downstream sees one shape.

`load_questions` reads a set from a path (JSON or CSV) or from a list or dict in
code, through the same parser, so a set behaves the same wherever it comes from.

It is forgiving wherever forgiveness costs nothing: `gold_answer` for
`gold_answers`, a bare string for a list, whitespace around every value, blank
rows, a byte-order mark from a CSV saved out of Excel, and the file's own
content deciding which parser reads it rather than the name it was saved under.
It is strict about the two things that make a set worthless: a question with no
text, and a question with no gold passage. Those are refused, naming the row.

**The check** exists because a gold passage that was retyped rather than copied
never matches at evaluation time, and the retriever gets the blame. Each gold
passage is looked for in the document as the parser reads it: exactly, then
with the shared rule in pandion.textmatch: whitespace collapsed, straight and
curly quotes treated alike, ligatures such as fi expanded, line-end hyphenation
joined and case folded. The `eval` step and the miss trace use the same rule,
so a `found_normalized` here is a `normalized` match there. When it
is nowhere, the closest sentence in the document comes back, which makes a typo
obvious at a glance.
"""

from __future__ import annotations

import csv
import difflib
import io
import json
import re
from pathlib import Path
from typing import Any

from pandion.textmatch import normalise_with_offsets

#: Several gold passages in one CSV cell.
GOLD_SEPARATOR = "||"

#: How close a document sentence must be to count as "did you mean this?".
CLOSEST_CUTOFF = 0.6

#: The end of a sentence, for the closest-passage comparison.
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+|\n+")

_FIELDS = ("id", "question", "gold_answers", "answer", "tags")


class QuestionSetError(ValueError):
    """The file cannot be read as a question set; the message names the row."""


# ---------------------------------------------------------------------------
# the file format (I-30)
# ---------------------------------------------------------------------------


def parse_question_set(
    data: bytes,
    filename: str = "",
    *,
    one_document: bool = True,
    max_questions: int | None = None,
    max_golds: int | None = None,
) -> dict[str, Any]:
    """Read JSON or CSV into `{format, version, document, questions}`.

    `max_questions` and `max_golds` (per question) cap the set, for a server
    that checks sets people upload; None, the default, is no cap.

    Every question has the same keys, present even when empty, so a caller
    never has to ask whether an optional field is there. With `one_document`
    (the default, which the app's upload uses), every question must be about
    the set's one document; `load_questions` turns it off, because
    `pandion.evaluate` searches several documents.
    """
    text = _decode(data)
    if text.lstrip()[:1] in ("{", "["):
        fmt, version, document, records = "json", *_json_records(text)
    else:
        fmt, version, document, records = "csv", *_csv_records(text)

    if max_questions is not None and len(records) > max_questions:
        raise QuestionSetError(
            f"the set has {len(records)} questions; at most {max_questions} fit in one set, so split it"
        )
    questions = [_question(label, record, fmt, max_golds) for label, record in records]
    if not questions:
        raise QuestionSetError(
            "the file has no questions in it; the template shows what one looks like"
        )
    document = _one_document(document, questions, [label for label, _ in records], strict=one_document)
    return {
        "format": fmt,
        "version": version,
        "document": document,
        "questions": questions,
    }


def load_questions(questions: str | Path | list[dict] | dict) -> dict[str, Any]:
    """A question set from a JSON or CSV file, or from a list or dict in code, checked.

    Returns `{format, version, document, questions}`, as `parse_question_set`
    does. Its questions may name different documents. A problem is a `QuestionSetError` whose message is one sentence that
    says where the set came from and which question is at fault.
    """
    if isinstance(questions, (str, Path)):
        path = Path(questions)
        if not path.is_file():
            raise QuestionSetError(f"There is no question set at {path}.")
        data, filename, where = path.read_bytes(), path.name, f"at {path}"
    elif isinstance(questions, (list, dict)):
        data, filename, where = json.dumps(questions).encode("utf-8"), "", "you gave"
    else:
        raise QuestionSetError(
            "questions must be a path to a JSON or CSV file, a list of questions, "
            f"or a dict with a questions list, not {type(questions).__name__}."
        )
    try:
        return parse_question_set(data, filename, one_document=False)
    except QuestionSetError as exc:
        reason = str(exc).rstrip(".")
        raise QuestionSetError(f"The question set {where} cannot be used: {reason}.") from None


def _decode(data: bytes) -> str:
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise QuestionSetError(
            "the file is not UTF-8 text; save it as UTF-8 and upload it again"
        ) from exc


def _json_records(text: str) -> tuple[int, str, list[tuple[str, dict]]]:
    try:
        body = json.loads(text)
    except json.JSONDecodeError as exc:
        raise QuestionSetError(
            f"the file is not valid JSON: {exc.msg}, at line {exc.lineno}"
        ) from exc
    except RecursionError:
        raise QuestionSetError("the JSON is nested too deeply to read; a question set is one or two levels deep") from None

    version, document = 1, ""
    if isinstance(body, dict):
        items = body.get("questions")
        if not isinstance(items, list):
            raise QuestionSetError(
                'the JSON object has no "questions" list; it is either a list of '
                'questions or an object with a "questions" key'
            )
        if isinstance(body.get("version"), int):
            version = body["version"]
        document = str(body.get("document") or "").strip()
    elif isinstance(body, list):
        items = body
    else:
        raise QuestionSetError(
            'the JSON must be a list of questions or an object with a "questions" list'
        )

    records = []
    for n, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            raise QuestionSetError(
                f"question {n}: expected an object with a question in it"
            )
        records.append((f"question {n}", item))
    return version, document, records


def _csv_records(text: str) -> tuple[int, str, list[tuple[str, dict]]]:
    try:
        return _csv_rows(text)
    except csv.Error as exc:
        raise QuestionSetError(f"the CSV cannot be read: {exc}") from None


def _csv_rows(text: str) -> tuple[int, str, list[tuple[str, dict]]]:
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise QuestionSetError("the file is empty")
    reader.fieldnames = [(name or "").strip().lower() for name in reader.fieldnames]
    if "question" not in reader.fieldnames:
        raise QuestionSetError(
            "the CSV has no `question` column; the columns are "
            + ",".join(_FIELDS)
        )

    records = []
    for row in reader:
        values = [v for v in row.values() if isinstance(v, str)]
        if not any(v.strip() for v in values):
            continue  # a blank row, which every spreadsheet leaves behind
        records.append((f"row {reader.line_num}", row))
    return 1, "", records


def _question(label: str, record: dict, fmt: str, max_golds: int | None = None) -> dict[str, Any]:
    question = _one(record.get("question"))
    if not question:
        raise QuestionSetError(f"{label}: no question text")

    golds = _golds(record, fmt)
    if not golds:
        raise QuestionSetError(
            f"{label}: no gold passage. Copy the sentence that answers the "
            "question out of the document into gold_answers"
        )
    if max_golds is not None and len(golds) > max_golds:
        raise QuestionSetError(f"{label}: {len(golds)} gold passages; at most {max_golds} fit in one question")
    return {
        "id": _one(record.get("id")),
        "question": question,
        "gold_answers": golds,
        "answer": _one(record.get("answer")),
        "tags": _list(record.get("tags"), ","),
        "document": _one(record.get("document")),
    }


def _one_document(document: str, questions: list[dict], labels: list[str], *, strict: bool = True) -> str:
    """The set's document, written into every question that leaves it out.

    A question's `document` says which document its evidence is in. The set's
    document is its own `document`, else the first a question names. With
    `strict`, the one-document upload's path, a set covers that one document:
    a question naming another is refused, naming its row, and a question
    naming none is about that one. `load_questions` passes `strict=False`,
    because `pandion.evaluate` searches several documents: there only the
    set's own `document` fills a question that names none, and a question
    left with none is found in any document.
    """
    named = document
    document = document or next((q["document"] for q in questions if q["document"]), "")
    fill = document if strict else named
    for label, question in zip(labels, questions):
        own = question["document"]
        if strict and own and document and own != document:
            raise QuestionSetError(
                f"{label}: its evidence is in {own}, but this set is for {document}. "
                f"A set covers one document for now, so put {own}'s questions in a set of their own"
            )
        question["document"] = own or fill
    return document


def _golds(record: dict, fmt: str) -> list[str]:
    """`gold_answers` and `gold_answer`, in that order, without repeats.

    A CSV cell holds several passages separated by `||`; a JSON string is one
    passage, taken literally, because JSON can hold a list and does not need
    the escape hatch.
    """
    out: list[str] = []
    for key in ("gold_answers", "gold_answer"):
        for value in _list(record.get(key), GOLD_SEPARATOR if fmt == "csv" else None):
            if value not in out:
                out.append(value)
    return out


def _one(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _list(value: Any, separator: str | None) -> list[str]:
    if isinstance(value, list):
        parts = [_one(v) for v in value]
    elif isinstance(value, str):
        parts = [p.strip() for p in (value.split(separator) if separator else [value])]
    else:
        parts = []
    return [p for p in parts if p]


# ---------------------------------------------------------------------------
# the upload check (I-31)
# ---------------------------------------------------------------------------


def check_questions(questions: list[dict], text: str) -> list[dict[str, Any]]:
    """Per question, per gold passage: is it really in this document?"""
    haystack, offsets = normalise(text)
    sentences = [s.strip() for s in _SENTENCE_END.split(text) if s.strip()]
    folded = [normalise(s)[0] for s in sentences]

    rows = []
    for index, question in enumerate(questions):
        golds = [
            _check_gold(gold, text, haystack, offsets, sentences, folded)
            for gold in question["gold_answers"]
        ]
        rows.append(
            {
                "index": index,
                "id": question.get("id", ""),
                "question": question["question"],
                # The worst of its passages: a question is only as good as the
                # weakest passage it will be scored on.
                "status": _worst(g["status"] for g in golds),
                "golds": golds,
            }
        )
    return rows


def check_questions_across(questions: list[dict], texts: dict[str, str]) -> list[dict[str, Any]]:
    """`check_questions` over several documents, `texts` by document key.

    A question whose `document` is one of the keys is checked in that document
    only; a question naming none is checked in every one, and each gold
    passage takes its best match across them. Each row says the document the
    question names (`document`, None when it names none), and each gold
    passage the document it was found in (None when it was not). The closest
    sentence of a passage found nowhere comes from the first document that has one.
    """
    keys = list(texts)
    for n, question in enumerate(questions, start=1):
        named = question.get("document") or ""
        if named and named not in texts:
            raise QuestionSetError(f"question {n} names the document {named}, which is not one of {', '.join(keys)}")
    checked = {key: check_questions(questions, text) for key, text in texts.items()}
    rank = {"found": 0, "found_normalized": 1, "not_found": 2}
    rows = []
    for index, question in enumerate(questions):
        named = question.get("document") or None
        where = [named] if named else keys
        golds = []
        for g, gold in enumerate(question["gold_answers"]):
            tries = [(key, checked[key][index]["golds"][g]) for key in where]
            key, best = min(tries, key=lambda t: rank[t[1]["status"]])
            if best["status"] == "not_found":
                key, best = None, next((row for _, row in tries if row["closest"]), tries[0][1])
            golds.append({**best, "document": key})
        rows.append({
            **checked[where[0]][index],
            "status": _worst(gold["status"] for gold in golds),
            "golds": golds,
            "document": named,
        })
    return rows


def _worst(statuses) -> str:
    seen = set(statuses)
    for status in ("not_found", "found_normalized", "found"):
        if status in seen:
            return status
    return "not_found"


def _check_gold(
    gold: str,
    text: str,
    haystack: str,
    offsets: list[int],
    sentences: list[str],
    folded: list[str],
) -> dict[str, str]:
    row = {"gold": gold, "status": "not_found", "document_text": "", "closest": ""}
    if gold in text:
        row["status"] = "found"
        return row

    needle, _ = normalise(gold)
    at = haystack.find(needle) if needle else -1
    if at >= 0:
        start, end = offsets[at], offsets[at + len(needle) - 1] + 1
        row["status"] = "found_normalized"
        row["document_text"] = text[start:end]
        return row

    close = difflib.get_close_matches(needle, folded, n=1, cutoff=CLOSEST_CUTOFF)
    if close:
        row["closest"] = sentences[folded.index(close[0])]
    return row


def normalise(text: str) -> tuple[str, list[int]]:
    """The shared matching rule (pandion.textmatch) with offsets back into `text`,
    so a normalised match can be shown in the document's own wording. The eval
    step and the miss trace use the same rule, so what this check finds, the
    score finds."""
    return normalise_with_offsets(text)

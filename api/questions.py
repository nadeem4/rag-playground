"""Your own gold set: the file format (I-30) and the upload check (I-31).

**One parser, two file shapes.** JSON because the app speaks it, CSV because
people keep question sets in spreadsheets. Both come out as the same validated
structure, so everything downstream sees one shape.

It is forgiving wherever forgiveness costs nothing: `gold_answer` for
`gold_answers`, a bare string for a list, whitespace around every value, blank
rows, a byte-order mark from a CSV saved out of Excel, and the file's own
content deciding which parser reads it rather than the name it was saved under.
It is strict about the two things that make a set worthless: a question with no
text, and a question with no gold passage. Those are refused, naming the row.

**The check** exists because a gold passage that was retyped rather than copied
never matches at evaluation time, and the retriever gets the blame. Each gold
passage is looked for in the document as the parser reads it: exactly, then
with whitespace collapsed, straight and curly quotes treated alike, line-end
hyphenation joined and case folded (the same normalisation the `eval` step
applies, so a `found_normalized` here is a `normalized` match there). When it
is nowhere, the closest sentence in the document comes back, which makes a typo
obvious at a glance.
"""

from __future__ import annotations

import csv
import difflib
import io
import json
import re
from typing import Any

#: Several gold passages in one CSV cell.
GOLD_SEPARATOR = "||"

#: How close a document sentence must be to count as "did you mean this?".
CLOSEST_CUTOFF = 0.6

#: Curly quotes are what a word processor makes of the straight ones a PDF
#: usually holds. Treating them alike is the single most common reason a
#: copied-then-edited passage fails to match.
_QUOTES = {
    "‘": "'", "’": "'", "‚": "'", "′": "'",
    "“": '"', "”": '"', "„": '"', "″": '"',
}

#: The end of a sentence, for the closest-passage comparison.
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+|\n+")

_FIELDS = ("id", "question", "gold_answers", "answer", "tags")


class QuestionSetError(ValueError):
    """The file cannot be read as a question set; the message names the row."""


# ---------------------------------------------------------------------------
# the file format (I-30)
# ---------------------------------------------------------------------------


def parse_question_set(data: bytes, filename: str = "") -> dict[str, Any]:
    """Read JSON or CSV into `{format, version, document, questions}`.

    Every question has the same keys, present even when empty, so a caller
    never has to ask whether an optional field is there.
    """
    text = _decode(data)
    if text.lstrip()[:1] in ("{", "["):
        fmt, version, document, records = "json", *_json_records(text)
    else:
        fmt, version, document, records = "csv", *_csv_records(text)

    questions = [_question(label, record, fmt) for label, record in records]
    if not questions:
        raise QuestionSetError(
            "the file has no questions in it; the template shows what one looks like"
        )
    return {
        "format": fmt,
        "version": version,
        "document": document,
        "questions": questions,
    }


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


def _question(label: str, record: dict, fmt: str) -> dict[str, Any]:
    question = _one(record.get("question"))
    if not question:
        raise QuestionSetError(f"{label}: no question text")

    golds = _golds(record, fmt)
    if not golds:
        raise QuestionSetError(
            f"{label}: no gold passage. Copy the sentence that answers the "
            "question out of the document into gold_answers"
        )
    return {
        "id": _one(record.get("id")),
        "question": question,
        "gold_answers": golds,
        "answer": _one(record.get("answer")),
        "tags": _list(record.get("tags"), ","),
        "document": _one(record.get("document")),
    }


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
    """The same passage as a parser with other habits would have written it.

    Returns the normalised text and, for each of its characters, the index of
    the character it came from, so a normalised match can be shown back in the
    document's own wording.
    """
    out: list[str] = []
    index: list[int] = []
    i, n = 0, len(text)
    while i < n:
        char = text[i]
        if char == "-":
            j = i + 1
            while j < n and text[j] in " \t":
                j += 1
            if j < n and text[j] in "\r\n":  # a word broken across a line
                while j < n and text[j].isspace():
                    j += 1
                i = j
                continue
        if char.isspace():
            if out and out[-1] != " ":
                out.append(" ")
                index.append(i)
            i += 1
            continue
        folded = _QUOTES.get(char, char).lower()
        out.append(folded if len(folded) == 1 else char)
        index.append(i)
        i += 1
    while out and out[-1] == " ":
        out.pop()
        index.pop()
    return "".join(out), index

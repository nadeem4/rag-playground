"""Questions written for you: a model writes test questions from a document's text.

`write_questions(text, model=...)` splits the text into parts along its
paragraphs, asks the model for one question per part (one small call each),
and checks every question cheaply, with no further model calls:

1. **Gold passage.** The model quotes the passage that answers the question,
   word for word. `check_questions` looks for it in the text, exactly and then
   normalised. A passage that is not there drops the question.
2. **Copied text.** A question whose content words come mostly from its own
   passage is tagged `copied`: it tests word matching more than search.
3. **Duplicates.** A question nearly the same as one already kept, or with the
   same gold passage, is dropped.
4. **Count.** Never more than `count`. Fewer when drops leave fewer, or when
   the text has fewer paragraphs than `count`.

The result is the shape `parse_question_set` returns, so `evaluate` takes it
as it is, plus `dropped` (each dropped question and why), `usage` (tokens over
every call) and `parts` (how many parts were asked about). A reply that is not
the JSON asked for is a drop, never an exception. An error from the model is
raised with the key taken out of its message.
"""

from __future__ import annotations

import difflib
import json
import re
from typing import Any

from pandion import llm
from pandion.questions import check_questions, parse_question_set
from pandion.textmatch import normalise

#: The instructions every part's call is sent with.
SYSTEM_PROMPT = (
    "You write one test question for a search system, from a part of a document. "
    "The question must be answered by one passage in the part. "
    "Use your own words in the question; do not copy the passage. "
    "Reply with JSON only, in this form: "
    '{"question": "...", "gold_passage": "...", "answer": "..."}. '
    "gold_passage is the sentence or sentences that answer the question, copied word for word from the part. "
    "answer is a short answer in your own words."
)

#: The message for one part. `{part}` is the part's text.
USER_PROMPT = "Write one question about this part of the document.\n\nPart:\n{part}"

#: A part longer than this is cut, so every prompt stays small.
MAX_PART_CHARS = 6000

#: More than this share of a question's content words in its passage tags it `copied`.
COPIED_SHARE = 0.6

#: Two questions closer than this (difflib ratio, normalised text) are duplicates.
DUPLICATE_RATIO = 0.85

#: Words that carry no content, left out when comparing a question with its passage.
STOP_WORDS = frozenset(
    "a an and are as at be by can do does for from has have how in is it its of on or "
    "that the their this to was were what when where which who why will with".split()
)

_WORD = re.compile(r"[a-z0-9]+")
#: A paragraph of plain text: lines that are not blank, one after another.
_PARAGRAPH = re.compile(r"[^\n]*\S[^\n]*(?:\n[^\n]*\S[^\n]*)*")


def write_questions(
    text: Any,
    *,
    model: str,
    count: int = 15,
    credentials: dict[str, str] | None = None,
    model_name: str | None = None,
    base_url: str | None = None,
) -> dict[str, Any]:
    """Ask `model` for up to `count` test questions about `text`, checked.

    `text` is the parsed document's text. It can also be the parsed document
    itself (what `pandion.parse` returns), and then its paragraphs come from
    `paragraph_spans`; plain text is split at blank lines. `model` is a chat
    model id from `pandion.llm.CHAT_MODELS`; `openrouter` and `custom` take
    `model_name`, and `custom` takes `base_url`. Keys come from `credentials`,
    under the same names a pipeline run uses.
    """
    if not isinstance(count, int) or count < 1:
        raise ValueError(f"count must be a whole number of at least 1, not {count!r}.")
    chat = llm.CHAT_MODELS.get(model)
    if chat is None:
        raise ValueError(f"model must be one of {', '.join(llm.CHAT_MODELS)}; not '{model}'.")
    api_key = llm.key_for(chat, credentials)
    if not api_key and chat.provider != "openai_compatible":
        raise ValueError(llm.no_key_message(chat.provider))

    body, spans = _text_and_paragraphs(text)
    parts = _parts(body, spans, count)

    replies: list[llm.Completion] = []
    for start, end in parts:
        part = body[start:end][:MAX_PART_CHARS]
        replies.append(_ask(chat, part, api_key, model_name, base_url))

    kept, dropped = _check([r.text for r in replies], body)
    kept = kept[:count]
    for n, question in enumerate(kept, start=1):
        question["id"] = f"q{n}"

    if kept:
        result = parse_question_set(json.dumps({"questions": kept}).encode("utf-8"))
    else:
        result = {"format": "json", "version": 1, "document": "", "questions": []}
    return {
        **result,
        "dropped": dropped,
        "usage": _usage(replies, model_name or model),
        "parts": len(parts),
    }


def _text_and_paragraphs(text: Any) -> tuple[str, list[tuple[int, int]]]:
    """The text, and where each paragraph starts and ends in it."""
    if isinstance(text, str):
        return text, [(m.start(), m.end()) for m in _PARAGRAPH.finditer(text)]
    from pandion.evaluation import document_text, paragraph_spans

    body = document_text(text)
    spans = paragraph_spans(text)
    if not spans and body.strip():
        spans = [(0, len(body))]
    return body, spans


def _parts(text: str, spans: list[tuple[int, int]], count: int) -> list[tuple[int, int]]:
    """`count` runs of whole paragraphs, in order; one per paragraph when there are fewer."""
    n = min(count, len(spans))
    parts = []
    for i in range(n):
        group = spans[i * len(spans) // n : (i + 1) * len(spans) // n]
        parts.append((group[0][0], group[-1][1]))
    return parts


def _ask(chat: llm.ChatModel, part: str, api_key: str | None, model_name: str | None, base_url: str | None):
    """One part's call. Any error comes back with the key taken out and the
    original dropped, because the original can hold the request and the key."""
    try:
        return llm.complete(
            chat,
            system=SYSTEM_PROMPT,
            user=USER_PROMPT.format(part=part),
            api_key=api_key,
            model_name=model_name,
            base_url=base_url,
            max_tokens=1024,
        )
    except Exception as exc:  # noqa: BLE001 - every error is re-raised, scrubbed
        message = str(exc).replace(api_key, "[redacted]") if api_key else str(exc)
        kind = ValueError if isinstance(exc, ValueError) else RuntimeError
        raise kind(message) from None


def _reply(text: str) -> dict[str, str] | None:
    """The JSON object in a reply, with its two needed fields, else None."""
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        return None
    try:
        data = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    question, gold = data.get("question"), data.get("gold_passage")
    if not (isinstance(question, str) and question.strip() and isinstance(gold, str) and gold.strip()):
        return None
    answer = data.get("answer")
    return {
        "question": question.strip(),
        "gold": gold.strip(),
        "answer": answer.strip() if isinstance(answer, str) else "",
    }


def _check(replies: list[str], text: str) -> tuple[list[dict], list[dict]]:
    """The questions kept, in order, and each one dropped with why."""
    kept: list[dict] = []
    dropped: list[dict] = []
    for n, raw in enumerate(replies, start=1):
        item = _reply(raw)
        if item is None:
            dropped.append({"question": "", "reason": f"The reply for part {n} was not the JSON asked for."})
            continue
        question, gold = item["question"], item["gold"]
        found = check_questions([{"question": question, "gold_answers": [gold]}], text)[0]
        if found["status"] == "not_found":
            reason = "Its gold passage is not in the document."
        elif any(normalise(gold) == normalise(k["gold_answers"][0]) for k in kept):
            reason = "It has the same gold passage as a question already kept."
        elif any(
            difflib.SequenceMatcher(None, normalise(question), normalise(k["question"])).ratio() > DUPLICATE_RATIO
            for k in kept
        ):
            reason = "It is a near duplicate of a question already kept."
        else:
            kept.append({
                "question": question,
                "gold_answers": [gold],
                "answer": item["answer"],
                "tags": ["copied"] if _copied(question, gold) else [],
            })
            continue
        dropped.append({"question": question, "reason": reason})
    return kept, dropped


def _content_words(text: str) -> list[str]:
    return [w for w in _WORD.findall(normalise(text)) if w not in STOP_WORDS]


def _copied(question: str, gold: str) -> bool:
    """More than `COPIED_SHARE` of the question's content words are in its passage."""
    words = _content_words(question)
    if not words:
        return False
    in_gold = set(_content_words(gold))
    return sum(w in in_gold for w in words) / len(words) > COPIED_SHARE


def _usage(replies: list[llm.Completion], requested: str) -> dict[str, Any]:
    """Tokens summed over every call. A count no call reported is None, never 0;
    so is one that any call left out, because a partial sum would read as the total."""
    usage: dict[str, Any] = {}
    for key in ("input_tokens", "output_tokens"):
        counts = [r.usage.get(key) for r in replies]
        usage[key] = sum(counts) if counts and all(c is not None for c in counts) else None
    usage["model"] = next((r.model for r in replies if r.model), requested if replies else None)
    return usage

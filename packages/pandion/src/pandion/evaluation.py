"""Evaluate a pipeline on a question set, and compare settings: the public names.

A question set is the JSON format the bundled samples use (a list of
questions, or an object with a "questions" list), or a CSV file with the same
columns, or the same list in code. Each question has `question` and at least
one gold passage (`gold_answer` or `gold_answers`): the sentence in the
document that answers it. `id`, `answer`, `tags` and `document` are optional.
See docs/pandion.md, "Evaluate a pipeline".
"""

from pandion.questions import (
    GOLD_SEPARATOR,
    QuestionSetError,
    check_questions,
    load_questions,
    parse_question_set,
)

__all__ = [
    "GOLD_SEPARATOR",
    "QuestionSetError",
    "check_questions",
    "load_questions",
    "parse_question_set",
]

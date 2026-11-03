"""answer_length: an online evaluator that scores how long each stored answer is.

It sees one `TraceRecord` and returns the two outputs it declared: the number of
words, and whether the answer is a one-word reply. `pandion review --evaluate
--plugins answer_length_evaluator --url-env VAR` saves them on each trace as
`answer_length@1.words` and `answer_length@1.one_word`; `pandion report` then
shows the mean of the number. Change `version` when the logic changes, so the
traces are scored again.
"""

from pandion.extend import TraceRecord, online_evaluator


@online_evaluator("answer_length", version="1", outputs={"words": "float", "one_word": "bool"})
def answer_length(trace: TraceRecord) -> dict[str, float | bool]:
    words = len(trace.answer.split())
    return {"words": float(words), "one_word": words == 1}

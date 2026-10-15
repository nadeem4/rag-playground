"""pandion.evaluation.write_questions: a model writes test questions from a
document's text, one per part, and cheap checks drop or tag the weak ones.

No test reaches a model: `pandion.llm.complete` is replaced with a fake that
answers each part from a list of replies.
"""

import json

import pytest

import pandion
from pandion import cli, llm
from pandion.evaluation import (
    document_text,
    paragraph_spans,
    parse_question_set,
    write_questions,
)
from pandion.llm import Completion
from pdfs import SAMPLE_PAGES, build_pdf

KEY = "sk-ant-secret-key-123"
CREDS = {"anthropic_api_key": KEY}

TEXT = (
    "The capital of France is Paris.\n\n"
    "Lyon is renowned for its cuisine.\n\n"
    "Chunking splits a document into passages.\n\n"
    "Recall at ten is the headline metric."
)


def reply(question, gold, answer=""):
    return json.dumps({"question": question, "gold_passage": gold, "answer": answer})


class FakeModel:
    """Answers each call with the next reply; records every call's arguments."""

    def __init__(self, replies, usage=None):
        self.replies = list(replies)
        self.usage = usage or {"input_tokens": 10, "output_tokens": 5}
        self.calls = []

    def __call__(self, model, **kwargs):
        self.calls.append({"model": model, **kwargs})
        text = self.replies[len(self.calls) - 1]
        usage = self.usage(len(self.calls)) if callable(self.usage) else self.usage
        return Completion(text=text, usage=dict(usage), stop_reason="stop", model="served/model")


@pytest.fixture
def fake(monkeypatch):
    def install(replies, usage=None):
        model = FakeModel(replies, usage)
        monkeypatch.setattr(llm, "complete", model)
        return model

    return install


GOOD = [
    reply("Which city is the seat of government in France?", "The capital of France is Paris.", "Paris"),
    reply("Which French city is famous for food?", "Lyon is renowned for its cuisine."),
    reply("What does splitting text into passages do?", "Chunking splits a document into passages."),
    reply("Which measure matters most here?", "Recall at ten is the headline metric."),
]


def test_write_questions_is_public_in_evaluation():
    assert "write_questions" in pandion.evaluation.__all__


def test_good_questions_are_kept_with_their_passages(fake):
    model = fake(GOOD)
    result = write_questions(TEXT, model="claude-haiku-4-5", count=4, credentials=CREDS)
    assert [q["gold_answers"] for q in result["questions"]] == [
        ["The capital of France is Paris."],
        ["Lyon is renowned for its cuisine."],
        ["Chunking splits a document into passages."],
        ["Recall at ten is the headline metric."],
    ]
    assert [q["id"] for q in result["questions"]] == ["q1", "q2", "q3", "q4"]
    assert result["questions"][0]["answer"] == "Paris"
    assert result["dropped"] == []
    assert len(model.calls) == 4
    assert model.calls[0]["api_key"] == KEY


def test_a_gold_passage_not_in_the_text_is_dropped_with_a_reason(fake):
    fake([GOOD[0], reply("What is the capital of Spain?", "Madrid is the capital of Spain.")])
    result = write_questions(TEXT, model="claude-haiku-4-5", count=2, credentials=CREDS)
    assert [q["question"] for q in result["questions"]] == ["Which city is the seat of government in France?"]
    assert result["dropped"] == [
        {"question": "What is the capital of Spain?", "reason": result["dropped"][0]["reason"]}
    ]
    assert "not in the document" in result["dropped"][0]["reason"]


def test_a_passage_found_only_after_normalising_is_kept(fake):
    fake([reply("Which city is the seat of government?", "the capital of  France is Paris.")])
    result = write_questions(TEXT, model="claude-haiku-4-5", count=1, credentials=CREDS)
    assert len(result["questions"]) == 1


def test_a_question_copied_from_its_passage_is_tagged_copied(fake):
    fake([reply("Is the capital of France Paris?", "The capital of France is Paris."), GOOD[1]])
    result = write_questions(TEXT, model="claude-haiku-4-5", count=2, credentials=CREDS)
    assert result["questions"][0]["tags"] == ["copied"]
    assert result["questions"][1]["tags"] == []


def test_near_duplicates_and_same_passage_duplicates_are_dropped(fake):
    fake([
        GOOD[0],
        reply("Which city is the seat of government in France ?", "Lyon is renowned for its cuisine."),
        reply("Name the main French city of government.", "The capital of France is Paris."),
        GOOD[3],
    ])
    result = write_questions(TEXT, model="claude-haiku-4-5", count=4, credentials=CREDS)
    assert [q["gold_answers"][0] for q in result["questions"]] == [
        "The capital of France is Paris.",
        "Recall at ten is the headline metric.",
    ]
    reasons = [d["reason"] for d in result["dropped"]]
    assert "near duplicate" in reasons[0]
    assert "same gold passage" in reasons[1]


def test_a_bad_json_reply_is_a_drop_not_an_exception(fake):
    fake(["Sure! Here is a question about Lyon.", "```json\n" + GOOD[2] + "\n```"])
    result = write_questions("Lyon is renowned for its cuisine.\n\nChunking splits a document into passages.",
                             model="claude-haiku-4-5", count=2, credentials=CREDS)
    assert [q["gold_answers"][0] for q in result["questions"]] == ["Chunking splits a document into passages."]
    assert result["dropped"][0]["question"] == ""
    assert "part 1" in result["dropped"][0]["reason"]


def test_a_reply_missing_a_field_is_a_drop(fake):
    fake([json.dumps({"question": "What?"})])
    result = write_questions(TEXT, model="claude-haiku-4-5", count=1, credentials=CREDS)
    assert result["questions"] == [] and len(result["dropped"]) == 1


def test_the_output_passes_parse_question_set_unchanged(fake):
    fake(GOOD)
    result = write_questions(TEXT, model="claude-haiku-4-5", count=4, credentials=CREDS)
    parsed = parse_question_set(json.dumps(result).encode("utf-8"))
    assert parsed == {k: result[k] for k in ("format", "version", "document", "questions")}


def test_evaluate_accepts_the_output(fake, tmp_path):
    pdf = tmp_path / "docs" / "sample.pdf"
    pdf.parent.mkdir()
    pdf.write_bytes(build_pdf(SAMPLE_PAGES))
    doc = pandion.parse(pdf, use="pdfium")
    fake([reply("Which city is the seat of government in France?", "The capital of France is Paris.")] * 20)
    result = write_questions(doc, model="claude-haiku-4-5", count=1, credentials=CREDS)
    p = pandion.Pipeline(
        path=tmp_path / "index", parse="pdfium",
        chunk={"use": "recursive_character", "chunk_size": 70, "chunk_overlap": 10},
        embed="fake-deterministic", store="lancedb", search={"use": "hybrid_rrf", "top_k": 5},
    )
    p.index.run(pdf.parent)
    report = pandion.evaluate(p, result)
    assert report.total == 1 and report.found == 1


def test_the_count_is_respected_and_fewer_paragraphs_mean_fewer_parts(fake):
    model = fake(GOOD)
    result = write_questions(TEXT, model="claude-haiku-4-5", count=15, credentials=CREDS)
    assert len(model.calls) == 4 and result["parts"] == 4
    assert len(result["questions"]) == 4

    model = fake(GOOD)
    result = write_questions(TEXT, model="claude-haiku-4-5", count=2, credentials=CREDS)
    assert len(model.calls) == 2 and len(result["questions"]) <= 2
    # Two parts of two paragraphs each, in order.
    assert "Paris" in model.calls[0]["user"] and "Lyon" in model.calls[0]["user"]
    assert "Chunking" in model.calls[1]["user"] and "Recall" in model.calls[1]["user"]
    assert "Chunking" not in model.calls[0]["user"]


def test_a_parsed_document_is_split_by_paragraph_spans(fake, tmp_path):
    pdf = tmp_path / "a.pdf"
    pdf.write_bytes(build_pdf(SAMPLE_PAGES))
    doc = pandion.parse(pdf, use="pdfium")
    text, spans = document_text(doc), paragraph_spans(doc)
    model = fake([GOOD[0]] * len(spans))
    write_questions(doc, model="claude-haiku-4-5", count=len(spans), credentials=CREDS)
    assert len(model.calls) == len(spans)
    for call, (start, end) in zip(model.calls, spans):
        assert text[start:end] in call["user"]


def test_count_must_be_at_least_one():
    with pytest.raises(ValueError, match="at least 1"):
        write_questions(TEXT, model="claude-haiku-4-5", count=0, credentials=CREDS)


def test_an_unknown_model_names_the_choices():
    with pytest.raises(ValueError, match="claude-haiku-4-5"):
        write_questions(TEXT, model="no-such-model", credentials=CREDS)


def test_usage_is_summed_over_calls(fake):
    fake(GOOD[:2])
    result = write_questions(TEXT, model="claude-haiku-4-5", count=2, credentials=CREDS)
    assert result["usage"] == {"input_tokens": 20, "output_tokens": 10, "model": "served/model"}


def test_usage_is_none_when_a_server_reports_none(fake):
    fake(GOOD[:2], usage=lambda n: {"input_tokens": 7, "output_tokens": None})
    result = write_questions(TEXT, model="claude-haiku-4-5", count=2, credentials=CREDS)
    assert result["usage"]["input_tokens"] == 14
    assert result["usage"]["output_tokens"] is None


def test_no_key_gives_the_chat_steps_message():
    with pytest.raises(ValueError) as caught:
        write_questions(TEXT, model="claude-haiku-4-5", credentials={})
    assert str(caught.value) == llm.no_key_message("anthropic")


def test_an_error_message_never_contains_the_key(monkeypatch):
    def leaky(model, **kwargs):
        raise RuntimeError(f"the server said no to {kwargs['api_key']}")

    monkeypatch.setattr(llm, "complete", leaky)
    with pytest.raises(RuntimeError) as caught:
        write_questions(TEXT, model="claude-haiku-4-5", credentials=CREDS)
    assert KEY not in str(caught.value)
    assert "[redacted]" in str(caught.value)
    # The original exception holds the key, so it is not chained.
    assert caught.value.__cause__ is None and caught.value.__suppress_context__


def test_custom_endpoint_passes_its_name_and_url(fake):
    model = fake(GOOD[:1])
    write_questions(TEXT, model="custom", count=1, model_name="llama3", base_url="http://localhost:11434/v1")
    assert model.calls[0]["model_name"] == "llama3"
    assert model.calls[0]["base_url"] == "http://localhost:11434/v1"


# ---------------------------------------------------------------------------
# the CLI
# ---------------------------------------------------------------------------


def test_the_cli_writes_the_set_and_prints_a_summary(fake, tmp_path, monkeypatch, capsys):
    pdf = tmp_path / "sample.pdf"
    pdf.write_bytes(build_pdf(SAMPLE_PAGES))
    out = tmp_path / "questions.json"
    monkeypatch.setenv("ANTHROPIC_API_KEY", KEY)
    fake([
        reply("Which city is the seat of government in France?", "The capital of France is Paris."),
        reply("What is the capital of Spain?", "Madrid is the capital of Spain."),
        reply("Is the capital of France Paris?", "Lyon is renowned for its cuisine."),
    ] * 5)

    code = cli.main(["questions", str(pdf), "--model", "claude-haiku-4-5", "--count", "3", "--out", str(out)])

    printed = capsys.readouterr()
    assert code == 0, printed.err
    written = json.loads(out.read_text(encoding="utf-8"))
    assert parse_question_set(out.read_bytes())["questions"] == written["questions"]
    assert "Kept" in printed.out and "Dropped" in printed.out
    assert "not in the document" in printed.out
    assert "tokens" in printed.out
    assert KEY not in printed.out + printed.err


def test_the_cli_without_a_key_says_so_plainly(tmp_path, monkeypatch, capsys):
    pdf = tmp_path / "sample.pdf"
    pdf.write_bytes(build_pdf(SAMPLE_PAGES))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    code = cli.main(["questions", str(pdf), "--model", "claude-haiku-4-5", "--out", str(tmp_path / "q.json")])
    assert code == 2
    assert "No Anthropic API key" in capsys.readouterr().err


def test_the_cli_hides_the_key_in_a_model_error(tmp_path, monkeypatch, capsys):
    pdf = tmp_path / "sample.pdf"
    pdf.write_bytes(build_pdf(SAMPLE_PAGES))
    monkeypatch.setenv("ANTHROPIC_API_KEY", KEY)

    def leaky(model, **kwargs):
        raise RuntimeError(f"bad key {kwargs['api_key']}")

    monkeypatch.setattr(llm, "complete", leaky)
    code = cli.main(["questions", str(pdf), "--model", "claude-haiku-4-5", "--out", str(tmp_path / "q.json")])
    printed = capsys.readouterr()
    assert code == 1
    assert "[redacted]" in printed.err and KEY not in printed.err + printed.out

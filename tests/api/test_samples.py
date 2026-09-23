"""I-25: the committed question set, and GET /api/samples/questions.

The set cannot rot: every gold answer is checked, word for word, against the
pdfium parse of the committed sample. Change the sample and this test says which
question no longer has an answer in the document.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from api.routes.learn import PARSE
from core.ports import RunContext, Stage
from core.registry import registry
from plugins.chunk import DocView

ROOT = Path(__file__).resolve().parents[2]
QUESTIONS = ROOT / "samples" / "questions.json"
SAMPLE = ROOT / "samples" / "chunking-primer.pdf"

#: Words too common to count as shared wording between a question and its answer.
STOPWORDS = frozenset(
    "a an and are as at be but by can do does for from how in into is it its "
    "not of on one or that the their them then there these they this to two "
    "what when where which who why will with you your".split()
)


@pytest.fixture(scope="module")
def sample_text(tmp_path_factory) -> str:
    tmp = tmp_path_factory.mktemp("sample")
    cls = registry.get(Stage.PARSE, PARSE["transform"])
    ctx = RunContext(output_dir=tmp, emit=lambda e: None, tmp=tmp)
    doc = cls().apply(
        {"file": {"path": str(SAMPLE), "sha": "sample", "filename": SAMPLE.name}},
        cls.config_model(**PARSE["config"]),
        ctx,
    )
    return DocView.of(doc).text


@pytest.fixture
def questions(client) -> list[dict]:
    r = client.get("/api/samples/questions")
    assert r.status_code == 200, r.text
    return r.json()


def words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z]+", text.lower()) if w not in STOPWORDS}


# --------------------------------------------------------------------------
# the route serves the committed file
# --------------------------------------------------------------------------


def test_the_route_serves_the_committed_file(questions):
    assert questions == json.loads(QUESTIONS.read_text(encoding="utf-8"))


def test_every_question_has_the_i25_shape(questions):
    for item in questions:
        assert set(item) == {"id", "question", "gold_answer"}
        assert all(isinstance(v, str) and v.strip() for v in item.values())


def test_there_are_eight_to_ten_questions_with_unique_ids(questions):
    assert 8 <= len(questions) <= 10
    ids = [item["id"] for item in questions]
    assert len(set(ids)) == len(ids)


# --------------------------------------------------------------------------
# the set cannot rot
# --------------------------------------------------------------------------


def test_every_gold_answer_appears_verbatim_in_the_parsed_sample(
    questions, sample_text
):
    for item in questions:
        assert item["gold_answer"] in sample_text, item["id"]


def test_every_question_ends_in_a_question_mark(questions):
    for item in questions:
        assert item["question"].endswith("?"), item["id"]


# --------------------------------------------------------------------------
# the set covers easy and hard cases on purpose
# --------------------------------------------------------------------------


def test_at_least_one_gold_answer_spans_two_sentences(questions):
    assert any(
        re.search(r"[.!?]\s+[A-Z]", item["gold_answer"]) for item in questions
    )


def test_at_least_one_answer_shares_no_wording_with_its_question(questions):
    assert any(
        not (words(item["question"]) & words(item["gold_answer"]))
        for item in questions
    )


def test_most_questions_do_share_wording_so_the_set_is_not_all_hard(questions):
    shared = sum(
        bool(words(item["question"]) & words(item["gold_answer"]))
        for item in questions
    )
    assert shared >= len(questions) // 2

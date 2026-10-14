"""Names a server needs from Pandion's public API: the text a gold passage is
looked for in, and the check a custom model endpoint must pass."""

import pytest

import pandion
import pandion.endpoints
import pandion.llm
from pandion.evaluation import check_questions, document_text, load_questions
from pandion.extend import EndpointRefused, guard_endpoint, openai_client_kwargs
from pdfs import SAMPLE_PAGES, build_pdf


def test_document_text_is_the_text_a_gold_passage_is_looked_for_in(tmp_path):
    pdf = tmp_path / "r.pdf"
    pdf.write_bytes(build_pdf(SAMPLE_PAGES))
    parsed = pandion.parse(pdf, use="pdfium")
    text = document_text(parsed)
    assert "The capital of France is Paris." in text
    assert document_text(parsed.output) == text == document_text(parsed.output.model_dump())
    questions = load_questions(
        [{"question": "Capital?", "gold_answers": ["The capital of France is Paris."]}]
    )["questions"]
    assert check_questions(questions, text)[0]["status"] == "found"


def test_document_text_is_public():
    assert "document_text" in pandion.evaluation.__all__


def test_the_endpoint_check_is_public_and_the_same_object():
    assert guard_endpoint is pandion.endpoints.guard_endpoint
    assert EndpointRefused is pandion.endpoints.EndpointRefused
    assert openai_client_kwargs is pandion.llm.openai_client_kwargs
    for name in ("EndpointRefused", "guard_endpoint", "openai_client_kwargs"):
        assert name in pandion.extend.__all__


def test_a_private_address_is_refused_when_only_public_ones_are_allowed():
    with pytest.raises(EndpointRefused):
        guard_endpoint("http://127.0.0.1:8080/v1", public_only=True)

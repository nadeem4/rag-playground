"""The miss trace, public in pandion.evaluation, reads stored JSON or objects alike."""

from pandion.evaluation import StepInput, trace
from pandion.payloads import Chunk, ChunkSet, Element, Hit, ParsedDoc, RetrievalResult

GOLD = "The capital of France is Paris."


def doc(*texts):
    return ParsedDoc(elements=[Element(id=f"e{i}", type="paragraph", text=t, order=i) for i, t in enumerate(texts)])


def result(*texts):
    return RetrievalResult(
        hits=[Hit(chunk=Chunk(id=f"r{i}", text=t), score=1.0 - i / 10, rank=i + 1) for i, t in enumerate(texts)]
    )


def run(parsed, chunks, found, top_k=5):
    return trace(
        golds=[GOLD],
        parse=StepInput("pdfium", parsed),
        cleans=[],
        chunks=chunks,
        retrieve=found,
        final=None,
        rerank_name=None,
        top_k=top_k,
    )


def test_objects_are_read_like_stored_json():
    parsed = doc("Intro.", GOLD)
    chunks = ChunkSet(chunks=[Chunk(id="c0", text="Intro."), Chunk(id="c1", text=GOLD)])
    found = result("Intro.", GOLD)
    as_objects = run(parsed, chunks, found)
    as_json = run(parsed.model_dump(mode="json"), chunks.model_dump(mode="json"), found.model_dump(mode="json"))
    assert as_objects == as_json
    assert as_objects["lost_at"] is None


def test_an_answer_below_the_cut_is_lost_at_top_k():
    parsed = doc("Intro.", GOLD)
    chunks = ChunkSet(chunks=[Chunk(id="c0", text="Intro."), Chunk(id="c1", text=GOLD)])
    out = run(parsed, chunks, result("Intro.", GOLD), top_k=1)
    assert out["lost_at"] == "top_k"
    assert out["finding"] == "Lost at Top 1. Piece 2 came back 2nd, below the 1 piece checked."


def test_an_answer_the_parser_never_produced_is_lost_at_parse():
    out = run(doc("Something else entirely, about columns and layout, with more than enough words in it "
                  "that nobody could mistake this page for a scanned one at all."),
              ChunkSet(chunks=[]), result())
    assert out["lost_at"] == "parse"
    assert out["finding"] == "Lost at Parse. The answer is not in the text pdfium produced."
    assert [s["status"] for s in out["steps"]] == ["lost", "not_checked", "not_checked", "not_checked"]

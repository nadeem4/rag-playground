"""The miss trace: which step lost a question's answer, and the evidence."""

from __future__ import annotations

from api.trace import StepInput, trace
from core.payloads import Chunk, ChunkSet, Element, Hit, ParsedDoc, RetrievalResult

GOLD = "the number of readers who lost their place halfway down a page fell by more than half"


def doc(*paragraphs: str) -> dict:
    return ParsedDoc(
        elements=[Element(id=f"e{i}", type="paragraph", text=t, order=i) for i, t in enumerate(paragraphs)]
    ).model_dump(mode="json")


def chunk_set(*texts: str) -> dict:
    return ChunkSet(chunks=[Chunk(id=f"c{i}", text=t) for i, t in enumerate(texts)]).model_dump(mode="json")


def result(*texts: str) -> dict:
    return RetrievalResult(
        hits=[Hit(chunk=Chunk(id=f"r{i}", text=t), score=1.0 - i / 10, rank=i + 1) for i, t in enumerate(texts)]
    ).model_dump(mode="json")


GOOD = f"Intro words here. In the study {GOLD}. More words after it."
OTHER = "Something else entirely about columns and layout."


def run(**over):
    args = dict(
        golds=[GOLD],
        parse=StepInput("Fast text", doc(GOOD)),
        cleans=[StepInput("Remove duplicate blocks", doc(GOOD))],
        chunks=chunk_set(OTHER, GOOD),
        retrieve=result(OTHER, GOOD),
        final=None,
        rerank_name=None,
        top_k=5,
    )
    args.update(over)
    return trace(**args)


def statuses(t: dict) -> list[tuple[str, str]]:
    return [(s["stage"], s["status"]) for s in t["steps"]]


def test_a_hit_passes_every_step_and_names_the_piece_and_rank():
    t = run()
    assert t["lost_at"] is None
    assert t["finding"] == "Found. The answer came through every step."
    assert statuses(t) == [
        ("parse", "pass"),
        ("clean", "pass"),
        ("chunk", "pass"),
        ("search", "pass"),
        ("top_k", "pass"),
    ]
    chunk = t["steps"][2]
    assert chunk["sentence"] == "Whole inside piece 2 of 2."
    assert t["steps"][3]["sentence"] == "Piece 2 came back 2nd of 2."
    assert t["steps"][4]["name"] == "Top 5"
    assert t["steps"][4]["sentence"] == "2nd, inside the 5 pieces checked."


def test_words_split_by_other_text_are_lost_at_parse_with_evidence():
    broken = (
        "A reader who has to the number of readers who lost their place hunt for the next "
        "line has already stopped halfway down a page fell by more than half. reading."
    )
    t = run(parse=StepInput("Fast text", doc(broken)))
    assert t["lost_at"] == "parse"
    assert t["finding"].startswith("Lost at Parse.")
    assert statuses(t) == [
        ("parse", "lost"),
        ("clean", "not_checked"),
        ("chunk", "not_checked"),
        ("search", "not_checked"),
        ("top_k", "not_checked"),
    ]
    parse = t["steps"][0]
    assert parse["evidence"]["kind"] == "broken"
    parts = parse["evidence"]["parts"]
    answer = " ".join(p["text"] for p in parts if p["kind"] == "answer")
    other = " ".join(p["text"] for p in parts if p["kind"] == "other")
    assert answer == "the number of readers who lost their place halfway down a page fell by more than half."
    assert other == "hunt for the next line has already stopped"
    assert parts[0] == {"kind": "context", "text": "A reader who has to"}
    assert "layout" in t["fix"]


def test_absent_words_are_lost_at_parse_without_evidence():
    t = run(parse=StepInput("Fast text", doc(OTHER * 5)))
    assert t["lost_at"] == "parse"
    assert t["steps"][0]["evidence"] is None
    assert t["steps"][0]["sentence"] == "The answer's words are not in the parsed text."


def test_almost_no_text_suggests_the_page_is_scanned():
    t = run(parse=StepInput("Fast text", doc("Page 1")))
    assert "scanned" in t["steps"][0]["sentence"]
    assert "OCR" in t["fix"]


def test_a_cleaner_that_removed_it_is_named():
    t = run(cleans=[StepInput("Remove duplicate blocks", doc(OTHER))])
    assert t["lost_at"] == "clean"
    assert t["steps"][1]["sentence"] == "Parse had it, and Remove duplicate blocks removed it."
    assert t["finding"].startswith("Lost at Clean.")


def test_an_answer_cut_across_two_pieces_names_both():
    words = GOOD.split()
    half = len(words) // 2
    t = run(chunks=chunk_set(OTHER, " ".join(words[:half]), " ".join(words[half:])))
    assert t["lost_at"] == "chunk"
    assert t["steps"][2]["sentence"] == "The answer is cut across pieces 2 and 3, so no single piece holds it."


def test_a_piece_that_never_came_back_is_lost_at_search():
    t = run(retrieve=result(OTHER, OTHER))
    assert t["lost_at"] == "search"
    assert t["steps"][3]["sentence"] == "Piece 2 holds the answer, but it was not among the 2 pieces that came back."


def test_a_piece_ranked_below_the_pieces_checked_is_lost_at_top_k():
    t = run(retrieve=result(*([OTHER] * 7), GOOD), top_k=5)
    assert t["lost_at"] == "top_k"
    assert t["steps"][4]["sentence"] == "Piece 2 came back 8th, below the 5 pieces checked."


def test_a_reranker_step_reports_the_rank_after_reranking():
    t = run(retrieve=result(GOOD, OTHER), final=result(*([OTHER] * 6), GOOD), rerank_name="Cross-encoder", top_k=5)
    assert [s["stage"] for s in t["steps"]] == ["parse", "clean", "chunk", "search", "rerank", "top_k"]
    assert t["steps"][4]["sentence"] == "After Cross-encoder, piece 2 is 7th of 7."
    assert t["lost_at"] == "top_k"


def test_a_reranker_that_dropped_it_is_lost_at_rerank():
    t = run(retrieve=result(GOOD, OTHER), final=result(OTHER), rerank_name="Cross-encoder")
    assert t["lost_at"] == "rerank"
    assert t["steps"][4]["sentence"] == "Cross-encoder kept 1 piece, and piece 2 was not among them."


def test_any_of_several_gold_passages_counts():
    t = run(golds=["not in the document at all", GOLD])
    assert t["lost_at"] is None


def test_line_hyphens_and_case_are_matched_like_the_eval_step():
    hyphenated = GOOD.replace("halfway", "half-\nway").upper()
    t = run(parse=StepInput("Fast text", doc(hyphenated)), cleans=[])
    assert t["steps"][0]["status"] == "pass"


# ------------------------------------------------------------------ route --


def test_the_route_traces_a_real_run(client):
    from tests.api.conftest import read_sse, upload_pdf
    from tests.api.test_artifacts import chat_graph

    src = upload_pdf(client)
    graph = chat_graph(src["sha"], src["filename"])
    graph["nodes"] = [n for n in graph["nodes"] if n["id"] != "chat"]
    graph["edges"] = [e for e in graph["edges"] if e["dst"] != "chat"]
    r = client.post("/api/runs", json={"graph": graph})
    events = read_sse(client, r.json()["run_id"])
    ids = {e["node_id"]: e["artifact_id"] for e in events if e["event"] == "node_finished"}
    body = {
        "gold_answers": ["no sentence like this is in the test document"],
        "parse": {"id": ids["parse"], "name": "Fast text"},
        "cleans": [],
        "chunk": ids["chunk"],
        "retrieve": ids["retrieve"],
        "final": ids["retrieve"],
        "rerank_name": None,
        "top_k": 5,
    }
    t = client.post("/api/trace", json=body)
    assert t.status_code == 200, t.text
    data = t.json()
    assert data["lost_at"] == "parse"
    assert [s["stage"] for s in data["steps"]] == ["parse", "chunk", "search", "top_k"]


def test_the_route_refuses_an_unknown_artifact(client):
    body = {
        "gold_answers": ["x"],
        "parse": {"id": "0" * 64, "name": "Fast text"},
        "cleans": [],
        "chunk": "0" * 64,
        "retrieve": "0" * 64,
        "final": "0" * 64,
        "top_k": 5,
    }
    assert client.post("/api/trace", json=body).status_code == 404

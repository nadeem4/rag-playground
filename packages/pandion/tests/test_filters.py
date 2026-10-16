"""Search filters: `where={"document": [...], "pages": [a, b], "section": "..."}`.

The retriever tests build a real LanceDB index from hand-made pieces, so each
piece's pages and heading path are known exactly. The pipeline tests run two
small PDFs through pdfium and the fake embedder, so nothing is downloaded.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from pandion import Pipeline, check_where
from pandion.artifacts import Artifact, ArtifactType
from pandion.config import ConfigError
from pandion.payloads import Chunk, ChunkSet, Query
from pandion.plugins.index.lancedb_store import LanceDbIndex, LanceDbIndexConfig
from pandion.plugins.retrieve import _prf
from pandion.plugins.retrieve.bm25 import Bm25Retriever
from pandion.plugins.retrieve.dense import DenseRetriever
from pandion.plugins.retrieve.hybrid_rrf import HybridRrfRetriever
from pandion.storage import Store
from pdfs import SAMPLE_PAGES, build_pdf
from test_retrieve import _ctx

# --------------------------------------------------------------------------
# an index whose pieces have known pages and sections
# --------------------------------------------------------------------------

#: (id, doc_id, pages, heading path, text). Every text says "France", so every
#: piece is a candidate for every search, and only the filter narrows them.
PIECES = [
    ("c0", "doc-a", (1, 1), ["Intro"], "France intro on the first page"),
    ("c1", "doc-a", (29, 31), ["Guide", "Installing"], "France installing over three pages"),
    ("c2", "doc-a", (50, 50), ["Guide", "Running"], "France running late in the guide"),
    ("c3", "doc-b", None, ["Installing"], "France word file with no pages"),
    ("c4", "doc-b", (30, 30), ["It's here"], "France quoted section heading"),
]


def filtered_index(tmp_path: Path, pieces=PIECES) -> Path:
    by_doc: dict[str, list[Chunk]] = {}
    for n, (cid, doc, pages, path, text) in enumerate(pieces):
        by_doc.setdefault(doc, []).append(
            Chunk(id=cid, text=text, ordinal=n, doc_id=doc, page_span=pages, heading_path=path)
        )
    payloads = [
        ChunkSet(chunks=chunks, doc_id=doc, source_text="").model_dump(mode="json")
        for doc, chunks in by_doc.items()
    ]
    store = Store(tmp_path / "store")
    payload = LanceDbIndex().apply(
        {"chunks": payloads}, LanceDbIndexConfig(embedder="fake-deterministic"), _ctx(tmp_path / "scratch")
    )
    store.put(Artifact(id="b" * 64, type=ArtifactType.INDEX), payload)
    return store.load("b" * 64, ArtifactType.INDEX)


ALL = [DenseRetriever(), Bm25Retriever(), HybridRrfRetriever()]
IDS = [t.name for t in ALL]


def found(transform, index: Path, tmp_path: Path, filters: dict | None, ctx=None) -> set[str]:
    query = Query(text="France", filters=filters)
    payload = transform.apply(
        {"index": index, "query": query.model_dump(mode="json")},
        transform.config_model(top_k=10),
        ctx or _ctx(tmp_path / f"r-{transform.name}"),
    )
    return {hit["chunk"]["id"] for hit in payload["hits"]}


@pytest.mark.parametrize("transform", ALL, ids=IDS)
def test_no_filter_finds_every_piece(transform, tmp_path):
    assert found(transform, filtered_index(tmp_path), tmp_path, None) == {"c0", "c1", "c2", "c3", "c4"}


@pytest.mark.parametrize("transform", ALL, ids=IDS)
@pytest.mark.parametrize(
    ("filters", "expected"),
    [
        ({"doc_ids": ["doc-b"]}, {"c3", "c4"}),
        # c1 spans pages 29 to 31: an overlap counts. c3 has no pages.
        ({"pages": [30, 40]}, {"c1", "c4"}),
        # A section matches any one element of the heading path, exactly.
        ({"section": "Installing"}, {"c1", "c3"}),
        ({"section": "Guide"}, {"c1", "c2"}),
        ({"section": "install"}, set()),
        ({"doc_ids": ["doc-a"], "pages": [30, 40], "section": "Installing"}, {"c1"}),
        ({"doc_ids": ["doc-a", "doc-b"], "pages": [1, 30]}, {"c0", "c1", "c4"}),
    ],
)
def test_each_filter_narrows_the_search(transform, filters, expected, tmp_path):
    assert found(transform, filtered_index(tmp_path), tmp_path, filters) == expected


@pytest.mark.parametrize("transform", ALL, ids=IDS)
def test_pieces_without_pages_never_match_a_pages_filter_and_the_note_says_so(transform, tmp_path):
    ctx = _ctx(tmp_path / "noted")
    assert found(transform, filtered_index(tmp_path), tmp_path, {"pages": [1, 1000]}, ctx) == {"c0", "c1", "c2", "c4"}
    assert "1 piece has no page numbers" in ctx.extras["meta"]["note"]


@pytest.mark.parametrize("transform", ALL, ids=IDS)
def test_a_quote_in_a_section_is_matched_literally(transform, tmp_path):
    index = filtered_index(tmp_path)
    assert found(transform, index, tmp_path, {"section": "It's here"}) == {"c4"}
    assert found(transform, index, tmp_path, {"section": "x' OR '1'='1"}) == set()
    assert found(transform, index, tmp_path, {"doc_ids": ["doc-a') OR ('1'='1"]}) == set()
    assert found(transform, index, tmp_path, {"section": "back\\slash'"}) == set()


@pytest.mark.parametrize("transform", ALL, ids=IDS)
def test_a_backslash_in_a_heading_is_matched_literally(transform, tmp_path):
    pieces = PIECES + [("c5", "doc-a", (60, 60), ["a\\"], "France backslash heading")]
    index = filtered_index(tmp_path, pieces)
    assert found(transform, index, tmp_path, {"section": "a\\"}) == {"c5"}
    assert found(transform, index, tmp_path, {"section": "a"}) == set()


@pytest.mark.parametrize("transform", ALL, ids=IDS)
def test_the_no_pages_note_counts_only_pieces_in_the_section(transform, tmp_path):
    index = filtered_index(tmp_path)
    # c3 has no pages and is under Installing; nothing under Guide lacks pages.
    ctx = _ctx(tmp_path / "guide")
    found(transform, index, tmp_path, {"pages": [1, 1000], "section": "Guide"}, ctx)
    assert "note" not in ctx.extras.get("meta", {})
    ctx = _ctx(tmp_path / "installing")
    found(transform, index, tmp_path, {"pages": [1, 1000], "section": "Installing"}, ctx)
    assert "1 piece has no page numbers" in ctx.extras["meta"]["note"]


@pytest.mark.parametrize("transform", ALL, ids=IDS)
def test_a_section_filter_on_an_index_without_sections_is_an_error(transform, tmp_path):
    flat = [(cid, doc, pages, [], text) for cid, doc, pages, _, text in PIECES]
    index = filtered_index(tmp_path, flat)
    with pytest.raises(ValueError, match="no sections"):
        found(transform, index, tmp_path, {"section": "Installing"})


def test_prf_sees_only_the_filtered_pieces(tmp_path, monkeypatch):
    seen: list[list[str]] = []
    real = _prf.select_terms

    def spy(top, all_texts, question, n):
        all_texts = list(all_texts)
        seen.append(list(top) + all_texts)
        return real(top, all_texts, question, n)

    monkeypatch.setattr(_prf, "select_terms", spy)
    t = HybridRrfRetriever()
    query = Query(text="France", filters={"doc_ids": ["doc-b"]})
    t.apply(
        {"index": filtered_index(tmp_path), "query": query.model_dump(mode="json")},
        t.config_model(top_k=10, query_expansion="prf"),
        _ctx(tmp_path / "prf"),
    )
    doc_b = {text for _, doc, _, _, text in PIECES if doc == "doc-b"}
    # Both the top hits words are borrowed from and the texts they are weighed
    # against come from doc-b only.
    assert seen and set(seen[0]) == doc_b and len(seen[0]) == 4


# --------------------------------------------------------------------------
# checking `where`
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("where", "message"),
    [
        ({"documents": ["a.pdf"]}, "unknown key 'documents'"),
        ({"page": [1, 2]}, "unknown key 'page'"),
        ({"document": "a.pdf"}, "document must be a list"),
        ({"document": []}, "document must name at least one"),
        ({"document": [1]}, "document must be a list of names"),
        ({"pages": [1]}, "pages must be a pair"),
        ({"pages": [1, 2, 3]}, "pages must be a pair"),
        ({"pages": [1.5, 2]}, "pages must be a pair of whole numbers"),
        ({"pages": [True, 2]}, "pages must be a pair of whole numbers"),
        ({"pages": ["1", "2"]}, "pages must be a pair of whole numbers"),
        ({"pages": [5, 2]}, "first page must not be after the last"),
        ({"pages": [0, 2]}, "Pages start at 1"),
        ({"pages": [1, 10**20]}, "A page number must be 2147483647 or less"),
        ({"section": 3}, "section must be text"),
        ({"section": "  "}, "section must not be blank"),
        ("document = 'a'", "where must be a mapping"),
    ],
)
def test_a_bad_where_is_a_plain_error(where, message):
    with pytest.raises(ValueError, match=message):
        check_where(where)


def test_document_order_does_not_change_the_filter():
    from types import SimpleNamespace

    from pandion.filters import resolve

    files = {"x.pdf": SimpleNamespace(sha="2" * 64), "y.pdf": SimpleNamespace(sha="1" * 64)}
    one = resolve({"document": ["x.pdf", "y.pdf"]}, files)
    other = resolve({"document": ["y.pdf", "x.pdf"]}, files)
    assert one == other == {"doc_ids": ["1" * 64, "2" * 64]}


def test_a_good_where_is_returned_in_order():
    assert check_where({"section": "A", "pages": (2, 4), "document": ["x.pdf"]}) == {
        "document": ["x.pdf"], "pages": [2, 4], "section": "A",
    }
    assert check_where(None) is None and check_where({}) is None


# --------------------------------------------------------------------------
# through the pipeline
# --------------------------------------------------------------------------

QUESTION = "What is the capital of France?"

PIPELINE = """\
path: ./index
models:
  device: cpu
index:
  parse:
    use: pdfium
  chunk:
    use: recursive_character
    chunk_size: 70
    chunk_overlap: 10
  embed:
    use: fake-deterministic
  store:
    use: lancedb
retrieve:
  search:
    use: hybrid_rrf
    top_k: 10
answer:
  use: search
"""


def built(tmp_path: Path) -> Pipeline:
    config = tmp_path / "pipeline.yaml"
    config.write_text(PIPELINE, encoding="utf-8")
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "report.pdf").write_bytes(build_pdf(SAMPLE_PAGES))
    (docs / "short.pdf").write_bytes(build_pdf([["Paris is the capital of France."]]))
    p = Pipeline.from_file(config)
    assert p.index.run(docs).ok
    return p


def test_retrieve_and_ask_search_only_the_named_documents(tmp_path):
    p = built(tmp_path)
    shas = {doc_id: f.sha for doc_id, f in p.index.indexed().items()}

    found = p.retrieve(QUESTION, where={"document": ["short.pdf"]})
    answered = p.ask(QUESTION, where={"document": ["short.pdf"]})

    assert found.ok and found.hits
    assert {h.chunk.doc_id for h in found.hits} == {shas["short.pdf"]}
    assert {h.chunk.doc_id for h in answered.hits} == {shas["short.pdf"]}
    # A document's sha names it too, which is how the API names documents.
    by_sha = p.retrieve(QUESTION, where={"document": [shas["report.pdf"]]})
    assert {h.chunk.doc_id for h in by_sha.hits} == {shas["report.pdf"]}


def test_a_pages_filter_keeps_pieces_that_overlap_the_pages(tmp_path):
    p = built(tmp_path)

    result = p.retrieve(QUESTION, where={"document": ["report.pdf"], "pages": [2, 2]})

    assert result.ok and result.hits
    assert all(h.chunk.page_span[0] <= 2 <= h.chunk.page_span[1] for h in result.hits)


def test_the_filter_travels_on_the_query(tmp_path):
    p = built(tmp_path)
    result = p.retrieve(QUESTION, where={"pages": [1, 2]})
    assert result.stages["rewrite"].output.filters == {"pages": [1, 2]}


def test_a_different_where_is_not_served_from_the_other_questions_cache(tmp_path):
    p = built(tmp_path)

    plain = p.retrieve(QUESTION)
    narrowed = p.retrieve(QUESTION, where={"document": ["short.pdf"]})
    again = p.retrieve(QUESTION, where={"document": ["short.pdf"]})

    assert narrowed.stages["search"].status == "executed"
    assert narrowed.stages["search"].artifact_id != plain.stages["search"].artifact_id
    assert {h.chunk.id for h in narrowed.hits} != {h.chunk.id for h in plain.hits}
    assert again.stages["search"].status == "cached"
    assert again.stages["search"].artifact_id == narrowed.stages["search"].artifact_id


def test_no_where_keeps_the_ids_a_search_had_before_filters(tmp_path):
    p = built(tmp_path)
    assert p.retrieve(QUESTION).stages["rewrite"].artifact_id == p.retrieve(QUESTION, where={}).stages["rewrite"].artifact_id
    assert "filters" not in p.retrieval.graph(QUESTION)[0].nodes[-2].config


def test_an_unknown_document_is_a_plain_error(tmp_path):
    p = built(tmp_path)
    with pytest.raises(ValueError, match="no document named 'missing.pdf'.*report.pdf, short.pdf"):
        p.retrieve(QUESTION, where={"document": ["missing.pdf"]})


def test_a_bad_where_fails_before_anything_runs(tmp_path):
    p = built(tmp_path)
    with pytest.raises(ValueError, match="unknown key"):
        p.ask(QUESTION, where={"sql": "1=1"})


def test_a_section_filter_on_pdfium_says_the_index_has_no_sections(tmp_path):
    p = built(tmp_path)

    result = p.retrieve(QUESTION, where={"section": "Introduction"})

    assert not result.ok
    assert "no sections" in result.stages["search"].error


def test_a_filter_is_not_part_of_the_file(tmp_path):
    config = tmp_path / "pipeline.yaml"
    config.write_text(PIPELINE.replace("retrieve:\n", "retrieve:\n  rewrite: {use: text, filters: {pages: [1, 2]}}\n"), encoding="utf-8")
    with pytest.raises(ConfigError, match="retrieve.rewrite sets filters"):
        Pipeline.from_file(config)

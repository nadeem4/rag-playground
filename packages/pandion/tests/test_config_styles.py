"""One pipeline, three ways to write it: YAML, a dict per stage, or classes.

Every way compiles to the same `Graph`, so the same settings give the same
artifact ids and the same results. The styles may be mixed, an unknown setting
fails when the pipeline is built in every style, and `to_yaml()` writes any
pipeline back as a file that builds the same pipeline again.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

import pandion
from pandion import IndexPipeline, Pipeline, QueryPipeline, RetrievalPipeline
from pandion.answer import Chat, Search
from pandion.chunk import RecursiveCharacter, SentenceWindow
from pandion.clean import DedupeBlocks, DropMatching
from pandion.config import ConfigError
from pandion.parse import Docling, Pdfium
from pandion.plugins import discover
from pandion.ports import Stage
from pandion.registry import registry
from pandion.rerank import CrossEncoder, Mmr
from pandion.retrieve import Bm25, Dense, HybridRrf
from pandion.rewrite import LlmRewrite
from pandion.sources import SourceFile
from pdfs import SAMPLE_PAGES, build_pdf

QUESTION = "What is the capital of France?"

YAML = """\
path: ./index
models:
  device: cpu
index:
  parse: {use: pdfium, mode: text}
  clean:
    - use: dedupe_blocks
  chunk: {use: recursive_character, chunk_size: 70, chunk_overlap: 10}
  embed: {use: fake-deterministic}
  store: {use: lancedb, metric: cosine}
retrieve:
  search: {use: hybrid_rrf, top_k: 5}
  rerank:
    - use: mmr
      top_k: 3
      lambda_mult: 0.5
answer: {use: search, top_k: 2}
"""


def docs(tmp_path: Path) -> Path:
    folder = tmp_path / "docs"
    (folder / "guides").mkdir(parents=True, exist_ok=True)
    (folder / "report.pdf").write_bytes(build_pdf(SAMPLE_PAGES))
    (folder / "guides" / "short.pdf").write_bytes(build_pdf([["Paris is the capital of France."]]))
    return folder


def from_yaml(root: Path) -> Pipeline:
    root.mkdir(parents=True, exist_ok=True)
    (root / "pipeline.yaml").write_text(YAML, encoding="utf-8")
    return Pipeline.from_yaml(root / "pipeline.yaml")


def from_dicts(root: Path) -> Pipeline:
    return Pipeline(
        path=root / "index",
        models={"device": "cpu"},
        parse={"use": "pdfium", "mode": "text"},
        clean=[{"use": "dedupe_blocks"}],
        chunk={"use": "recursive_character", "chunk_size": 70, "chunk_overlap": 10},
        embed={"use": "fake-deterministic"},
        store={"use": "lancedb", "metric": "cosine"},
        search={"use": "hybrid_rrf", "top_k": 5},
        rerank=[{"use": "mmr", "top_k": 3, "lambda_mult": 0.5}],
        answer={"use": "search", "top_k": 2},
    )


def from_classes(root: Path) -> Pipeline:
    return Pipeline(
        path=root / "index",
        models={"device": "cpu"},
        parse=Pdfium(mode="text"),
        clean=[DedupeBlocks()],
        chunk=RecursiveCharacter(chunk_size=70, chunk_overlap=10),
        embed="fake-deterministic",
        store={"use": "lancedb", "metric": "cosine"},
        search=HybridRrf(top_k=5),
        rerank=[Mmr(top_k=3, lambda_mult=0.5)],
        answer=Search(top_k=2),
    )


STYLES = {"yaml": from_yaml, "dicts": from_dicts, "classes": from_classes}


def nodes(graph) -> list[tuple]:
    """A graph without its document folder: every node and edge, in order."""
    return [(n.id, n.stage, n.transform, n.config) for n in graph.nodes], list(graph.edges)


def test_the_three_styles_give_the_same_config(tmp_path):
    configs = {name: build(tmp_path).config for name, build in STYLES.items()}
    assert configs["yaml"] == configs["dicts"] == configs["classes"]


def test_the_three_styles_give_the_same_graphs_ids_and_results(tmp_path):
    folder = docs(tmp_path)
    runs = {}
    for name, build in STYLES.items():
        p = build(tmp_path / name)
        report = p.index.run(folder)
        answer = p.ask(QUESTION)
        assert report.ok and answer.ok, name
        runs[name] = {
            "index_graph": nodes(p.index.graph(p.index.documents)[0]),
            "query_graph": nodes(p.query.graph(QUESTION)[0]),
            "index_ids": {
                doc: {stage: r.artifact_id for stage, r in d.stages.items()}
                for doc, d in report.documents.items()
            },
            "index_id": report.index.artifact_id,
            "ask_ids": [answer.stages[s].artifact_id for s in ("rewrite", "search", "answer")]
            + [r.artifact_id for r in answer.stages["rerank"]],
            "hits": [(h.chunk.id, h.rank, h.score) for h in answer.hits],
            "answer": answer.output,
        }
    assert runs["yaml"] == runs["dicts"] == runs["classes"]
    assert runs["yaml"]["hits"]


def test_styles_may_be_mixed(tmp_path):
    mixed = Pipeline(
        path=tmp_path / "index",
        models={"device": "cpu"},
        parse="pdfium",
        clean=[DedupeBlocks(), {"use": "drop_matching", "pattern": "Draft"}],
        chunk={"use": "recursive_character", "chunk_size": 70, "chunk_overlap": 10},
        embed="fake-deterministic",
        store="lancedb",
        search=Dense(),
        rerank=Mmr(top_k=2),
        answer="search",
    )

    assert mixed.config.index.parse == ("pdfium", {})
    assert mixed.config.index.clean == [("dedupe_blocks", {}), ("drop_matching", {"pattern": "Draft"})]
    assert mixed.config.retrieve.rerank == [("mmr", {"top_k": 2})]
    assert mixed.config.answer == ("search", {})


def test_a_class_keeps_only_the_settings_it_was_given():
    """So a class and a dict with the same settings make the same node."""
    assert Docling(do_ocr=False).model_dump(exclude_unset=True) == {"do_ocr": False}
    assert Docling.use == "docling"


def test_a_class_has_the_config_models_fields_and_validation():
    cls = registry.get(Stage.CHUNK, "sentence_window")
    assert SentenceWindow.model_fields.keys() == cls.config_model.model_fields.keys()
    assert isinstance(SentenceWindow(), cls.config_model)
    with pytest.raises(ValueError):
        RecursiveCharacter(chunk_size="large")


@pytest.mark.parametrize(
    "module,stage",
    [
        (pandion.parse, Stage.PARSE),
        (pandion.clean, Stage.CLEAN),
        (pandion.chunk, Stage.CHUNK),
        (pandion.rewrite, Stage.QUERY),
        (pandion.retrieve, Stage.RETRIEVE),
        (pandion.rerank, Stage.RERANK),
    ],
)
def test_every_strategy_has_a_class(module, stage):
    discover()
    uses = {getattr(module, name).use for name in module.__all__}
    assert uses == set(registry.all_for(stage))


def test_the_answer_classes_are_search_and_chat():
    assert (Search.use, Chat.use) == ("search", "chat")


# -- unknown settings, in every style ------------------------------------------------


def test_an_unknown_setting_in_yaml_names_the_stage(tmp_path):
    (tmp_path / "pipeline.yaml").write_text(YAML.replace("mode: text", "mood: text"), encoding="utf-8")
    with pytest.raises(ConfigError, match=r"index.parse \(pdfium\) has no setting 'mood'. Its settings are: mode"):
        Pipeline.from_yaml(tmp_path / "pipeline.yaml")


def test_an_unknown_setting_in_a_dict_names_the_stage(tmp_path):
    with pytest.raises(ConfigError, match=r"index.chunk \(recursive_character\) has no setting 'size'. Its settings are: chunk_size"):
        IndexPipeline(
            path=tmp_path,
            parse="pdfium",
            chunk={"use": "recursive_character", "size": 70},
            embed="fake-deterministic",
            store="lancedb",
        )


@pytest.mark.parametrize(
    "build,named",
    [
        (lambda: Docling(do_ocrr=True), r"index.parse \(docling\) has no setting 'do_ocrr'. Its settings are: "),
        (lambda: DropMatching(patern="x"), r"index.clean \(drop_matching\) has no setting 'patern'"),
        (lambda: Bm25(top=3), r"retrieve.search \(bm25\) has no setting 'top'"),
        (lambda: CrossEncoder(lambda_mult=1), r"retrieve.rerank \(cross_encoder\) has no setting 'lambda_mult'"),
        (lambda: LlmRewrite(temperature=0), r"retrieve.rewrite \(llm_rewrite\) has no setting 'temperature'"),
        (lambda: Chat(temperature=0), r"answer \(chat\) has no setting 'temperature'"),
    ],
)
def test_an_unknown_setting_in_a_class_names_the_stage(build, named):
    with pytest.raises(ConfigError, match=named):
        build()


def test_a_class_in_the_wrong_slot_is_refused(tmp_path):
    with pytest.raises(ConfigError, match="index.parse uses 'dense', which is not a parse strategy"):
        IndexPipeline(path=tmp_path, parse=Dense(), chunk="recursive_character", embed="fake-deterministic", store="lancedb")


def test_a_missing_stage_is_named(tmp_path):
    with pytest.raises(TypeError, match="chunk"):
        IndexPipeline(path=tmp_path, parse="pdfium", embed="fake-deterministic", store="lancedb")


# -- to_yaml ------------------------------------------------------------------------------


@pytest.mark.parametrize("style", STYLES)
def test_to_yaml_builds_the_same_pipeline_again(tmp_path, style):
    p = STYLES[style](tmp_path / style)

    file = tmp_path / "written.yaml"
    text = p.to_yaml(file)
    again = Pipeline.from_yaml(file)

    assert file.read_text(encoding="utf-8") == text
    assert again.config == p.config
    documents = {"a.pdf": SourceFile(sha="a" * 64, filename="a.pdf")}
    assert nodes(again.index.graph(documents)[0]) == nodes(p.index.graph(documents)[0])


def test_a_pipeline_written_back_gives_the_same_ids_and_answer(tmp_path):
    folder = docs(tmp_path)
    p = from_classes(tmp_path / "code")
    p.index.run(folder)
    first = p.ask(QUESTION)

    (tmp_path / "file").mkdir()
    p.to_yaml(tmp_path / "file" / "pipeline.yaml")
    again = Pipeline.from_yaml(tmp_path / "file" / "pipeline.yaml")
    again.index.run(folder)
    second = again.ask(QUESTION)

    for stage in ("rewrite", "search", "answer"):
        assert second.stages[stage].artifact_id == first.stages[stage].artifact_id
    assert second.index.artifact_id == first.index.artifact_id
    # The written file keeps the same index folder, so every step is a cache hit.
    assert second.stages["answer"].status == "cached"
    assert second.output == first.output


def test_to_yaml_writes_the_section_5_shape(tmp_path):
    data = yaml.safe_load(from_classes(tmp_path).to_yaml())

    assert data["index"]["parse"] == {"use": "pdfium", "mode": "text"}
    assert data["index"]["embed"] == {"use": "fake-deterministic"}
    assert data["index"]["store"] == {"use": "lancedb", "metric": "cosine"}
    assert data["retrieve"] == {
        "search": {"use": "hybrid_rrf", "top_k": 5},
        "rerank": [{"use": "mmr", "top_k": 3, "lambda_mult": 0.5}],
    }
    assert data["answer"] == {"use": "search", "top_k": 2}
    assert data["models"] == {"device": "cpu"}


def test_each_part_writes_only_what_it_holds(tmp_path):
    p = from_dicts(tmp_path)

    assert set(yaml.safe_load(p.index.to_yaml())) == {"path", "models", "index"}
    assert set(yaml.safe_load(p.retrieval.to_yaml())) == {"path", "models", "index", "retrieve"}
    assert set(yaml.safe_load(p.query.to_yaml())) == {"path", "models", "index", "retrieve", "answer"}


# -- the parts on their own ---------------------------------------------------------------


def test_the_parts_build_up_one_pipeline(tmp_path):
    index = IndexPipeline(
        path=tmp_path / "index",
        models={"device": "cpu"},
        parse=Pdfium(mode="text"),
        clean=[DedupeBlocks()],
        chunk=RecursiveCharacter(chunk_size=70, chunk_overlap=10),
        embed="fake-deterministic",
        store={"use": "lancedb", "metric": "cosine"},
    )
    retrieval = RetrievalPipeline(index, search=HybridRrf(top_k=5), rerank=[Mmr(top_k=3, lambda_mult=0.5)])
    query = QueryPipeline(retrieval, answer=Search(top_k=2))

    assert query.config == from_dicts(tmp_path).config
    index.run(docs(tmp_path))
    assert query.ask(QUESTION).ok


def test_the_parts_read_their_sections_from_yaml(tmp_path):
    p = from_yaml(tmp_path)
    file = tmp_path / "pipeline.yaml"

    assert IndexPipeline.from_yaml(file).config.index == p.config.index
    assert RetrievalPipeline.from_yaml(file).config.retrieve == p.config.retrieve
    assert QueryPipeline.from_yaml(file).config == p.config


# -- the single-stage calls still work ----------------------------------------------------


def test_the_single_stage_calls_still_work_beside_the_classes(tmp_path):
    pdf = tmp_path / "a.pdf"
    pdf.write_bytes(build_pdf([["Paris is the capital of France."]]))

    parsed = pandion.parse(pdf, use="pdfium")
    cleaned = pandion.clean(parsed, steps=[{"use": "dedupe_blocks"}])
    chunked = pandion.chunk(cleaned, use="recursive_character", chunk_size=70)
    query = pandion.rewrite(QUESTION, use="text")

    assert "Paris" in parsed.output.elements[0].text
    assert chunked.output.chunks and query.output.text == QUESTION
    assert pandion.parse.Docling is Docling

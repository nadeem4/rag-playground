"""The app answers with the pandion package, not with a copy of its own.

The `search` and `chat` steps moved into pandion as the answer step. These
tests prove the app runs on them: the app's registry holds the package's
classes under the use_case stage, the old modules are gone, the app's own
plugins are only `eval` and the demo switch, and a graph run the way the API
runs it (the executor, the app's registry and store, `Deps.run_extras`) gives
the same artifact ids and the same answer as `p.ask` with the same settings on
the same file. The fake embedder keeps it offline.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest
import yaml

from api.deps import build_deps
from pandion import Pipeline
from pandion.artifacts import ArtifactType
from pandion.executor import run
from pandion.graph import Edge, Graph, Node
from pandion.payloads import Output
from pandion.ports import Stage
from pandion.registry import registry
from tests.plugins.conftest import SAMPLE_PAGES, build_pdf

QUESTION = "What is the capital of France?"
ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize("name", ["search", "chat"])
def test_the_app_registry_holds_the_package_answer_step(name):
    assert registry.get(Stage.USE_CASE, name).__module__ == f"pandion.plugins.answer.{name}"


@pytest.mark.parametrize(
    "module", ["plugins.use_case.search", "plugins.use_case.chat", "plugins.use_case._grounding"]
)
def test_the_old_module_is_gone(module):
    assert importlib.util.find_spec(module) is None


def test_the_apps_own_plugins_are_only_eval_and_the_demo_switch():
    files = sorted(p.relative_to(ROOT / "plugins").as_posix() for p in (ROOT / "plugins").rglob("*.py"))
    assert files == ["__init__.py", "hosted_demo.py", "use_case/__init__.py", "use_case/eval.py"]


CHUNK = {"chunk_size": 70, "chunk_overlap": 10}
SEARCH = {"top_k": 4}
ANSWER = {"top_k": 2}


def test_the_app_run_gives_the_same_answer_as_p_ask(tmp_path):
    docs = tmp_path / "docs"
    docs.mkdir()
    pdf = docs / "sample.pdf"
    pdf.write_bytes(build_pdf(SAMPLE_PAGES))

    deps = build_deps(
        artifacts_dir=tmp_path / "artifacts",
        sources_dir=tmp_path / "sources",
        web_dist=tmp_path / "web",
    )
    stored = deps.run_extras()["sources"].add(pdf)
    graph = Graph(
        nodes=[
            Node("src", Stage.SOURCE, "upload", {"sha": stored.sha, "filename": stored.filename}),
            Node("q", Stage.QUERY, "text", {"text": QUESTION}),
            Node("parse", Stage.PARSE, "pdfium", {}),
            Node("chunk", Stage.CHUNK, "recursive_character", CHUNK),
            Node("index", Stage.INDEX, "lancedb", {"embedder": "fake-deterministic"}),
            Node("bm25", Stage.RETRIEVE, "bm25", SEARCH),
            Node("answer", Stage.USE_CASE, "search", ANSWER),
        ],
        edges=[
            Edge("src", "parse", "file"),
            Edge("parse", "chunk", "doc"),
            Edge("chunk", "index", "chunks"),
            Edge("index", "bm25", "index"),
            Edge("bm25", "answer", "result"),
        ],
    )
    in_app = run(graph, deps.registry, deps.store, context_extras=deps.run_extras())
    assert in_app.ok
    app_output = Output.model_validate(
        deps.store.load(in_app.nodes["answer"].artifact.id, ArtifactType.OUTPUT)
    )

    config = tmp_path / "pipeline.yaml"
    config.write_text(
        yaml.safe_dump(
            {
                "path": "./pandion",
                "index": {
                    "parse": {"use": "pdfium"},
                    "chunk": {"use": "recursive_character", **CHUNK},
                    "embed": {"use": "fake-deterministic"},
                    "store": {"use": "lancedb"},
                },
                "retrieve": {"search": {"use": "bm25", **SEARCH}},
                "answer": {"use": "search", **ANSWER},
            }
        ),
        encoding="utf-8",
    )
    p = Pipeline.from_yaml(config)
    p.index.run(docs)
    answer = p.ask(QUESTION)

    assert answer.stages["answer"].artifact_id == in_app.nodes["answer"].artifact.id
    assert answer.stages["search"].artifact_id == in_app.nodes["bm25"].artifact.id
    assert answer.output == app_output
    assert answer.output.payload["results"]

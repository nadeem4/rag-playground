"""Regenerate the frontend's JSON fixtures from the real engine.

    uv run python web/scripts/export_fixtures.py

The UI is built against these files, so they must be *produced*, never typed by
hand: every shape in `web/src/api/fixtures/` is exactly what the API will serve.

What it does:

1. `plugins.discover()` then `registry.export_schema()` -> `registry.json`.
2. Builds a three-page technical PDF with the same generator the plugin tests use
   (`tests/plugins/conftest.py::build_paragraph_pdf`), typeset with real
   paragraph spacing (a larger gap between paragraphs than between lines), a
   running head and a page number on every page and one repeated paragraph, so
   both cleaners have real work to do.
3. Runs a real graph through `core.executor.run` against a throwaway store:
   upload -> pdfium -> header_footer_strip -> dedupe_blocks -> three chunkers.
4. Writes each node's payload, plus the executor's event stream, as JSON.
5. Runs the same document once more with pdfium's `join_lines` off, through the
   same cleaners into `recursive_character` only, and writes that pair as
   `*.join_lines_off.json`: one element per line versus rebuilt paragraphs,
   the parsing lesson the `/inspect` gallery shows side by side.
6. Runs a retrieval graph over the recursive chunks: a `lancedb` index on the
   `fake-deterministic` embedder (explicit, so the export is deterministic and
   downloads nothing), one question, the three retrievers, and MMR over the
   hybrid result, then Search over MMR. Writes `index.lancedb.json` (the
   descriptor the API serves), `retrieval_result.<retriever>.json`,
   `retrieval_result.mmr.json` and `output.search.json`. The query reaches the
   retrievers and MMR ambiently, and MMR's index (when it has that port) too:
   no explicit edge, exactly as the Build column wires it.
7. Calls `chat` on MMR's result with an OpenAI model, so it cites by sentence
   ids, and writes `output.chat.sentence_ids.json`. The OpenAI client is a fake that
   reads the numbered sources in the prompt and answers with one claim of each
   grounding label (cited, weak, similarity, none) plus one invalid id; the
   grounding itself is the real code on the index's real (fake) embedder. No
   network, no key.

Everything runs in a temp directory; nothing is written to `sources/` or the
artifact store.
"""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import plugins  # noqa: E402
from core.artifacts import ArtifactType  # noqa: E402
from core.executor import run  # noqa: E402
from core.graph import Edge, Graph, Node  # noqa: E402
from core.ports import RunContext, Stage  # noqa: E402
from core.registry import registry  # noqa: E402
from core.storage import Store  # noqa: E402
from plugins.source import upload  # noqa: E402
from plugins.use_case.chat import ChatConfig, ChatUseCase  # noqa: E402
from providers import llm  # noqa: E402
from tests.plugins.conftest import build_paragraph_pdf  # noqa: E402

OUT = ROOT / "web" / "src" / "api" / "fixtures"
FILENAME = "chunking-notes.pdf"
RUNNING_HEAD = "RAG Playground - chunking notes"
REPEATED = "Token counts in this note come from the heuristic counter, not a model tokenizer."
WRAP = 78

#: (heading, paragraphs) per page. Headings are plain one-line paragraphs: pdfium
#: detects no headings, and the fixtures must show what the real parser returns.
PAGES: list[list[tuple[str | None, list[str]]]] = [
    [
        (
            "Why chunk boundaries matter",
            [
                "A retriever never sees a document. It sees chunks, and it can only return "
                "what a chunk contains. If the sentence that answers a question is split "
                "across two chunks, neither half may score well enough to be retrieved, and "
                "the generator is left to guess. Boundary placement is therefore a recall "
                "decision disguised as a preprocessing step.",
                REPEATED,
            ],
        ),
        (
            "Fixed windows",
            [
                "The simplest strategy cuts the text every N tokens with an overlap of M "
                "tokens. It is predictable and cheap, and every chunk has the same cost to "
                "embed. It is also blind to structure: a window will happily start in the "
                "middle of a table row or end halfway through a definition.",
            ],
        ),
    ],
    [
        (
            "Recursive character splitting",
            [
                "Recursive splitting tries a list of separators in order: blank lines, then "
                "single newlines, then sentence ends, then spaces. It only falls back to a "
                "finer separator when a piece is still larger than the budget. The result "
                "respects paragraphs where it can and sentences where it must, which is why "
                "it is the default in most frameworks.",
            ],
        ),
        (
            "Heading-aware sections",
            [
                "A heading-aware chunker starts a new chunk at every heading and carries the "
                "heading path into the chunk metadata. This only works when the parser "
                "reports headings. A plain text extractor returns every line as a paragraph, "
                "so the chunker sees one long section and falls back to its token budget.",
            ],
        ),
    ],
    [
        (
            "Overlap and its cost",
            [
                "Overlap protects answers that straddle a boundary, but every overlapped "
                "token is embedded and stored twice. At an overlap of twenty percent the "
                "index grows by a quarter, and near-duplicate chunks start to crowd each "
                "other out of the top results unless a reranker such as MMR spreads them.",
                REPEATED,
            ],
        ),
        (
            "What to measure",
            [
                "Compare strategies on the same parsed document. Count chunks, look at the "
                "token distribution, and check recall at ten on a fixed question set. A "
                "strategy that wins on one corpus can lose on another, so the comparison is "
                "the result, not the ranking.",
            ],
        ),
    ],
]


def page_paragraphs(
    page_no: int, sections: list[tuple[str | None, list[str]]]
) -> list[list[str]]:
    """One page as paragraphs of wrapped lines. The running head, each heading
    and the page number are paragraphs of their own, set apart by the same
    paragraph gap a typesetter would leave."""
    blocks = [[RUNNING_HEAD]]
    for heading, paragraphs in sections:
        if heading:
            blocks.append([heading])
        for paragraph in paragraphs:
            blocks.append(textwrap.wrap(paragraph, WRAP))
    blocks.append([f"Page {page_no} of {len(PAGES)}"])
    return blocks


CHUNKERS = {
    "chunk_recursive": ("recursive_character", {"chunk_size": 400, "chunk_overlap": 80}),
    "chunk_markdown_header": ("markdown_header", {"max_tokens": 120}),
    "chunk_token": ("token_based", {"max_tokens": 96, "overlap": 16}),
}


def build_graph(sha: str, parse_config: dict | None = None, chunkers: dict = CHUNKERS) -> Graph:
    nodes = [
        Node("src", Stage.SOURCE, "upload", {"sha": sha, "filename": FILENAME}),
        Node("parse", Stage.PARSE, "pdfium", parse_config or {}),
        Node("clean_strip", Stage.CLEAN, "header_footer_strip", {}),
        Node("clean_dedupe", Stage.CLEAN, "dedupe_blocks", {}),
    ]
    edges = [
        Edge("src", "parse", "file"),
        Edge("parse", "clean_strip", "doc"),
        Edge("clean_strip", "clean_dedupe", "doc"),
    ]
    for nid, (transform, config) in chunkers.items():
        nodes.append(Node(nid, Stage.CHUNK, transform, config))
        edges.append(Edge("clean_dedupe", nid, "doc"))
    return Graph(nodes=nodes, edges=edges)


QUESTION = "How does overlap affect index size and duplicate results?"
RETRIEVERS = ("dense", "bm25", "hybrid_rrf")


def build_retrieval_graph(sha: str) -> Graph:
    """Upload -> pdfium -> cleaners -> recursive chunks -> index, then one
    retriever per strategy, MMR over hybrid, and Search over MMR. Only explicit
    ports get edges; `query` (and MMR's `index`, after R1) are ambient."""
    transform, config = CHUNKERS["chunk_recursive"]
    nodes = [
        Node("src", Stage.SOURCE, "upload", {"sha": sha, "filename": FILENAME}),
        Node("parse", Stage.PARSE, "pdfium", {}),
        Node("clean_strip", Stage.CLEAN, "header_footer_strip", {}),
        Node("clean_dedupe", Stage.CLEAN, "dedupe_blocks", {}),
        Node("chunk", Stage.CHUNK, transform, config),
        Node("index", Stage.INDEX, "lancedb", {"embedder": "fake-deterministic"}),
        Node("ask", Stage.QUERY, "text", {"text": QUESTION}),
        *[Node(f"retrieve_{r}", Stage.RETRIEVE, r, {}) for r in RETRIEVERS],
        Node("rerank", Stage.RERANK, "mmr", {}),
        Node("search", Stage.USE_CASE, "search", {}),
    ]
    edges = [
        Edge("src", "parse", "file"),
        Edge("parse", "clean_strip", "doc"),
        Edge("clean_strip", "clean_dedupe", "doc"),
        Edge("clean_dedupe", "chunk", "doc"),
        Edge("chunk", "index", "chunks"),
        *[Edge("index", f"retrieve_{r}", "index") for r in RETRIEVERS],
        Edge("retrieve_hybrid_rrf", "rerank", "result"),
        Edge("rerank", "search", "result"),
    ]
    return Graph(nodes=nodes, edges=edges)


class FakeOpenAI:
    """Stands in for `openai.OpenAI` in the chat fixture: reads the numbered
    sources in the prompt and writes one claim per grounding label."""

    def __init__(self) -> None:
        from types import SimpleNamespace

        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    @staticmethod
    def _create(**kwargs):
        import re
        from types import SimpleNamespace

        prompt = kwargs["messages"][1]["content"]
        shown = dict(re.findall(r"^\[(\d+\.\d+)\] (.+)$", prompt, flags=re.M))
        ids = list(shown)
        overlap = next(i for i in ids if "overlap" in shown[i].lower() and len(shown[i]) > 40)
        other = next(i for i in reversed(ids) if "overlap" not in shown[i].lower())
        unrelated = ids[0] if ids[0] not in (overlap, other) else ids[1]
        text = (
            f"{shown[overlap]} [{overlap}] "
            f"{shown[other]} [{unrelated}] "
            "Most teams settle on an overlap of ten percent [9.9]. "
            f"{shown[ids[len(ids) // 2]]}"
        )
        return SimpleNamespace(
            choices=[SimpleNamespace(
                message=SimpleNamespace(content=text, refusal=None), finish_reason="stop"
            )],
            usage=SimpleNamespace(prompt_tokens=812, completion_tokens=96),
        )


def dump(name: str, data: object) -> None:
    path = OUT / name
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {path.relative_to(ROOT)}")


def main() -> None:
    plugins.discover()
    OUT.mkdir(parents=True, exist_ok=True)
    dump("registry.json", registry.export_schema())

    pdf = build_paragraph_pdf(
        [page_paragraphs(i + 1, sections) for i, sections in enumerate(PAGES)]
    )
    sha = hashlib.sha256(pdf).hexdigest()

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        sources = root / "sources"
        sources.mkdir()
        (sources / f"{sha}.pdf").write_bytes(pdf)
        previous = upload.SOURCES_DIR
        upload.SOURCES_DIR = sources
        try:
            store = Store(root / "store")
            events: list[dict] = []
            result = run(build_graph(sha), registry, store, on_event=events.append)
            if not result.ok:
                failures = {n: r.error for n, r in result.nodes.items() if r.error}
                raise SystemExit(f"pipeline failed: {failures}")

            def payload(nid: str, t: ArtifactType) -> dict:
                return store.load(result.nodes[nid].artifact.id, t)

            dump("parsed_doc.json", payload("parse", ArtifactType.PARSED_DOC))
            dump("parsed_doc_cleaned.json", payload("clean_dedupe", ArtifactType.PARSED_DOC))
            for nid, (transform, _) in CHUNKERS.items():
                dump(f"chunk_set.{transform}.json", payload(nid, ArtifactType.CHUNK_SET))
            dump(
                "artifacts.json",
                {
                    nid: {"id": r.artifact.id, "type": str(r.artifact.type), "meta": r.artifact.meta}
                    for nid, r in result.nodes.items()
                    if r.artifact is not None
                },
            )
            # Timestamps and durations vary run to run; round them so a diff of
            # a regenerated fixture shows shape changes, not clock noise.
            for e in events:
                if "ts" in e:
                    e["ts"] = round(e["ts"], 3)
                if "duration_ms" in e:
                    e["duration_ms"] = round(e["duration_ms"], 3)
            dump("run_events.json", events)

            # The comparison pair: same document, same cleaners, one element per
            # extracted line. Its own run, so run_events/artifacts stay the
            # canonical graph's.
            lines_only = {"chunk_recursive": CHUNKERS["chunk_recursive"]}
            off = run(
                build_graph(sha, {"join_lines": False}, lines_only), registry, store
            )
            if not off.ok:
                failures = {n: r.error for n, r in off.nodes.items() if r.error}
                raise SystemExit(f"join_lines=false pipeline failed: {failures}")
            dump(
                "parsed_doc.join_lines_off.json",
                store.load(off.nodes["parse"].artifact.id, ArtifactType.PARSED_DOC),
            )
            dump(
                "chunk_set.recursive_character.join_lines_off.json",
                store.load(off.nodes["chunk_recursive"].artifact.id, ArtifactType.CHUNK_SET),
            )

            # Retrieval: descriptor, three retrievers, MMR, and Search.
            ret = run(build_retrieval_graph(sha), registry, store)
            if not ret.ok:
                failures = {n: r.error for n, r in ret.nodes.items() if r.error}
                raise SystemExit(f"retrieval pipeline failed: {failures}")
            index_dir = Path(store.load(ret.nodes["index"].artifact.id, ArtifactType.INDEX))
            dump(
                "index.lancedb.json",
                json.loads((index_dir / "descriptor.json").read_text(encoding="utf-8")),
            )
            for r in RETRIEVERS:
                dump(
                    f"retrieval_result.{r}.json",
                    store.load(ret.nodes[f"retrieve_{r}"].artifact.id, ArtifactType.RETRIEVAL_RESULT),
                )
            dump(
                "retrieval_result.mmr.json",
                store.load(ret.nodes["rerank"].artifact.id, ArtifactType.RETRIEVAL_RESULT),
            )
            dump(
                "output.search.json",
                store.load(ret.nodes["search"].artifact.id, ArtifactType.OUTPUT),
            )

            # Chat by sentence ids, against a fake OpenAI client. Called
            # directly, with exactly the inputs the executor would bind, so
            # the fake stays local to this one call.
            previous_client = llm.make_openai_client
            llm.make_openai_client = lambda api_key, base_url=None: FakeOpenAI()
            try:
                output = ChatUseCase().apply(
                    {
                        "result": store.load(
                            ret.nodes["rerank"].artifact.id, ArtifactType.RETRIEVAL_RESULT
                        ),
                        "query": store.load(ret.nodes["ask"].artifact.id, ArtifactType.QUERY),
                        "doc": store.load(
                            ret.nodes["clean_dedupe"].artifact.id, ArtifactType.PARSED_DOC
                        ),
                        "index": index_dir,
                    },
                    ChatConfig(model="gpt-6-astra"),
                    RunContext(
                        output_dir=root, emit=lambda e: None, tmp=root,
                        extras={"credentials": {"openai_api_key": "fixture-key"}},
                    ),
                )
            finally:
                llm.make_openai_client = previous_client
            stats = output["payload"]["stats"]
            if not all(stats[k] >= 1 for k in ("cited", "weak", "similarity", "none", "unknown_ids")):
                raise SystemExit(f"the chat fixture must show every label, got {stats}")
            dump("output.chat.sentence_ids.json", output)
        finally:
            upload.SOURCES_DIR = previous


if __name__ == "__main__":
    main()

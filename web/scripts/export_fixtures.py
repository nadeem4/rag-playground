"""Regenerate the frontend's JSON fixtures from the real engine.

    uv run python web/scripts/export_fixtures.py

The UI is built against these files, so they must be *produced*, never typed by
hand: every shape in `web/src/api/fixtures/` is exactly what the API will serve.

It runs on Pandion's public API and on pandion-api, as any app would:

1. `registry.json`: `pandion.catalog()` as the playground's
   `GET /api/v2/strategies` sends it under `stages`, read from the app on a
   test client, so the settings the app keeps read-only are left out.
2. Builds a three-page technical PDF with the same generator the plugin tests use
   (`tests/steps/conftest.py::build_paragraph_pdf`), typeset with real
   paragraph spacing (a larger gap between paragraphs than between lines), a
   running head and a page number on every page and one repeated paragraph, so
   both cleaners have real work to do.
3. Runs one pipeline per variant through `scripts/lesson_runs.run_pipeline`,
   all into one folder, so the steps they share come from the cache: pdfium,
   header_footer_strip, dedupe_blocks, each chunker, and a `lancedb` index on
   the `fake-deterministic` embedder (explicit, so the export is deterministic
   and downloads nothing). It writes the parsed and cleaned document and each
   chunk set.
4. Runs the same document once more with pdfium's `join_lines` off, into
   `recursive_character` only, and writes that pair as `*.join_lines_off.json`:
   one element per line versus rebuilt paragraphs, the parsing lesson the
   `/inspect` gallery shows side by side.
5. Asks one question over the recursive chunks with each of the three
   searches, MMR after hybrid, then Search. Writes `index.lancedb.json` (the
   descriptor), `retrieval_result.<retriever>.json`,
   `retrieval_result.mmr.json` and `output.search.json`.
6. Asks the same question with `chat` on an OpenAI model, so it cites by
   sentence ids, and writes `output.chat.sentence_ids.json`. The OpenAI client
   is a fake that reads the numbered sources in the prompt and answers with one
   claim of each grounding label (cited, weak, similarity, none) plus one
   invalid id; the grounding itself is the real code on the index's real (fake)
   embedder. No network, no key.
7. Uploads the PDF to a pandion-api test client, runs it through chunk with
   `POST /runs`, and writes the run's events as `run_events.json`, every step
   named (`step`, `document`) as `/api/v2` sends them.

`artifacts.json`, `stages.json` and `output.chat.json` are not written here.

Everything runs in a temp directory; nothing is written to `sources/` or the
artifact store.
"""

from __future__ import annotations

import json
import sys
import tempfile
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from unittest.mock import patch  # noqa: E402

from pandion import Pipeline, ResultStore  # noqa: E402
from scripts.lesson_runs import run_pipeline  # noqa: E402
from tests.steps.conftest import build_paragraph_pdf  # noqa: E402

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
    "recursive_character": {"chunk_size": 400, "chunk_overlap": 80},
    "markdown_header": {"max_tokens": 120},
    "token_based": {"max_tokens": 96, "overlap": 16},
}

#: The fixtures' pipeline: pdfium, both cleaners, recursive chunks, and a
#: LanceDB index on the fake embedder. Each variant changes one step of it.
FIXTURE_PIPELINE = {
    "index": {
        "parse": {"use": "pdfium"},
        "clean": [{"use": "header_footer_strip"}, {"use": "dedupe_blocks"}],
        "chunk": {"use": "recursive_character", **CHUNKERS["recursive_character"]},
        "embed": {"use": "fake-deterministic"},
        "store": {"use": "lancedb"},
    },
}

QUESTION = "How does overlap affect index size and duplicate results?"
RETRIEVERS = ("dense", "bm25", "hybrid_rrf")


def variant(
    *,
    parse: dict | None = None,
    chunk: str = "recursive_character",
    search: str | None = None,
    rerank: list | None = None,
    answer: dict | None = None,
) -> dict:
    """FIXTURE_PIPELINE with its parse or chunker changed, and a search added."""
    index = {**FIXTURE_PIPELINE["index"], "chunk": {"use": chunk, **CHUNKERS[chunk]}}
    if parse is not None:
        index["parse"] = parse
    out: dict = {"index": index}
    if search is not None:
        out["retrieve"] = {"search": {"use": search}, "rerank": rerank or []}
        out["answer"] = answer or {"use": "search"}
    return out


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
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {path.relative_to(ROOT)}")


def write_starter_config(out: Path) -> None:
    """The Starter pipeline file as the browser holds it: without path and models."""
    from pandion import Pipeline

    data = Pipeline.from_yaml(ROOT / "samples" / "starter.yaml").to_dict()
    data.pop("path")
    data.pop("models", None)
    (out / "starter.config.json").write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8", newline="\n")


def write_chat(root: Path, pdf: Path) -> None:
    """`chat` on MMR's result, by sentence ids, against a fake OpenAI client."""
    chat = variant(search="hybrid_rrf", rerank=[{"use": "mmr"}], answer={"use": "chat", "model": "gpt-6-astra"})
    p = Pipeline.from_dict({**chat, "models": {"device": "cpu"}, "path": "."}, base=root)
    p.index.run([str(pdf)])
    with patch("pandion.llm.make_openai_client", lambda api_key, base_url=None, **options: FakeOpenAI()):
        a = p.ask(QUESTION, credentials={"openai_api_key": "fixture-key"})
    if not a.ok:
        raise SystemExit(f"the chat fixture failed: {a.answer.error}")
    output = ResultStore(root).get(a.answer.artifact_id)
    stats = output["payload"]["stats"]
    if not all(stats[k] >= 1 for k in ("cited", "weak", "similarity", "none", "unknown_ids")):
        raise SystemExit(f"the chat fixture must show every label, got {stats}")
    dump("output.chat.sentence_ids.json", output)


def write_run_events(out: Path, pdf: bytes, root: Path) -> None:
    """The events of one /api/v2 run, as the web receives them: every step named."""
    from fastapi.testclient import TestClient
    from pandion import ModelSettings
    from pandion_api import ApiSettings, create_app

    with TestClient(create_app(ApiSettings(data_dir=root, models=ModelSettings(device="cpu")))) as client:
        files = {"file": (FILENAME, pdf, "application/pdf")}
        sha = client.post("/documents", files=files).json()["sha"]
        body = {"config": FIXTURE_PIPELINE, "documents": [sha], "through": "chunk"}
        run_id = client.post("/runs", json=body).json()["run_id"]
        events = []
        with client.stream("GET", f"/runs/{run_id}/events") as r:
            for line in r.iter_lines():
                if line.startswith("data: "):
                    events.append(json.loads(line[6:]))
    # Timestamps and durations vary run to run: zero the one and round the
    # other, so a diff of a regenerated fixture shows shape changes, not clock noise.
    for e in events:
        e["ts"] = 0
        if "duration_ms" in e:
            e["duration_ms"] = round(e["duration_ms"], 3)
    dump("run_events.json", events)


def served_strategies(root: Path) -> dict:
    """`pandion.catalog()` as the playground's GET /api/v2/strategies sends it
    under `stages`: without the settings the app keeps read-only."""
    from fastapi.testclient import TestClient

    from api.deps import build_deps
    from api.main import create_app

    deps = build_deps(artifacts_dir=root / "artifacts", sources_dir=root / "sources", web_dist=root / "dist")
    with TestClient(create_app(deps)) as client:
        return client.get("/api/v2/strategies").json()["stages"]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    write_starter_config(OUT)
    with tempfile.TemporaryDirectory() as tmp:
        dump("registry.json", served_strategies(Path(tmp)))

    pdf_bytes = build_paragraph_pdf(
        [page_paragraphs(i + 1, sections) for i, sections in enumerate(PAGES)]
    )
    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp) / "in"
        folder.mkdir()
        pdf = folder / FILENAME
        pdf.write_bytes(pdf_bytes)
        root = Path(tmp) / "runs"

        for chunker in CHUNKERS:
            out = run_pipeline(variant(chunk=chunker), pdf, root)
            dump(f"chunk_set.{chunker}.json", out["chunk"])
            if chunker == "recursive_character":
                dump("parsed_doc.json", out["parse"])
                dump("parsed_doc_cleaned.json", out["clean.2"])

        # The comparison pair: same document, same cleaners, one element per
        # extracted line.
        out = run_pipeline(variant(parse={"use": "pdfium", "join_lines": False}), pdf, root)
        dump("parsed_doc.join_lines_off.json", out["parse"])
        dump("chunk_set.recursive_character.join_lines_off.json", out["chunk"])

        # Retrieval: the descriptor, three searches, MMR after hybrid, and Search.
        for r in RETRIEVERS:
            rerank = [{"use": "mmr"}] if r == "hybrid_rrf" else []
            out = run_pipeline(variant(search=r, rerank=rerank), pdf, root, question=QUESTION)
            dump(f"retrieval_result.{r}.json", out["search"])
        dump("index.lancedb.json", out["index"])
        dump("retrieval_result.mmr.json", out["rerank.1"])
        dump("output.search.json", out["answer"])

        write_chat(root, pdf)
        write_run_events(OUT, pdf_bytes, Path(tmp) / "api")


if __name__ == "__main__":
    main()

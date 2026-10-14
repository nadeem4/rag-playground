"""Use a running pandion-api server from plain Python, with httpx.

    uv run python examples/pandion-api/run_pipeline.py --url http://127.0.0.1:8000

It checks the pipeline in ../pandion/cli.yaml (the fake embedder, so nothing
downloads), uploads a sample PDF, indexes it, asks one question and evaluates
the pipeline on the sample's question set.

    uv run python examples/pandion-api/run_pipeline.py --template tables precision

With --template it runs a document template and a question template from
playground/templates instead, on the sample that suits the document template,
and asks that sample's first question. The first run downloads the models the
templates use. A template that needs an API key is refused: this client sends none.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import httpx
import yaml

from playground import templates

ROOT = Path(__file__).resolve().parents[2]
PIPELINE = ROOT / "examples" / "pandion" / "cli.yaml"
PDF = ROOT / "samples" / "chunking-primer" / "chunking-primer.pdf"
QUESTIONS = ROOT / "samples" / "chunking-primer" / "questions.json"
QUESTION = "How big should a chunk be?"
API = "/api/v2"


def finish(client: httpx.Client, started: httpx.Response) -> dict:
    """Follow a run's events to the end, then return its state and result."""
    started.raise_for_status()
    run_id = started.json()["run_id"]
    with client.stream("GET", f"{API}/runs/{run_id}/events") as events:
        for line in events.iter_lines():
            if not line.startswith("data: "):
                continue
            event = json.loads(line[6:])
            # An evaluation's step events carry the question's id: show one line per question instead.
            if event["event"] == "node_finished" and "question" not in event:
                done = "reused" if event.get("cache_hit") else "ran"
                print(f"  {event.get('step', event['node_id'])} {done}")
            if event["event"] == "question_finished":
                verdict = "error" if event["error"] else "found" if event["found"] else "missed"
                print(f"  {event['number']} of {event['total']} {event['question']}: {verdict}")
            if event["event"] == "stream_end":
                break
    return client.get(f"{API}/runs/{run_id}").json()


def choose(template: tuple[str, str]) -> tuple[dict, Path, Path, str]:
    """The pipeline made of a (document, question) template pair, the PDF and
    question set of the sample that suits it, and that set's first question."""
    document, question = template
    if templates.needs_key(question):
        name = templates.load("questions")[question]["template"]["name"]
        raise SystemExit(f"{name} needs an API key, and this example sends none. Pick a template that needs no key.")
    config = templates.compose(document, question)
    config.pop("path")  # the server decides where its files go
    sample = ROOT / "samples" / templates.load("documents")[document]["template"]["sample"]
    questions = sample / "questions.json"
    first = json.loads(questions.read_text(encoding="utf-8"))[0]["question"]
    return config, sample / f"{sample.name}.pdf", questions, first


def main(client: httpx.Client, question: str = QUESTION, template: tuple[str, str] | None = None) -> dict:
    config = yaml.safe_load(PIPELINE.read_text(encoding="utf-8"))
    pdf, questions_file = PDF, QUESTIONS
    if template:
        config, pdf, questions_file, question = choose(template)

    checked = client.post(f"{API}/pipelines/validate", json={"config": config}).json()
    if not checked["ok"]:
        raise SystemExit("The pipeline has problems: " + " ".join(checked["problems"]))
    print("The pipeline is valid.")

    with pdf.open("rb") as f:
        uploaded = client.post(f"{API}/documents", files={"file": (pdf.name, f, "application/pdf")})
    uploaded.raise_for_status()
    sha = uploaded.json()["sha"]
    print(f"Uploaded {pdf.name} as {sha[:12]}.")

    print("Indexing:")
    index = finish(client, client.post(f"{API}/runs", json={"config": config, "documents": [sha]}))
    print(f"Indexed: {index['status']}, ok {index['ok']}.")

    print(f"Asking: {question}")
    asked = finish(client, client.post(f"{API}/ask", json={"config": config, "documents": [sha], "question": question}))
    hits = asked["result"]["hits"]
    for hit in hits[:3]:
        text = " ".join(hit["chunk"]["text"].split())
        print(f"Hit {hit['rank']} (score {hit['score']:.3f}): {text[:100]}")

    questions = json.loads(questions_file.read_text(encoding="utf-8"))
    print(f"Evaluating with {len(questions)} questions:")
    evaluated = finish(
        client, client.post(f"{API}/evaluations", json={"config": config, "documents": [sha], "questions": questions})
    )
    report = evaluated["result"]
    print(f"Found {report['found']} of {report['scored']} ({report['hit_rate']:.0%}). Mean reciprocal rank {report['mrr']:.2f}.")

    return {"valid": checked["ok"], "document": sha, "index": index, "hits": hits, "evaluation": report}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    parser.add_argument(
        "--template", nargs=2, metavar=("DOCUMENT", "QUESTION"),
        help="a document template and a question template from playground/templates",
    )
    args = parser.parse_args()
    with httpx.Client(base_url=args.url, timeout=300) as client:
        main(client, template=tuple(args.template) if args.template else None)

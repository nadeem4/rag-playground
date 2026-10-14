"""Use a running pandion-api server from plain Python, with httpx.

    uv run python examples/pandion-api/run_pipeline.py --url http://127.0.0.1:8000

It checks the pipeline in ../pandion/cli.yaml (the fake embedder, so nothing
downloads), uploads a sample PDF, indexes it, asks one question and evaluates
the pipeline on the sample's question set.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import httpx
import yaml

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


def main(client: httpx.Client, question: str = QUESTION) -> dict:
    config = yaml.safe_load(PIPELINE.read_text(encoding="utf-8"))

    checked = client.post(f"{API}/pipelines/validate", json={"config": config}).json()
    if not checked["ok"]:
        raise SystemExit("The pipeline has problems: " + " ".join(checked["problems"]))
    print("The pipeline is valid.")

    with PDF.open("rb") as f:
        uploaded = client.post(f"{API}/documents", files={"file": (PDF.name, f, "application/pdf")})
    uploaded.raise_for_status()
    sha = uploaded.json()["sha"]
    print(f"Uploaded {PDF.name} as {sha[:12]}.")

    print("Indexing:")
    index = finish(client, client.post(f"{API}/runs", json={"config": config, "documents": [sha]}))
    print(f"Indexed: {index['status']}, ok {index['ok']}.")

    print(f"Asking: {question}")
    asked = finish(client, client.post(f"{API}/ask", json={"config": config, "documents": [sha], "question": question}))
    hits = asked["result"]["hits"]
    for hit in hits[:3]:
        text = " ".join(hit["chunk"]["text"].split())
        print(f"Hit {hit['rank']} (score {hit['score']:.3f}): {text[:100]}")

    questions = json.loads(QUESTIONS.read_text(encoding="utf-8"))
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
    args = parser.parse_args()
    with httpx.Client(base_url=args.url, timeout=300) as client:
        main(client)

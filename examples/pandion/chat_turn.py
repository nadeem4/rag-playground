"""One chat turn over the two bundled samples, kept in a conversation store.

The first turn needs no key: it is searched as typed and the pieces found are
the reply. With ANTHROPIC_API_KEY set it also sends a follow-up ("And what about
overlap?"), which one paid Claude Haiku 4.5 call first rewrites into a question
that stands alone. The answer step is asked only that question.

Needs `pandion[sql]` (SQLAlchemy) for the conversation store.

    uv run python examples/pandion/chat_turn.py
    uv run python examples/pandion/chat_turn.py --embedder fake-deterministic
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

import yaml

from pandion import Pipeline
from pandion.extend import chat_turn, fold_summary, get_conversation_store

HERE = Path(__file__).resolve().parent
SAMPLES = HERE.parents[1] / "samples"
FILES = [
    SAMPLES / "chunking-primer" / "chunking-primer.pdf",
    SAMPLES / "two-column-report" / "two-column-report.pdf",
]


def main(work: Path, api_key: str | None = None, embedder: str = "qwen3-embedding-0.6b"):
    """Index the samples under `work`, chat, and return the results (one, or two with a key)."""
    config = yaml.safe_load((HERE / "pipeline.yaml").read_text(encoding="utf-8"))
    config["index"]["embed"]["use"] = embedder
    work.mkdir(parents=True, exist_ok=True)
    file = work / "pipeline.yaml"
    file.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")
    pipeline = Pipeline.from_yaml(file)
    pipeline.index.run(FILES)

    store = get_conversation_store("sql", {"url": f"sqlite:///{work / 'chats.db'}"})  # needs pandion[sql]
    results = [chat_turn(pipeline, store, user_id="me", question="How big should a chunk be?")]
    print(f"Searched with: {results[0].standalone}\n{results[0].text}")
    if api_key:
        credentials = {"anthropic_api_key": api_key}
        results.append(
            chat_turn(
                pipeline, store, user_id="me", question="And what about overlap?",
                conversation_id=results[0].conversation_id, credentials=credentials,
            )
        )
        print(f"\nSearched with: {results[1].standalone}\n{results[1].text}")
        # Run after replying, so the user never waits for it.
        fold_summary(store, conversation_id=results[0].conversation_id, user_id="me", credentials=credentials)
    else:
        print("\nSet ANTHROPIC_API_KEY to send a follow-up that is rewritten to stand alone.")
    return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--embedder", default="qwen3-embedding-0.6b")
    parser.add_argument("--work", type=Path, default=Path("pandion-chat-example"))
    args = parser.parse_args()
    main(args.work, os.environ.get("ANTHROPIC_API_KEY"), args.embedder)

"""The `pandion` command.

`pandion install pipeline.yaml` reads the file, works out which extras its
steps need, and installs them with pip into the Python that runs it.
`--print` only prints the command. Nothing is ever installed while a pipeline
runs.
"""

from __future__ import annotations

import argparse
import subprocess
import sys

from pandion.config import ConfigError, PipelineConfig, load

#: Steps that call a chat model, by stage; their extra depends on the model's provider.
CHAT_STEPS = {"llm_rewrite": "query", "llm_rerank": "rerank", "chat": "use_case"}


def extras_for(config: PipelineConfig) -> list[str]:
    """The extras the pipeline's steps need, sorted.

    Each strategy and embedder names its own extra (`extra = "..."`); one
    that names none needs only the base install.
    """
    from pandion.embeddings import get_embedder
    from pandion.plugins import discover
    from pandion.ports import Stage
    from pandion.registry import registry

    discover()
    index = config.index
    steps = [
        (Stage.SOURCE, index.source[0]),
        (Stage.PARSE, index.parse[0]),
        *((Stage.CLEAN, use) for use, _ in index.clean),
        (Stage.CHUNK, index.chunk[0]),
        (Stage.INDEX, index.store_use),
    ]
    extras = {registry.get(stage, use).extra for stage, use in steps}
    if index.store.get("embedder") is not None:
        extras.add(get_embedder(index.store["embedder"]).extra)
    retrieve = config.retrieve
    if retrieve is not None:
        later = [
            *([(Stage.QUERY, retrieve.rewrite)] if retrieve.rewrite else []),
            (Stage.RETRIEVE, retrieve.search),
            *((Stage.RERANK, step) for step in retrieve.rerank),
        ]
        if config.answer is not None:
            later.append((Stage.USE_CASE, config.answer))
        for stage, (use, settings) in later:
            if use in CHAT_STEPS:
                extras.add(_chat_extra(use, settings))
            else:
                extras.add(registry.get(stage, use).extra)
    extras.discard("")
    return sorted(extras)


def _chat_extra(use: str, settings: dict) -> str:
    """Claude models need the Anthropic SDK; every other model the OpenAI SDK."""
    from pandion.llm import CHAT_MODELS
    from pandion.plugins import discover
    from pandion.ports import Stage
    from pandion.registry import registry

    discover()
    model = registry.get(Stage(CHAT_STEPS[use]), use).config_model(**settings).model
    return "anthropic" if CHAT_MODELS[model].provider == "anthropic" else "openai"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pandion")
    commands = parser.add_subparsers(dest="command", required=True)
    install = commands.add_parser("install", help="install the extras a pipeline file needs")
    install.add_argument("config", help="the pipeline file, for example pipeline.yaml")
    install.add_argument("--print", action="store_true", help="only print the pip command")
    args = parser.parse_args(argv)

    try:
        config = load(args.config)
    except (ConfigError, OSError) as exc:
        print(f"pandion: {exc}", file=sys.stderr)
        return 2
    extras = extras_for(config)
    package = f"pandion[{','.join(extras)}]" if extras else "pandion"
    command = [sys.executable, "-m", "pip", "install", package]
    if args.print:
        print(f'"{sys.executable}" -m pip install "{package}"')
        return 0
    return subprocess.call(command)


if __name__ == "__main__":
    raise SystemExit(main())

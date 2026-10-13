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
        ("index.source", Stage.SOURCE, index.source),
        ("index.parse", Stage.PARSE, index.parse),
        *(("index.clean", Stage.CLEAN, step) for step in index.clean),
        ("index.chunk", Stage.CHUNK, index.chunk),
        ("index.store", Stage.INDEX, (index.store_use, index.store)),
    ]
    if config.retrieve is not None:
        retrieve = config.retrieve
        if retrieve.rewrite:
            steps.append(("retrieve.rewrite", Stage.QUERY, retrieve.rewrite))
        steps.append(("retrieve.search", Stage.RETRIEVE, retrieve.search))
        steps.extend(("retrieve.rerank", Stage.RERANK, step) for step in retrieve.rerank)
        if config.answer is not None:
            steps.append(("answer", Stage.USE_CASE, config.answer))

    extras = set()
    for key, stage, (use, settings) in steps:
        if stage != Stage.INDEX and use in CHAT_STEPS:
            extras.add(_chat_extra(use, settings))
            continue
        try:
            extras.add(registry.get(stage, use).extra)
        except KeyError:
            raise ConfigError(
                f"{key} uses '{use}', which is not registered, so its extra is unknown."
            ) from None
    if index.store.get("embedder") is not None:
        extras.add(get_embedder(index.store["embedder"]).extra)
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

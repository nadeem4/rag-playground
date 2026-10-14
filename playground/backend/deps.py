"""Process-wide dependencies: where the playground's files live.

The sources and artifacts folders default to `sources/` and `artifacts/` at the
repo root and can be moved with `RAG_PLAYGROUND_SOURCES` and
`RAG_PLAYGROUND_ARTIFACTS`; tests pass temp dirs to `build_deps` directly. The
two must sit side by side in one folder, which pandion-api runs every pipeline
under (`playground.backend.main.api_settings`); it keeps the embedding cache in `embeddings/`
beside them. The teaching routes read the sources folder, the expiry sweeper
deletes uploads from it, and the web build is served from `web_dist`.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from pandion import ModelSettings

REPO_ROOT = Path(__file__).resolve().parents[2]

#: How the app loads local models: on the CPU, from the Hugging Face folder.
APP_MODELS = ModelSettings(device="cpu")


@dataclass
class Deps:
    artifacts_dir: Path
    sources_dir: Path
    web_dist: Path


def build_deps(
    *,
    artifacts_dir: Path | None = None,
    sources_dir: Path | None = None,
    web_dist: Path | None = None,
) -> Deps:
    return Deps(
        artifacts_dir=Path(
            artifacts_dir or os.environ.get("RAG_PLAYGROUND_ARTIFACTS") or REPO_ROOT / "artifacts"
        ),
        sources_dir=Path(
            sources_dir or os.environ.get("RAG_PLAYGROUND_SOURCES") or REPO_ROOT / "sources"
        ),
        web_dist=Path(web_dist or REPO_ROOT / "playground" / "frontend" / "dist"),
    )

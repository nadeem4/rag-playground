"""What a pandion-api server is set up with."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from pandion import ModelSettings


@dataclass(frozen=True)
class ApiSettings:
    """`data_dir` is the one folder every request runs under: it becomes the
    pipeline's `path`, whatever a request sends, so Pandion keeps `sources/`,
    `artifacts/` and `embeddings/` there, and pandion-api keeps each document's
    record in `sources/.meta/` and its question set in `sources/questions/`.
    `models` replaces any `models` block a request sends. `prefix` is where the
    routes are mounted, for example "/api/v2"; `title` names the app."""

    data_dir: Path
    models: ModelSettings = field(default_factory=ModelSettings)
    prefix: str = ""
    title: str = "Pandion API"

    @property
    def sources(self) -> Path:
        return Path(self.data_dir) / "sources"

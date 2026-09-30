"""The sample set: every `samples/<name>/` folder with a card, a PDF and questions.

Read once per root. A broken folder is a startup error, not a missing entry:
a sample that silently vanishes from the list is worse than a loud failure.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

SAMPLES_DIR = Path(__file__).resolve().parents[1] / "samples"
FIELDS = ("name", "title", "blurb", "shows", "stresses", "pages", "default")


class SampleSetError(RuntimeError):
    """The sample folders do not describe a valid set."""


@dataclass(frozen=True)
class Sample:
    name: str
    title: str
    blurb: str
    shows: str
    stresses: str
    pages: int
    default: bool
    pdf: Path
    questions_file: Path
    sha: str

    def card(self) -> dict[str, Any]:
        # The Load card's "question" (F6): the first entry of this sample's own
        # question set, so loading a sample asks about that document instead of
        # always seeding the primer's question.
        return {
            **{f: getattr(self, f) for f in FIELDS},
            "filename": self.pdf.name,
            "sha": self.sha,
            "question": self.questions()[0]["question"],
        }

    def questions(self) -> list[dict[str, Any]]:
        return json.loads(self.questions_file.read_text(encoding="utf-8"))


def _load(folder: Path) -> Sample:
    card_file = folder / "sample.json"
    rel = f"{folder.name}/sample.json"
    if not card_file.is_file():
        raise SampleSetError(f"{folder.name}: no sample.json")
    try:
        card = json.loads(card_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SampleSetError(f"{rel} is not valid JSON: {exc}") from exc
    missing = [f for f in FIELDS if f not in card]
    if missing:
        raise SampleSetError(f"{rel} is missing {', '.join(missing)}")
    if card["name"] != folder.name:
        raise SampleSetError(f"{rel} names '{card['name']}' but the folder is '{folder.name}'")
    pdf = folder / f"{folder.name}.pdf"
    questions = folder / "questions.json"
    for path in (pdf, questions):
        if not path.is_file():
            raise SampleSetError(f"{folder.name}: missing {path.name}")
    return Sample(**{f: card[f] for f in FIELDS}, pdf=pdf, questions_file=questions, sha=hashlib.sha256(pdf.read_bytes()).hexdigest())


@cache
def all_samples(root: Path = SAMPLES_DIR) -> list[Sample]:
    # A dotfile or underscore-prefixed folder (`.hidden`, `_scratch`) is
    # scratch space, not a sample, and should not have to look like one.
    folders = sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith((".", "_")))
    samples = [_load(f) for f in folders]
    defaults = [s.name for s in samples if s.default]
    if len(defaults) != 1:
        raise SampleSetError(f"exactly one sample must be the default, found {defaults or 'none'}")
    return sorted(samples, key=lambda s: (not s.default, s.name))


def get_sample(name: str, root: Path = SAMPLES_DIR) -> Sample:
    for s in all_samples(root):
        if s.name == name:
            return s
    raise KeyError(name)


def default_sample(root: Path = SAMPLES_DIR) -> Sample:
    return all_samples(root)[0]


def readable_shas(root: Path = SAMPLES_DIR) -> frozenset[str]:
    return frozenset(s.sha for s in all_samples(root))

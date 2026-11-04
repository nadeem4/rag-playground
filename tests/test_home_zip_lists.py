"""The home page's tour step 4 lists the files of the two zips; they must be the files Pandion writes."""

import json
import re
from pathlib import Path

import pandion

HOME = Path(__file__).resolve().parents[1] / "playground" / "frontend" / "src" / "routes" / "Home.tsx"

OFFLINE = {
    "path": "./pandion-index",
    "index": {
        "parse": {"use": "pdfium"},
        "chunk": {"use": "recursive_character", "chunk_size": 70, "chunk_overlap": 10},
        "embed": {"use": "fake-deterministic"},
        "store": {"use": "lancedb"},
    },
    "retrieve": {"search": {"use": "dense", "top_k": 3}},
    "answer": {"use": "search"},
}
SETS = {"contracts": {"questions": [{"id": "c1", "question": "Who signs?", "gold_answers": ["The buyer."]}]}}
QUESTIONS = [{"id": "q1", "question": "Who signs?", "gold_answers": ["The buyer."]}]


def listed(key: str) -> list[str]:
    block = re.search(rf"\b{key}: \[(.*?)\]", HOME.read_text(encoding="utf-8"), re.S)
    assert block, key
    return json.loads("[" + block.group(1).rstrip().rstrip(",") + "]")


def names(folder: Path, written: list[Path]) -> set[str]:
    out = set()
    for p in written:
        rel = p.relative_to(folder).as_posix()
        # The empty docs folder is shown as "docs/", as the Take it home page does.
        out.add("docs/" if rel == "docs/.gitkeep" else rel)
    return out


def test_team_zip_list_matches_the_serve_project(tmp_path):
    written = pandion.new_project(tmp_path / "p", OFFLINE, kind="serve", categories_questions=SETS)
    assert set(listed("team")) == names(tmp_path / "p", written)


def test_laptop_zip_list_matches_the_laptop_project(tmp_path):
    written = pandion.new_project(tmp_path / "p", OFFLINE, QUESTIONS)
    assert set(listed("laptop")) == names(tmp_path / "p", written)

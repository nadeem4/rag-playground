"""The own-strategies example runs, with every stage replaced, from YAML and from code.

Each script runs in its own Python process, so the strategies it registers
never reach this test process.
"""

import subprocess
import sys
from pathlib import Path

EXAMPLE = Path(__file__).resolve().parents[2] / "examples" / "pandion" / "own_strategies"


def _run(script: str, tmp_path: Path) -> str:
    out = subprocess.run([sys.executable, str(EXAMPLE / script), "--work", str(tmp_path)],
                         cwd=EXAMPLE, capture_output=True, text=True, timeout=300)
    assert out.returncode == 0, out.stderr
    return out.stdout


def test_the_yaml_pipeline_uses_a_custom_strategy_at_every_stage(tmp_path):
    out = _run("run_yaml.py", tmp_path)
    assert "strategies used: folder_of_text, markdown, drop_short, per_block, letter_counts, jsonl_store, lowercase, jsonl_search, shortest_first, bullets" in out
    assert "- " in out and "tide" in out.lower()    # the answer quotes the tides note
    assert "The pull of the Moon on the oceans causes the tides." in out


def test_custom_strategies_mix_with_built_ins_in_code(tmp_path):
    out = _run("run_mixed.py", tmp_path)
    assert "pdfium" in out and "jsonl_store" in out and "bullets" in out

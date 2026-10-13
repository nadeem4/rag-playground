"""The own-strategies example runs, with every stage replaced, from YAML and from code.

Each script runs in its own Python process, so the strategies it registers
never reach this test process.
"""

import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

EXAMPLE = Path(__file__).resolve().parents[2] / "examples" / "pandion" / "own_strategies"


def _run(args: list[str], cwd: Path) -> str:
    out = subprocess.run([sys.executable, *args], cwd=cwd, capture_output=True, text=True, timeout=300)
    assert out.returncode == 0, out.stderr
    return out.stdout


def _copy(tmp_path: Path) -> Path:
    """The example in a folder of its own, so its work/ stays out of the repo."""
    copy = tmp_path / "own_strategies"
    shutil.copytree(EXAMPLE, copy, ignore=shutil.ignore_patterns("work", "__pycache__"))
    return copy


def test_the_yaml_pipeline_uses_a_custom_strategy_at_every_stage(tmp_path):
    # Run from another folder: pipeline.yaml finds my_strategies beside itself.
    out = _run([str(_copy(tmp_path) / "run_yaml.py")], cwd=tmp_path)
    assert "strategies used: text_file, markdown, drop_short, per_block, letter_counts, jsonl_store, lowercase, jsonl_search, shortest_first, bullets" in out
    assert "- " in out and "tide" in out.lower()    # the answer quotes the tides note
    assert "The pull of the Moon on the oceans causes the tides." in out


def test_pandion_install_reads_the_example_file_from_another_folder(tmp_path):
    out = _run(["-m", "pandion.cli", "install", "--print", str(_copy(tmp_path) / "pipeline.yaml")], cwd=tmp_path)
    assert "pip install" in out


def test_custom_strategies_mix_with_built_ins_in_code(tmp_path):
    out = _run([str(EXAMPLE / "run_mixed.py"), "--work", str(tmp_path)], cwd=EXAMPLE)
    assert "pdfium" in out and "jsonl_store" in out and "bullets" in out


REFUSED = textwrap.dedent("""
    import sys
    sys.path.insert(0, sys.argv[1])
    import my_strategies
    from pandion.config import ConfigError, build

    try:
        build(path="./index", index={"parse": "markdown", "chunk": "per_block",
              "embed": "letter_counts", "store": "lancedb"}, retrieve={"search": "jsonl_search"})
    except ConfigError as exc:
        print("CONFIGERROR:", exc)
    else:
        print("NO ERROR")
""")


def test_jsonl_search_is_refused_with_the_lancedb_store(tmp_path):
    out = _run(["-c", REFUSED, str(EXAMPLE)], cwd=tmp_path)
    assert "CONFIGERROR:" in out
    assert "jsonl_search" in out and "format jsonl" in out

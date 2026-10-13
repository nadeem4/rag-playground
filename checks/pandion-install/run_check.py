"""Install the pandion wheel in a brand new environment and test it there.

Builds the wheel, makes a new virtual environment in the work folder, installs
the wheel with the pdfium and lancedb extras (no torch, no Docling), and runs
test_installed.py from a copy in that folder, so `import pandion` can only find
the installed wheel and never the repo's source.

    uv run python checks/pandion-install/run_check.py
    uv run python checks/pandion-install/run_check.py --work D:/scratch/pandion-check
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SAMPLES = [
    REPO / "samples" / "chunking-primer" / "chunking-primer.pdf",
    REPO / "samples" / "two-column-report" / "two-column-report.pdf",
]


def run(*args: str | Path, **kwargs) -> None:
    print("$", " ".join(str(a) for a in args), flush=True)
    subprocess.run([str(a) for a in args], check=True, **kwargs)


def main(work: Path) -> int:
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    dist, venv, tests = work / "dist", work / "venv", work / "tests"

    run("uv", "build", REPO / "packages" / "pandion", "--wheel", "--out-dir", dist, cwd=REPO)
    wheel = next(dist.glob("pandion-*.whl"))

    # Without these, uv and Python could pick up the repo's environment.
    env = {k: v for k, v in os.environ.items() if k not in ("VIRTUAL_ENV", "PYTHONPATH", "UV_PROJECT")}
    run("uv", "venv", venv, "--python", "3.13", "--no-project", cwd=work, env=env)
    python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    run("uv", "pip", "install", "--python", python, f"pandion[pdfium,lancedb] @ {wheel.as_uri()}", "pytest", cwd=work, env=env)

    tests.mkdir()
    shutil.copy(HERE / "test_installed.py", tests)
    (tests / "pytest.ini").write_text("[pytest]\n", encoding="utf-8")
    for pdf in SAMPLES:
        shutil.copy(pdf, tests)
    env["PANDION_CHECK_VENV"] = str(venv)
    env["PANDION_CHECK_SAMPLES"] = os.pathsep.join(str(tests / pdf.name) for pdf in SAMPLES)
    # pytest.ini makes this folder pytest's root, so the repo's settings and
    # conftest files stay out; basetemp keeps tmp_path inside the work folder.
    pytest = ["-m", "pytest", "-c", "pytest.ini", "-p", "no:cacheprovider", "--basetemp", str(work / "pytest")]
    result = subprocess.run([str(python), *pytest, "-v", "test_installed.py"], cwd=tests, env=env)
    print("The install check passed." if result.returncode == 0 else "The install check failed.")
    return result.returncode


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--work", type=Path, default=HERE / ".work", help="scratch folder, emptied first")
    sys.exit(main(parser.parse_args().work.resolve()))

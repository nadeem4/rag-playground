"""Install the pandion wheel in brand new environments and test it there.

Builds the wheel and makes two new virtual environments in the work folder: one
with the pdfium and lancedb extras (no torch, no Docling), which runs
test_installed.py, and one with the base install only, which runs
test_base_install.py. Each test file runs from a copy in the work folder, so
`import pandion` can only find the installed wheel and never the repo's source.

With --with-models, the first environment also gets the local extra (torch and
sentence-transformers) and runs test_models.py, which downloads one small model.

    uv run python checks/pandion-install/run_check.py
    uv run python checks/pandion-install/run_check.py --with-models
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


def check(work: Path, wheel: Path, name: str, extras: str, test_files: list[str]) -> int:
    """Make the environment `name` with `extras`, and run `test_files` in it."""
    venv, tests = work / name, work / f"{name}-tests"
    # Without these, uv and Python could pick up the repo's environment.
    env = {k: v for k, v in os.environ.items() if k not in ("VIRTUAL_ENV", "PYTHONPATH", "UV_PROJECT")}
    run("uv", "venv", venv, "--python", "3.13", "--no-project", cwd=work, env=env)
    python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    run("uv", "pip", "install", "--python", python, f"pandion{extras} @ {wheel.as_uri()}", "pytest", cwd=work, env=env)

    tests.mkdir()
    for test_file in test_files:
        shutil.copy(HERE / test_file, tests)
    (tests / "pytest.ini").write_text("[pytest]\n", encoding="utf-8")
    for pdf in SAMPLES:
        shutil.copy(pdf, tests)
    env["PANDION_CHECK_VENV"] = str(venv)
    env["PANDION_CHECK_SAMPLES"] = os.pathsep.join(str(tests / pdf.name) for pdf in SAMPLES)
    # pytest.ini makes this folder pytest's root, so the repo's settings and
    # conftest files stay out; basetemp keeps tmp_path inside the work folder.
    pytest = ["-m", "pytest", "-c", "pytest.ini", "-p", "no:cacheprovider", "--basetemp", str(work / f"{name}-pytest")]
    return subprocess.run([str(python), *pytest, "-v", *test_files], cwd=tests, env=env).returncode


def main(work: Path, with_models: bool) -> int:
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    dist = work / "dist"
    run("uv", "build", REPO / "packages" / "pandion", "--wheel", "--out-dir", dist, cwd=REPO)
    wheel = next(dist.glob("pandion-*.whl"))

    if with_models:
        full = ("[pdfium,lancedb,local]", ["test_installed.py", "test_models.py"])
    else:
        full = ("[pdfium,lancedb]", ["test_installed.py"])
    codes = [
        check(work, wheel, "venv", *full),
        check(work, wheel, "venv-base", "", ["test_base_install.py"]),
    ]
    ok = not any(codes)
    print("The install check passed." if ok else "The install check failed.")
    return 0 if ok else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--work", type=Path, default=HERE / ".work", help="scratch folder, emptied first")
    parser.add_argument(
        "--with-models", action="store_true", help="also install the local extra and download one small model"
    )
    args = parser.parse_args()
    sys.exit(main(args.work.resolve(), args.with_models))

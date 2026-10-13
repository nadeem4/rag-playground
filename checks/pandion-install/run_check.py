"""Install the pandion wheel in brand new environments and test it there.

Builds the wheel and makes two new virtual environments in the work folder: one
with the pdfium and lancedb extras (no torch, no Docling), which runs
test_installed.py, and one with the base install only, which runs
test_base_install.py. Each test file runs from a copy in the work folder, so
`import pandion` can only find the installed wheel and never the repo's source.
Then it copies examples/pandion/own_strategies into the work folder and runs its
run_yaml.py with the first environment's Python, so a strategy written outside
the package is proven to work against the installed wheel, and runs the
installed `pandion install --print` on its pipeline file from another folder.

With --with-models, the first environment also gets the local extra (torch and
sentence-transformers) and runs test_models.py, which downloads one small model.

With --wheel, it tests that wheel instead of building one, so the publish
workflow tests the exact file it uploads. With --tag, it first checks that the
release tag names the package's version.

    uv run python checks/pandion-install/run_check.py
    uv run python checks/pandion-install/run_check.py --with-models
    uv run python checks/pandion-install/run_check.py --work D:/scratch/pandion-check
    uv run python checks/pandion-install/run_check.py --wheel dist/pandion-0.1.0-py3-none-any.whl --tag pandion-v0.1.0
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
OWN_STRATEGIES = REPO / "examples" / "pandion" / "own_strategies"
SAMPLES = [
    REPO / "samples" / "chunking-primer" / "chunking-primer.pdf",
    REPO / "samples" / "two-column-report" / "two-column-report.pdf",
]


def package_version() -> str:
    pyproject = REPO / "packages" / "pandion" / "pyproject.toml"
    return tomllib.loads(pyproject.read_text(encoding="utf-8"))["project"]["version"]


def tag_matches(tag: str, version: str) -> bool:
    """A pandion release tag is `pandion-v` and the package's version."""
    return tag == f"pandion-v{version}"


def run(*args: str | Path, **kwargs) -> None:
    print("$", " ".join(str(a) for a in args), flush=True)
    subprocess.run([str(a) for a in args], check=True, **kwargs)


def clean_env() -> dict[str, str]:
    """The environment without the variables that could point at the repo's own."""
    return {k: v for k, v in os.environ.items() if k not in ("VIRTUAL_ENV", "PYTHONPATH", "UV_PROJECT")}


def venv_python(venv: Path) -> Path:
    return venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def check(work: Path, wheel: Path, name: str, extras: str, test_files: list[str]) -> int:
    """Make the environment `name` with `extras`, and run `test_files` in it."""
    venv, tests = work / name, work / f"{name}-tests"
    env = clean_env()
    run("uv", "venv", venv, "--python", "3.13", "--no-project", cwd=work, env=env)
    python = venv_python(venv)
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


def run_own_strategies(work: Path, venv: Path) -> int:
    """Run the own-strategies example from a copy, with the environment's
    Python, and the installed `pandion` command on its pipeline file from
    another folder, so its plugins are found beside the file."""
    example = work / "own_strategies"
    shutil.copytree(OWN_STRATEGIES, example, ignore=shutil.ignore_patterns("work", "__pycache__"))
    command = venv / ("Scripts/pandion.exe" if os.name == "nt" else "bin/pandion")
    for script in (
        [str(venv_python(venv)), str(example / "run_yaml.py")],
        [str(command), "install", "--print", str(example / "pipeline.yaml")],
    ):
        print("$", " ".join(script), flush=True)
        code = subprocess.run(script, cwd=work, env=clean_env()).returncode
        if code:
            print(f"The own-strategies example failed with exit code {code}.")
            return code
    return 0


def main(work: Path, with_models: bool, wheel: Path | None = None) -> int:
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    if wheel is None:
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
    codes.append(run_own_strategies(work, work / "venv"))
    ok = not any(codes)
    print("The install check passed." if ok else "The install check failed.")
    return 0 if ok else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--work", type=Path, default=HERE / ".work", help="scratch folder, emptied first")
    parser.add_argument(
        "--with-models", action="store_true", help="also install the local extra and download one small model"
    )
    parser.add_argument("--wheel", type=Path, help="test this wheel instead of building one")
    parser.add_argument("--tag", help="a release tag, which must be pandion-v and the package's version")
    args = parser.parse_args()
    if args.tag and not tag_matches(args.tag, package_version()):
        sys.exit(f"The tag {args.tag} does not match the package version {package_version()}.")
    sys.exit(main(args.work.resolve(), args.with_models, args.wheel and args.wheel.resolve()))

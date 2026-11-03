"""Install the pandion-api wheel in a brand new environment and test it there.

Makes a new virtual environment in the work folder, installs the pandion-api wheel
and the Pandion wheel it needs (the declared range may name a version that is not on
PyPI yet), and runs test_installed.py from a copy in the work folder, so
`import pandion_api` can only find the installed wheel and never the repo's source.

With no --wheel it builds both wheels into the work folder. With --wheel it tests
that wheel; --find-links is the folder holding the Pandion wheel (the publish
workflow passes dist/, where both were built), and with none the script builds
Pandion into the work folder. With --tag, it first checks that the release tag names
the package's version.

    uv run python checks/pandion-api-install/run_check.py
    uv run python checks/pandion-api-install/run_check.py --work D:/scratch/api-check
    uv run python checks/pandion-api-install/run_check.py --wheel dist/pandion_api-0.1.0-py3-none-any.whl --find-links dist --tag pandion-api-v0.1.0
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


def package_version() -> str:
    pyproject = REPO / "packages" / "pandion-api" / "pyproject.toml"
    return tomllib.loads(pyproject.read_text(encoding="utf-8"))["project"]["version"]


def tag_matches(tag: str, version: str) -> bool:
    """A pandion-api release tag is `pandion-api-v` and the package's version."""
    return tag == f"pandion-api-v{version}"


def run(*args: str | Path, **kwargs) -> None:
    print("$", " ".join(str(a) for a in args), flush=True)
    subprocess.run([str(a) for a in args], check=True, **kwargs)


def clean_env() -> dict[str, str]:
    """The environment without the variables that could point at the repo's own."""
    return {k: v for k, v in os.environ.items() if k not in ("VIRTUAL_ENV", "PYTHONPATH", "UV_PROJECT")}


def venv_python(venv: Path) -> Path:
    return venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def main(work: Path, wheel: Path | None = None, find_links: Path | None = None) -> int:
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    if find_links is None:
        find_links = work / "dist"
        run("uv", "build", REPO / "packages" / "pandion", "--wheel", "--out-dir", find_links, cwd=REPO)
    if wheel is None:
        run("uv", "build", REPO / "packages" / "pandion-api", "--wheel", "--out-dir", find_links, cwd=REPO)
        wheel = next(find_links.glob("pandion_api-*.whl"))

    env = clean_env()
    venv, tests = work / "venv", work / "tests"
    run("uv", "venv", venv, "--python", "3.13", "--no-project", cwd=work, env=env)
    python = venv_python(venv)
    # lancedb is the store the test pipeline names; httpx is the test client's transport.
    run(
        "uv", "pip", "install", "--python", python, "--find-links", find_links,
        f"pandion-api @ {wheel.as_uri()}", "pandion[lancedb]", "pytest", "httpx",
        cwd=work, env=env,
    )

    tests.mkdir()
    shutil.copy(HERE / "test_installed.py", tests)
    (tests / "pytest.ini").write_text("[pytest]\n", encoding="utf-8")
    pytest = ["-m", "pytest", "-c", "pytest.ini", "-p", "no:cacheprovider", "--basetemp", str(work / "pytest")]
    code = subprocess.run([str(python), *pytest, "-v", "test_installed.py"], cwd=tests, env=env).returncode
    print("The install check passed." if code == 0 else "The install check failed.")
    return 0 if code == 0 else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--work", type=Path, default=HERE / ".work", help="scratch folder, emptied first")
    parser.add_argument("--wheel", type=Path, help="test this wheel instead of building one")
    parser.add_argument("--find-links", type=Path, help="a folder holding the Pandion wheel")
    parser.add_argument("--tag", help="a release tag, which must be pandion-api-v and the package's version")
    args = parser.parse_args()
    if args.tag and not tag_matches(args.tag, package_version()):
        sys.exit(f"The tag {args.tag} does not match the package version {package_version()}.")
    sys.exit(main(args.work.resolve(), args.wheel and args.wheel.resolve(), args.find_links and args.find_links.resolve()))

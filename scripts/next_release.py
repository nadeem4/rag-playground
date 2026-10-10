"""Calculate the next release: its version and its notes. Nothing is chosen by hand.

    python scripts/next_release.py --commit <sha> [--go-to-1-0-0] [--notes notes.md]

The commits since the last release tag (vX.Y.Z) up to `--commit` decide:
- Only housekeeping (docs, chore, test, ops, ci, refactor, style, build): no
  release. It prints "Nothing user-facing since vX.Y.Z." and exits 0 with
  `release=false` in GITHUB_OUTPUT, so the Release workflow stops cleanly.
- Otherwise git-cliff calculates the version from cliff.toml (Semantic
  Versioning and Conventional Commits; before 1.0 a breaking change or a feat
  bumps the minor number) and writes the notes for exactly that range.
- `--go-to-1-0-0` is the one manual input: the day the owner calls it stable,
  the version is v1.0.0. It is refused once 1.0 is out.

In GitHub Actions it writes `release`, `version`, `previous` to GITHUB_OUTPUT.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TAG_PATTERN = "v[0-9]*.[0-9]*.[0-9]*"
USER_FACING = re.compile(r"^(feat|fix|perf)(\([^)]*\))?!?:")
BREAKING = re.compile(r"^[a-z]+(\([^)]*\))?!:")


class ReleaseError(Exception):
    """The release cannot be calculated."""


@dataclass
class Release:
    previous: str
    version: str | None  # None: nothing user-facing, so no release
    notes: str
    reason: str = ""


def user_facing(messages: list[str]) -> bool:
    """True when any commit is a feat, fix or perf, or any commit is breaking."""
    for m in messages:
        subject = m.splitlines()[0] if m else ""
        if USER_FACING.match(subject) or BREAKING.match(subject) or "BREAKING CHANGE:" in m or "BREAKING-CHANGE:" in m:
            return True
    return False


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()


def _cliff(cliff: str, repo: Path, *args: str) -> str:
    return subprocess.run([cliff, "--config", str(repo / "cliff.toml"), *args], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()


def find_cliff() -> str:
    exe = Path(sys.executable).parent / ("git-cliff.exe" if sys.platform == "win32" else "git-cliff")
    found = str(exe) if exe.exists() else shutil.which("git-cliff")
    if not found:
        raise ReleaseError("git-cliff is not installed. Install the dev extras: uv sync --extra dev.")
    return found


def next_release(commit: str, *, go_to_1_0_0: bool = False, repo: Path = ROOT, cliff: str | None = None) -> Release:
    cliff = cliff or find_cliff()
    try:
        previous = _git(repo, "describe", "--tags", "--abbrev=0", "--match", TAG_PATTERN, commit)
    except subprocess.CalledProcessError as exc:
        raise ReleaseError(f"No release tag (vX.Y.Z) before {commit}.") from exc
    span = f"{previous}..{commit}"
    messages = [m.strip() for m in _git(repo, "log", "--format=%B%x00", span).split("\x00") if m.strip()]
    if go_to_1_0_0:
        if int(previous.lstrip("v").split(".")[0]) >= 1:
            raise ReleaseError(f"Version 1.0 is already out ({previous}). Leave go_to_1_0_0 off.")
        version = "v1.0.0"
    elif not user_facing(messages):
        return Release(previous, None, "", f"Nothing user-facing since {previous}.")
    else:
        version = _cliff(cliff, repo, span, "--bumped-version")
    notes = _cliff(cliff, repo, span, "--tag", version, "--strip", "all")
    return Release(previous, version, notes)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--commit", required=True, help="the commit to release (the one on staging)")
    parser.add_argument("--go-to-1-0-0", action="store_true", help="release v1.0.0")
    parser.add_argument("--notes", default="", help="write the release notes to this file")
    args = parser.parse_args()
    try:
        r = next_release(args.commit, go_to_1_0_0=args.go_to_1_0_0)
    except (ReleaseError, subprocess.CalledProcessError) as exc:
        print(f"Release: {exc}", file=sys.stderr)
        sys.exit(1)
    out = os.environ.get("GITHUB_OUTPUT")
    lines = [f"release={'true' if r.version else 'false'}", f"previous={r.previous}", f"version={r.version or ''}"]
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    if args.notes:
        Path(args.notes).write_text(r.notes + "\n", encoding="utf-8")
    print(r.reason if not r.version else f"{r.previous} -> {r.version}")


if __name__ == "__main__":
    main()

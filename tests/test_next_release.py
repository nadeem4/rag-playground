"""The next release version is calculated, never chosen (cliff.toml, scripts/next_release.py).

The unit tests cover the "anything user-facing?" rule. The git tests build a
throwaway repository and run the real git-cliff with the project's cliff.toml,
so the version rules are pinned as they will run in the Release workflow.
"""

import importlib.util
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("next_release", ROOT / "scripts" / "next_release.py")
nr = importlib.util.module_from_spec(_spec)
sys.modules["next_release"] = nr  # a dataclass needs its module registered
_spec.loader.exec_module(nr)


@pytest.mark.parametrize(
    "messages",
    [
        ["feat: a new page"],
        ["fix(evaluate): the score"],
        ["perf: faster parse"],
        ["refactor!: drop the old route"],
        ["chore: tidy\n\nBREAKING CHANGE: the config file moved"],
        ["docs: guide", "fix: a typo in the app"],
    ],
)
def test_user_facing_changes_make_a_release(messages):
    assert nr.user_facing(messages)


@pytest.mark.parametrize(
    "messages",
    [
        [],
        ["docs: the guide"],
        ["chore: version 0.33.0", "test: more", "ops: staging", "ci: cache", "refactor: tidy", "style: format", "build: deps"],
        ["Merge branch 'main'"],
    ],
)
def test_housekeeping_alone_makes_no_release(messages):
    assert not nr.user_facing(messages)


# --------------------------------------------------------------- with git --


def _cliff() -> str | None:
    exe = Path(sys.executable).parent / ("git-cliff.exe" if sys.platform == "win32" else "git-cliff")
    return str(exe) if exe.exists() else shutil.which("git-cliff")


needs_cliff = pytest.mark.skipif(_cliff() is None, reason="git-cliff is not installed (uv sync --extra dev)")


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    _git(tmp_path, "init", "-q", "-b", "main")
    _git(tmp_path, "config", "user.email", "test@example.com")
    _git(tmp_path, "config", "user.name", "Test")
    shutil.copy(ROOT / "cliff.toml", tmp_path / "cliff.toml")
    return tmp_path


def commit(repo: Path, message: str) -> str:
    (repo / "f.txt").write_text(message, encoding="utf-8")
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", message)
    return _git(repo, "rev-parse", "HEAD")


def release(repo: Path, tag: str, *messages: str, go_to_1_0_0: bool = False) -> nr.Release:
    commit(repo, "chore: start")
    _git(repo, "tag", tag)
    head = ""
    for m in messages:
        head = commit(repo, m)
    return nr.next_release(head, go_to_1_0_0=go_to_1_0_0, repo=repo, cliff=_cliff())


@needs_cliff
@pytest.mark.parametrize(
    ("tag", "messages", "expected"),
    [
        ("v0.32.1", ["fix: a"], "v0.32.2"),
        ("v0.32.1", ["perf: b", "docs: c"], "v0.32.2"),
        ("v0.32.1", ["fix: a", "feat: b"], "v0.33.0"),
        ("v0.32.1", ["feat!: breaking"], "v0.33.0"),
        ("v0.32.1", ["fix: a\n\nBREAKING CHANGE: moved"], "v0.33.0"),
        ("v1.2.3", ["fix: a"], "v1.2.4"),
        ("v1.2.3", ["feat: a"], "v1.3.0"),
        ("v1.2.3", ["feat!: breaking"], "v2.0.0"),
    ],
)
def test_git_cliff_calculates_the_version(repo, tag, messages, expected):
    r = release(repo, tag, *messages)
    assert r.previous == tag
    assert r.version == expected


@needs_cliff
def test_housekeeping_alone_stops_with_nothing_user_facing(repo):
    r = release(repo, "v0.32.1", "docs: guide", "chore: tidy", "ops: staging")
    assert r.version is None
    assert r.reason == "Nothing user-facing since v0.32.1."


@needs_cliff
def test_go_to_1_0_0_is_the_one_manual_choice(repo):
    r = release(repo, "v0.40.2", "fix: a", go_to_1_0_0=True)
    assert r.version == "v1.0.0"


@needs_cliff
def test_go_to_1_0_0_is_refused_after_1_0(repo):
    with pytest.raises(nr.ReleaseError, match="already"):
        release(repo, "v1.0.0", "fix: a", go_to_1_0_0=True)


@needs_cliff
def test_the_notes_list_user_facing_changes_only(repo):
    r = release(repo, "v0.32.1", "feat: the miss trace", "fix: the score", "docs: the guide")
    assert "The miss trace" in r.notes
    assert "The score" in r.notes
    assert "guide" not in r.notes

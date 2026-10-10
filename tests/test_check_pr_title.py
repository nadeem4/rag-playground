"""Pull request titles are Conventional Commits, because a squash merge makes the title the commit."""

import importlib.util
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location(
    "check_pr_title", Path(__file__).resolve().parents[1] / "scripts" / "check_pr_title.py"
)
ct = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ct)


@pytest.mark.parametrize(
    "title",
    [
        "feat: Why did this miss? on Evaluate",
        "fix(evaluate): the score uses the shared matching rule",
        "perf: cache the parse",
        "feat!: drop the old question format",
        "refactor(api)!: rename the health route",
        "docs: the release flow",
        "chore: tidy",
        "test: more cases",
        "ops: staging",
        "ci: cache the models",
        "style: format",
        "build: pin git-cliff",
    ],
)
def test_conventional_titles_pass(title):
    assert ct.problem(title) is None


@pytest.mark.parametrize(
    ("title", "says"),
    [
        ("Add the miss trace", "type"),
        ("feature: a page", "type"),
        ("feat:no space", "description"),
        ("feat: ", "description"),
        ("feat(): empty scope", "scope"),
        ("Feat: capital type", "type"),
        ("", "type"),
    ],
)
def test_other_titles_fail_and_say_why(title, says):
    message = ct.problem(title)
    assert message is not None and says in message
